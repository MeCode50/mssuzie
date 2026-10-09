import type { DetectionResult, Finding, PiiDetector } from "./llm-pass.js";
import type { KnownEntities } from "./types.js";

export const usage = { model: "test-small", tokensIn: 10, tokensOut: 5, durationMs: 1, attempts: 1 };

export const amaraKnown: KnownEntities = {
  learnerName: "Amara Okafor",
  guardianNames: ["Ngozi Okafor"],
  guardianEmails: ["ngozi.okafor@example.com"],
  guardianPhones: ["+44 7700 900101"],
  tutorName: "Daniel Reyes",
  schools: ["Oakfield Academy"],
  cities: ["Leeds"],
};

export const noFindings: PiiDetector = async () => ({ findings: [], usage });

export function detectorReturning(findings: Finding[]): PiiDetector {
  return async (): Promise<DetectionResult> => ({ findings, usage });
}

/** A detector that records exactly what a model would have been sent. */
export function spyDetector(findings: Finding[] = []): { detector: PiiDetector; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    detector: async (text) => {
      seen.push(text);
      return { findings, usage };
    },
  };
}
