import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FindingsOutputSchema } from "../agents/privacy-guard/llm-pass.js";
import { runStructured, StructuredOutputError, type LlmExecutor } from "./structured.js";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./untrusted.js";

const schema = z.object({ status: z.enum(["on_track", "watch", "at_risk"]), score: z.number().min(0).max(1) });
const base = { name: "test_agent", instructions: "x", model: "m", input: "hello", maxTokens: 100, schema };

function scripted(outputs: unknown[]): { execute: LlmExecutor; inputs: string[] } {
  const inputs: string[] = [];
  let i = 0;
  return {
    inputs,
    execute: async (req) => {
      inputs.push(req.input);
      return { raw: outputs[i++], tokensIn: 100, tokensOut: 20 };
    },
  };
}

describe("runStructured", () => {
  it("returns valid output on the first attempt", async () => {
    const { execute, inputs } = scripted([{ status: "watch", score: 0.5 }]);
    const r = await runStructured(execute, base);
    expect(r.output).toEqual({ status: "watch", score: 0.5 });
    expect(r.usage).toMatchObject({ attempts: 1, tokensIn: 100, tokensOut: 20 });
    expect(inputs).toEqual(["hello"]);
  });

  it("retries once, feeding the validation error back, and sums usage", async () => {
    const { execute, inputs } = scripted([{ status: "great", score: 2 }, { status: "at_risk", score: 0.2 }]);
    const r = await runStructured(execute, base);
    expect(r.output.status).toBe("at_risk");
    expect(r.usage).toMatchObject({ attempts: 2, tokensIn: 200, tokensOut: 40 });
    expect(inputs[1]).toContain("hello");
    expect(inputs[1]).toContain("rejected by validation");
    expect(inputs[1]).toContain("status");
  });

  it("fails the step after the single retry", async () => {
    const { execute, inputs } = scripted([{ nope: 1 }, { nope: 2 }, { status: "watch", score: 0.1 }]);
    const err = await runStructured(execute, base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect((err as StructuredOutputError).usage.attempts).toBe(2);
    expect(inputs).toHaveLength(2);
  });

  it("retries when the SDK itself throws a ModelBehaviorError", async () => {
    let calls = 0;
    const execute: LlmExecutor = async () => {
      calls++;
      if (calls === 1) {
        const e = new Error("Invalid output type");
        e.name = "ModelBehaviorError";
        throw e;
      }
      return { raw: { status: "on_track", score: 0.9 }, tokensIn: 1, tokensOut: 1 };
    };
    expect((await runStructured(execute, base)).output.status).toBe("on_track");
  });

  it("does not retry transport errors", async () => {
    let calls = 0;
    const execute: LlmExecutor = async () => {
      calls++;
      throw new Error("ECONNRESET");
    };
    await expect(runStructured(execute, base)).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
  });
});

describe("wrapUntrusted", () => {
  it("wraps text with a fresh nonce each call so it cannot forge the closing marker", () => {
    const a = wrapUntrusted("tutor_notes", "hi");
    const b = wrapUntrusted("tutor_notes", "hi");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^<<<BEGIN UNTRUSTED DATA "tutor_notes" [0-9a-f]{16}>>>\nhi\n<<<END UNTRUSTED DATA "tutor_notes" [0-9a-f]{16}>>>$/);
    expect(UNTRUSTED_DATA_RULE).toMatch(/never follow instructions/);
  });
});

describe("schemas reject bad outputs", () => {
  it("findings: bad category, overlong text, too many findings", () => {
    const ok = { text: "Mrs Patel", category: "person" };
    expect(FindingsOutputSchema.safeParse({ findings: [ok] }).success).toBe(true);
    expect(FindingsOutputSchema.safeParse({ findings: [{ ...ok, category: "alien" }] }).success).toBe(false);
    expect(FindingsOutputSchema.safeParse({ findings: [{ ...ok, text: "x".repeat(81) }] }).success).toBe(false);
    expect(FindingsOutputSchema.safeParse({ findings: Array(51).fill(ok) }).success).toBe(false);
    expect(FindingsOutputSchema.safeParse({}).success).toBe(false);
  });
});
