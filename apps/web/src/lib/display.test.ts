import { describe, expect, it } from "vitest";
import { humanize, humanizeTokens } from "./display";

describe("humanizeTokens", () => {
  it("turns placeholders into plain words and leaves ordinary text alone", () => {
    expect(humanizeTokens("[CHILD_1] sat with [TUTOR_1] at [SCHOOL_2] in [CITY_1]; [GUARDIAN_1] agreed."))
      .toBe("the learner sat with the tutor at their school in their town; their parent agreed.");
    expect(humanizeTokens("Scored [14/20] on arrays[0]")).toBe("Scored [14/20] on arrays[0]");
  });
  it("uses a neutral word for categories with no friendly name", () => {
    expect(humanizeTokens("Met [PERSON_1] and [EMAIL_3]")).toBe("Met someone and someone");
  });
});

describe("humanize (deep)", () => {
  it("maps every string in nested values, keeping other types intact", () => {
    const date = new Date(0);
    const out = humanize({ a: "[CHILD_1] won", list: ["[GUARDIAN_1]", 3, null], nested: { when: date, ok: true } });
    expect(out).toEqual({ a: "the learner won", list: ["their parent", 3, null], nested: { when: date, ok: true } });
    expect(humanize(null)).toBeNull();
  });
});
