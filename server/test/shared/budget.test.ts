import { describe, expect, it } from "vitest";
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
