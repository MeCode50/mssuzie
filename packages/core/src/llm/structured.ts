import type { z } from "zod";

export interface LlmRequest {
  name: string;
  instructions: string;
  model: string;
  input: string;
  maxTokens: number;
  schema: z.ZodObject;
}

export interface LlmRawResult {
  raw: unknown;
  tokensIn: number;
  tokensOut: number;
}

/** The only seam to a model provider: swapped for a fake in tests and for the MOCK_LLM mode. */
export type LlmExecutor = (request: LlmRequest) => Promise<LlmRawResult>;

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  attempts: number;
}

export interface StructuredResult<T> {
  output: T;
  usage: LlmUsage;
}

export class StructuredOutputError extends Error {
  constructor(
    readonly agent: string,
    readonly validationError: string,
    readonly usage: LlmUsage,
  ) {
    super(`${agent}: model output failed validation after retry: ${validationError}`);
    this.name = "StructuredOutputError";
  }
}

function describeFailure(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err) {
    return JSON.stringify((err as { issues: unknown }).issues).slice(0, 1500);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 1500);
}

/**
 * Call a model, validate the output with zod, and retry exactly once with the validation error
 * appended. Token counts and duration are summed across attempts. Transport/API errors are not
 * retried here (they propagate); only invalid output is.
 */
export async function runStructured<S extends z.ZodObject>(
  execute: LlmExecutor,
  request: LlmRequest & {
    schema: S;
    /** Semantic validation beyond the schema. Return a problem description to trigger the retry. */
    check?: (output: z.infer<S>) => string | null;
  },
): Promise<StructuredResult<z.infer<S>>> {
  const started = Date.now();
  const usage: LlmUsage = { model: request.model, tokensIn: 0, tokensOut: 0, durationMs: 0, attempts: 0 };
  let input = request.input;
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    usage.attempts = attempt;
    try {
      const result = await execute({ ...request, input });
      usage.tokensIn += result.tokensIn;
      usage.tokensOut += result.tokensOut;
      const parsed = request.schema.safeParse(result.raw);
      if (parsed.success) {
        const problem = request.check?.(parsed.data) ?? null;
        if (problem === null) {
          usage.durationMs = Date.now() - started;
          return { output: parsed.data, usage };
        }
        lastError = problem;
      } else {
        lastError = describeFailure(parsed.error);
      }
    } catch (err) {
      if (!isOutputValidationError(err)) throw err;
      lastError = describeFailure(err);
    }
    input =
      `${request.input}\n\nYour previous answer was rejected by validation: ${lastError}\n` +
      "Return a corrected answer that matches the required output schema exactly.";
  }
  usage.durationMs = Date.now() - started;
  throw new StructuredOutputError(request.name, lastError, usage);
}

/** The Agents SDK throws ModelBehaviorError / output-parse errors when the model returns bad JSON. */
function isOutputValidationError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "ModelBehaviorError" || name === "ZodError";
}
