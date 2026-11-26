import { describe, expect, it } from "vitest";
import { PUNCH_DB, punchAttack } from "./autoMix";

describe("キックの芯を残す", () => {
  it("takes the least attack that reaches the punch", () => {
    expect(punchAttack([{ attackDb: 0, punchDb: 6.9 }, { attackDb: 2, punchDb: 7.5 }, { attackDb: 3.5, punchDb: 8.0 }, { attackDb: 5, punchDb: 8.6 }])).toBe(3.5);
  });
  it("puts none in a mix with the punch already, or where it would not help", () => {
    expect(punchAttack([{ attackDb: 0, punchDb: PUNCH_DB + 0.1 }, { attackDb: 2, punchDb: 9 }])).toBe(0);
    expect(punchAttack([{ attackDb: 0, punchDb: 6 }, { attackDb: 2, punchDb: 6.1 }, { attackDb: 5, punchDb: 6.3 }])).toBe(0);
    expect(punchAttack([{ attackDb: 0, punchDb: NaN }, { attackDb: 2, punchDb: 9 }])).toBe(0);
  });
  it("takes the most when none reaches it but it helps", () => {
    expect(punchAttack([{ attackDb: 5, punchDb: 7.4 }, { attackDb: 0, punchDb: 6 }, { attackDb: 2, punchDb: 6.6 }])).toBe(5);
  });
});
