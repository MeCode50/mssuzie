import { Agent, ModelBehaviorError, OpenAIChatCompletionsModel, Runner } from "@openai/agents";
import { billed, createLlmClient, newLedger, toServiceError, wireSchema, type ChatExecutorOptions, type LlmClientHandle } from "./client";
import type { LlmExecutor } from "./structured";

export { REASONING_EFFORTS, type ChatExecutorOptions, type ReasoningEffort } from "./client";

/**
 * Executor on the OpenAI Agents SDK over Chat Completions, for agents WITHOUT tools: a single turn
 * with a strict JSON-schema answer that our own code validates and retries. SDK tracing is off so
 * tutor notes never reach a trace store. Usage is metered at the HTTP layer (see client.ts).
 */
export function createChatCompletionsExecutor(options: ChatExecutorOptions, handle: LlmClientHandle = createLlmClient(options)): LlmExecutor {
  const { client, throttle, ledgers } = handle;
  const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });
  return async (req) => {
    const agent = new Agent({
      name: req.name,
      instructions: req.instructions,
      model: new OpenAIChatCompletionsModel(client, req.model),
      // A plain JSON schema (not the zod object): the answer is validated by OUR code, which
      // owns the retry, so the SDK is only the transport.
      outputType: { type: "json_schema", name: req.name, strict: true, schema: wireSchema(req.schema) as never },
      modelSettings: {
        maxTokens: req.maxTokens + options.reasoningTokenHeadroom,
        temperature: 0,
        reasoning: { effort: options.reasoningEffort },
      },
    });
    const ledger = newLedger();
    try {
      const result = await throttle.withSlot(() => ledgers.run(ledger, () => runner.run(agent, req.input, { maxTurns: 1 })));
      return { raw: parseJson(result.finalOutput), ...billed(ledger) };
    } catch (err) {
      // Unparseable text from the model: the tokens were spent, so report it as an invalid answer
      // (validated and retried by runStructured) rather than losing the cost.
      if (!(err instanceof ModelBehaviorError)) throw toServiceError(err);
      return { raw: `Invalid structured output: ${err.message}`, ...billed(ledger) };
    }
  };
}

/** Text that is not valid JSON is passed through as-is so schema validation rejects it and retries. */
function parseJson(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

