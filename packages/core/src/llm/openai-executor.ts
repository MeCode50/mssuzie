import { Agent, OpenAIProvider, Runner } from "@openai/agents";
import type { LlmExecutor } from "./structured.js";

/**
 * Real executor on the OpenAI Agents SDK. Agents have no tools, run for a single turn, and
 * SDK tracing is disabled so tutor notes never reach a trace store.
 */
export function createOpenAiExecutor(apiKey: string): LlmExecutor {
  const runner = new Runner({
    modelProvider: new OpenAIProvider({ apiKey }),
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });

  return async (req) => {
    const agent = new Agent({
      name: req.name,
      instructions: req.instructions,
      model: req.model,
      outputType: req.schema,
      modelSettings: { maxTokens: req.maxTokens, temperature: 0 },
    });
    const result = await runner.run(agent, req.input, { maxTurns: 1 });
    const { inputTokens, outputTokens } = result.state.usage;
    return { raw: result.finalOutput, tokensIn: inputTokens, tokensOut: outputTokens };
  };
}
