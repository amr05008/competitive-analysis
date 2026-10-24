import { describe, expect, it } from "vitest";
import { Budget } from "../../src/shared/budget";

describe("Budget", () => {
  it("allows maxFetches then refuses", () => {
    const b = new Budget(2, 1000, () => 0);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    expect(b.used).toBe(2);
    expect(b.exhausted).toBe(true);
  });
  it("counts the duration from construction", () => {
    let t = 5000;
    const b = new Budget(5, 100, () => t);
    expect(b.take()).toBe(true);
    t = 5100;
    expect(b.take()).toBe(true);
    t = 5101;
    expect(b.take()).toBe(false);
    expect(b.exhausted).toBe(true);
  });
});
