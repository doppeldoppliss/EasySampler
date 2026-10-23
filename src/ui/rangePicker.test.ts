import { describe, expect, it } from "vitest";
import { clock } from "./rangePicker";

describe("clock", () => {
  it("formats minutes and seconds, with a tenth only when needed", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(5)).toBe("0:05");
    expect(clock(65.5)).toBe("1:05.5");
    expect(clock(600)).toBe("10:00");
    expect(clock(59.94)).toBe("0:59.9");
  });
});
