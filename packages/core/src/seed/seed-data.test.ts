import { describe, expect, it } from "vitest";
import { parseSeedEnv, SEED_LEARNERS } from "./index";

describe("seed data", () => {
  it("has 5 learners aged 7-15 with plans of 2, 3 and 4 hours", () => {
    expect(SEED_LEARNERS).toHaveLength(5);
    for (const l of SEED_LEARNERS) {
      expect(l.age).toBeGreaterThanOrEqual(7);
      expect(l.age).toBeLessThanOrEqual(15);
    }
    expect(new Set(SEED_LEARNERS.map((l) => l.planHoursPerWeek))).toEqual(new Set([2, 3, 4]));
  });

  it("has 4-6 past sessions per learner, oldest first", () => {
    for (const l of SEED_LEARNERS) {
      expect(l.sessions.length).toBeGreaterThanOrEqual(4);
      expect(l.sessions.length).toBeLessThanOrEqual(6);
      const days = l.sessions.map((s) => s.daysAgo);
      expect(days).toEqual([...days].sort((a, b) => b - a));
      for (const s of l.sessions) {
        expect(s.notes.length).toBeGreaterThan(200);
        expect(s.notes.length).toBeLessThanOrEqual(8000);
        for (const k of s.skills) {
          expect(k.mastery).toBeGreaterThanOrEqual(0);
          expect(k.mastery).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("has exactly one at_risk learner (with an alert) and an improving one", () => {
    const atRisk = SEED_LEARNERS.filter((l) => l.status === "at_risk");
    expect(atRisk).toHaveLength(1);
    expect(atRisk[0]?.alert).toBeDefined();
    const amara = SEED_LEARNERS.find((l) => l.displayName === "Amara Okafor");
    const first = amara?.sessions[0]?.skills[0]?.mastery ?? 1;
    const last = amara?.sessions.at(-1)?.skills.at(-1)?.mastery ?? 0;
    expect(last - first).toBeGreaterThan(0.4);
  });

  it("gives every learner upcoming exams or assignments and a guardian", () => {
    for (const l of SEED_LEARNERS) {
      expect(l.events.length).toBeGreaterThan(0);
      expect(l.events.every((e) => e.inDays > 0)).toBe(true);
      expect(l.guardian.email).toMatch(/@example\.com$/);
    }
  });

  it("requires seed credentials from the environment", () => {
    expect(() => parseSeedEnv({})).toThrow(/SEED_EBUN_EMAIL/);
    expect(() =>
      parseSeedEnv({ SEED_EBUN_EMAIL: "a@b.co", SEED_EBUN_PASSWORD: "short" }),
    ).toThrow(/at least 12/);
  });
});
