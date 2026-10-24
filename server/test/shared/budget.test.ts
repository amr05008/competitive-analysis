import { describe, expect, it } from "vitest";
import { TOOL_HARD_DEADLINE_MS } from "../../src/config";
import { Budget } from "../../src/shared/budget";
import { Subrequests } from "../../src/shared/subrequests";

describe("Budget", () => {
  it("allows maxFetches then refuses", () => {
    const b = new Budget(2, 1000, () => 0);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    expect(b.used).toBe(2);
    expect(b.exhausted).toBe(true);
  });
  it("stops before the subrequest limit, leaving `reserve` for the request and its cache write", () => {
    const s = new Subrequests(5);
    const b = new Budget(10, 1000, () => 0, { subrequests: s, reserve: 2 });
    s.take(); // a cache read
    s.take(); // another
    expect(b.take()).toBe(true); // 3 left: room for a fetch and its write
    s.take(); // the fetch
    s.take(); // its write
    expect(b.stopKind).toBe("subrequests");
    expect(b.take()).toBe(false);
    expect(b.used).toBe(1);
  });

  it("names why it stopped: the subrequest limit first, then fetches, then time", () => {
    let t = 0;
    const b = new Budget(1, 100, () => t);
    expect(b.stopKind).toBeNull();
    b.take();
    expect(b.stopKind).toBe("fetches");
    t = 101;
    expect(b.stopKind).toBe("fetches");
    expect(new Budget(5, 100, () => t).stopKind).toBeNull();
    const late = new Budget(5, 100, () => t);
    t = 202;
    expect(late.stopKind).toBe("time");
    expect(new Budget(5, 100, () => t, { subrequests: new Subrequests(0) }).stopKind).toBe("subrequests");
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

describe("Budget's hard deadline", () => {
  it("is TOOL_HARD_DEADLINE_MS (28 s) from construction unless given", () => {
    expect(TOOL_HARD_DEADLINE_MS).toBe(28_000);
    let t = 0;
    const b = new Budget(5, 60_000, () => t);
    t = 27_999;
    expect(b.stopKind).toBeNull();
    t = 28_000;
    expect(b.stopKind).toBe("time");
    expect(b.cut).toBe(false); // nothing was running to cut
  });

  it("signal aborts a request still running at the deadline, and marks the call cut", async () => {
    const b = new Budget(5, 60_000, () => 0, { hardMs: 30 });
    const inner = new AbortController();
    const signal = b.signal(inner.signal);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => signal.addEventListener("abort", r));
    expect(b.cut).toBe(true);
    expect(b.stopKind).toBe("time");
    expect(b.timeLimitMs).toBe(30);
    expect(inner.signal.aborted).toBe(false);
  });

  it("signal still follows the request's own signal", () => {
    const b = new Budget(5, 60_000, () => 0);
    const inner = new AbortController();
    const signal = b.signal(inner.signal);
    inner.abort();
    expect(signal.aborted).toBe(true);
    expect(b.cut).toBe(false);
  });

  it("race gives the cut value when the work runs past the deadline", async () => {
    const b = new Budget(5, 60_000, () => 0, { hardMs: 30 });
    expect(await b.race(() => Promise.resolve("done"), () => "cut")).toBe("done");
    expect(b.cut).toBe(false);
    expect(await b.race(() => new Promise<string>(() => {}), () => "cut")).toBe("cut");
    expect(b.cut).toBe(true);
  });

  it("the time limit it reports is the soft one until something is cut", () => {
    let t = 0;
    const b = new Budget(5, 22_000, () => t);
    t = 23_000;
    expect(b.stopKind).toBe("time");
    expect(b.timeLimitMs).toBe(22_000);
    expect(b.startBy).toBe(22_000);
  });
});
