import type OpenAI from "openai";
import { z } from "zod";
import { billed, createLlmClient, newLedger, toServiceError, wireSchema, type LlmClientHandle } from "./client";
import { findServiceError, LlmServiceError } from "./errors";

/**
 * Agents that act through tools. The model never writes anything itself: it asks for tool calls, our
 * code validates every argument, scopes and runs them, and only then tells the model what happened.
 */

export interface ToolDef {
  name: string;
  description: string;
  /** Validated before the tool runs; strict so unexpected arguments are rejected. */
  parameters: z.ZodObject;
  /** Receives validated input only. */
  execute(input: never): Promise<unknown>;
}

export type ToolEventStatus = "running" | "completed" | "failed";

/** One tool call as it happens (the live trace shows these nested under the agent). */
export interface ToolEvent {
  callId: string;
  tool: string;
  status: ToolEventStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface FinalTool {
  name: string;
  description: string;
  schema: z.ZodObject;
}

export interface ToolAgentRequest {
  name: string;
  instructions: string;
  model: string;
  input: string;
  maxTokens: number;
  tools: ToolDef[];
  /** The agent finishes by calling this tool; its arguments are the agent's structured result. */
  final: FinalTool;
  /** Semantic check on the final result; return a problem to send it back to the model. */
  validate?: (output: never) => string | null;
  maxTurns?: number;
  onToolEvent?: (event: ToolEvent) => void | Promise<void>;
}

export interface ToolAgentRaw {
  output: unknown;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  toolCalls: number;
}

/** The only seam to a model for tool-using agents: swapped for a scripted fake in tests and MOCK_LLM. */
export type ToolAgentExecutor = (request: ToolAgentRequest) => Promise<ToolAgentRaw>;

export class ToolLoopError extends Error {
  constructor(message: string, readonly tokensIn = 0, readonly tokensOut = 0) {
    super(message);
    this.name = "ToolLoopError";
  }
}

const MAX_RESULT_CHARS = 12_000;
const DEFAULT_TURNS = 6;

let counter = 0;
const nextCallId = () => `call_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** Validate and run one tool call; always resolves, reporting failures to the model as data. */
export async function invokeTool(
  req: Pick<ToolAgentRequest, "tools" | "onToolEvent">,
  name: string,
  rawArguments: string | unknown,
): Promise<{ content: string; ok: boolean }> {
  const callId = nextCallId();
  const started = Date.now();
  const emit = async (e: Omit<ToolEvent, "callId" | "tool" | "durationMs">) => {
    await req.onToolEvent?.({ callId, tool: name, durationMs: Date.now() - started, ...e });
  };
  const tool = req.tools.find((t) => t.name === name);
  if (!tool) {
    const error = `There is no tool called "${name}". Available tools: ${req.tools.map((t) => t.name).join(", ")}.`;
    await emit({ status: "failed", error });
    return { ok: false, content: JSON.stringify({ error }) };
  }

  let parsedJson: unknown;
  try {
    parsedJson = typeof rawArguments === "string" ? JSON.parse(rawArguments === "" ? "{}" : rawArguments) : rawArguments;
  } catch {
    const error = "The arguments were not valid JSON.";
    await emit({ status: "failed", error });
    return { ok: false, content: JSON.stringify({ error }) };
  }
  const parsed = tool.parameters.strict().safeParse(parsedJson);
  if (!parsed.success) {
    const error = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`;
    await emit({ status: "failed", input: parsedJson, error });
    return { ok: false, content: JSON.stringify({ error }) };
  }

  await emit({ status: "running", input: parsed.data });
  try {
    const output = await tool.execute(parsed.data as never);
    let content = JSON.stringify(output ?? null);
    if (content.length > MAX_RESULT_CHARS) content = JSON.stringify({ error: "The result was too large. Ask for a narrower range." });
    await emit({ status: "completed", input: parsed.data, output });
    return { ok: true, content };
  } catch (err) {
    const error = err instanceof Error ? err.message : "The tool failed.";
    await emit({ status: "failed", input: parsed.data, error });
    return { ok: false, content: JSON.stringify({ error }) };
  }
}

/** Check a final-answer call: schema first, then the agent's semantic check. */
export function acceptFinal(
  req: Pick<ToolAgentRequest, "final" | "validate">,
  rawArguments: string | unknown,
): { ok: true; output: unknown } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = typeof rawArguments === "string" ? JSON.parse(rawArguments === "" ? "{}" : rawArguments) : rawArguments;
  } catch {
    return { ok: false, error: "The final answer was not valid JSON." };
  }
  const parsed = req.final.schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `The final answer was invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}` };
  }
  const problem = req.validate?.(parsed.data as never) ?? null;
  return problem === null ? { ok: true, output: parsed.data } : { ok: false, error: problem };
}

type Message = OpenAI.Chat.ChatCompletionMessageParam;

const openAiTool = (name: string, description: string, schema: z.ZodObject): OpenAI.Chat.ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: wireSchema(schema) },
});

/**
 * Rebuild the assistant's turn for the next request. Gemini 3 checks that each function call comes
 * back with its `thought_signature` (carried in extra_content), so provider extras are kept verbatim.
 */
function echoAssistant(message: OpenAI.Chat.ChatCompletionMessage): Message {
  const raw = message as unknown as { content: string | null; tool_calls?: { id: string; type: string; function: unknown; extra_content?: unknown }[]; extra_content?: unknown };
  return {
    role: "assistant",
    content: raw.content ?? null,
    ...(raw.extra_content ? { extra_content: raw.extra_content } : {}),
    ...(raw.tool_calls?.length
      ? { tool_calls: raw.tool_calls.map((tc) => ({ id: tc.id, type: "function", function: tc.function, ...(tc.extra_content ? { extra_content: tc.extra_content } : {}) })) }
      : {}),
  } as unknown as Message;
}

/** Real executor: a plain Chat Completions loop with function calling. */
export function createToolLoopExecutor(handle: LlmClientHandle): ToolAgentExecutor {
  const { client, throttle, ledgers, options } = handle;

  return async (req) => {
    const ledger = newLedger();
    const messages: Message[] = [
      { role: "system", content: req.instructions },
      { role: "user", content: req.input },
    ];
    const tools = [...req.tools.map((t) => openAiTool(t.name, t.description, t.parameters)), openAiTool(req.final.name, req.final.description, req.final.schema)];
    const maxTurns = req.maxTurns ?? DEFAULT_TURNS;
    let toolChoice: "required" | "auto" = "required";
    let toolCalls = 0;

    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const response = await throttle.withSlot(() =>
          ledgers.run(ledger, () =>
            client.chat.completions
              .create({
                model: req.model, messages, tools, tool_choice: toolChoice, temperature: 0,
                max_tokens: req.maxTokens + options.reasoningTokenHeadroom,
                reasoning_effort: options.reasoningEffort,
              } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)
              .catch((err: unknown) => {
                const known = toServiceError(err);
                // Some providers reject tool_choice "required"; fall back to "auto" once and carry on.
                if (toolChoice === "required" && known instanceof LlmServiceError && known.kind === "bad_request" && known.status === 400) {
                  toolChoice = "auto";
                  return null;
                }
                throw known;
              }),
          ),
        );
        if (response === null) {
          turn -= 1;
          continue;
        }

        const message = response.choices[0]?.message;
        if (!message) throw new ToolLoopError("The model returned no answer.");
        messages.push(echoAssistant(message));

        const calls = message.tool_calls ?? [];
        if (calls.length === 0) {
          messages.push({ role: "user", content: `Use the tools to check, then finish by calling ${req.final.name}. Reply only with tool calls.` });
          continue;
        }

        // Data tools first (so their results are in the trace), then the final answer if it was called.
        let finalAttempt: { id: string; args: string } | null = null;
        for (const call of calls) {
          if (call.type !== "function") continue;
          if (call.function.name === req.final.name) {
            finalAttempt = { id: call.id, args: call.function.arguments };
            continue;
          }
          toolCalls += 1;
          const result = await invokeTool(req, call.function.name, call.function.arguments);
          messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
        }
        if (finalAttempt) {
          const accepted = acceptFinal(req, finalAttempt.args);
          if (accepted.ok) return { output: accepted.output, ...billed(ledger), turns: turn, toolCalls };
          messages.push({ role: "tool", tool_call_id: finalAttempt.id, content: JSON.stringify({ error: accepted.error }) });
        }
      }
      throw new ToolLoopError(`The agent did not finish within ${maxTurns} steps.`, ...Object.values(billed(ledger)) as [number, number]);
    } catch (err) {
      if (err instanceof ToolLoopError) throw err;
      const service = findServiceError(err) ?? toServiceError(err);
      const b = billed(ledger);
      (service as Error & { usage?: { tokensIn: number; tokensOut: number } }).usage = { tokensIn: b.tokensIn, tokensOut: b.tokensOut };
      throw service;
    }
  };
}

export { createLlmClient };
