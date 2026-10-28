import { describe, expect, it } from "vitest";
import { applyExpression } from "./rollPanel";

describe("一括変更 expressions", () => {
  it("sets, multiplies, divides, adds and subtracts; empty leaves the value; nonsense is NaN", () => {
    expect(applyExpression("0.5", 2)).toBe(0.5);
    expect(applyExpression("*2", 1.5)).toBe(3);
    expect(applyExpression("/2", 3)).toBe(1.5);
    expect(applyExpression("+10", 100)).toBe(110);
    expect(applyExpression("-10", 100)).toBe(90);
    expect(applyExpression("＊0.8", 100)).toBeCloseTo(80);
    expect(applyExpression(" ", 7)).toBeNull();
    expect(applyExpression("abc", 7)).toBeNaN();
    expect(applyExpression("/0", 7)).toBeNaN();
  });
});
