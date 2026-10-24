import { describe, expect, it } from "vitest";
import { errorResult } from "../../src/contract/envelope";
import type { SecResult } from "../../src/contract/tools";
import { capText, MORE_LINE, render } from "../../src/tools";

describe("render", () => {
  it("cuts a one-line JSON rendering mid-line to 4000 characters", () => {
    const big: SecResult = {
      status: "ok",
      notes: Array.from({ length: 300 }, (_, i) => `note ${i} `.padEnd(40, "x")),
      retrieved_at: "2026-10-20",
    };
    const text = render("sec_filings", big);
    expect(JSON.stringify(big).length).toBeGreaterThan(4000);
    expect(text.length).toBe(4000);
    expect(text.endsWith(`\n${MORE_LINE}`)).toBe(true);
    expect(JSON.stringify(big).startsWith(text.slice(0, -MORE_LINE.length - 1))).toBe(true);
  });

  it("leaves a short rendering unchanged", () => {
    const small = errorResult("bad_input", "IP addresses are not accepted", [], Date.UTC(2026, 9, 20));
    expect(render("sec_filings", small)).toBe(JSON.stringify(small));
  });

  it("keeps whole lines when it can", () => {
    const [a, b, c] = ["a", "b", "c"].map((ch) => ch.repeat(20));
    const max = a.length + 1 + MORE_LINE.length + 5;
    expect(capText(`${a}\n${b}\n${c}`, max)).toBe(`${a}\n${MORE_LINE}`);
    expect(capText("abc", 3)).toBe("abc");
  });
});
