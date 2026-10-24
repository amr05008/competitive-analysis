import { describe, expect, it } from "vitest";
import { cached, callCache } from "../../src/shared/cache";
import { Subrequests } from "../../src/shared/subrequests";

const BASE = "https://cache.competitive-analysis.invalid/";

describe("cached", () => {
  it("misses then hits", async () => {
    const key = `k-${crypto.randomUUID()}`;
    let calls = 0;
    const produce = async () => { calls++; return { n: 1 }; };
    const a = await cached(caches.default, key, 60, produce);
    const b = await cached(caches.default, key, 60, produce);
    expect(a).toEqual({ value: { n: 1 }, hit: false });
    expect(b).toEqual({ value: { n: 1 }, hit: true });
    expect(calls).toBe(1);
  });

  it("never stores null", async () => {
    const key = `k-${crypto.randomUUID()}`;
    let calls = 0;
    const produce = async () => { calls++; return null; };
    expect(await cached(caches.default, key, 60, produce)).toEqual({ value: null, hit: false });
    await cached(caches.default, key, 60, produce);
    expect(calls).toBe(2);
    expect(await caches.default.match(BASE + encodeURIComponent(key))).toBeUndefined();
  });

  it("stores under the encoded key with max-age", async () => {
    const key = `a b/${crypto.randomUUID()}`;
    await cached(caches.default, key, 123, async () => 1);
    const res = await caches.default.match(BASE + encodeURIComponent(key));
    expect(res?.headers.get("cache-control")).toBe("max-age=123");
  });

  it("falls through when the cache throws", async () => {
    const broken = { match: async () => { throw new Error("x"); }, put: async () => { throw new Error("y"); } } as unknown as Cache;
    expect(await cached(broken, "k", 60, async () => 5)).toEqual({ value: 5, hit: false });
  });
});

describe("callCache", () => {
  const fresh = () => caches.open(`call-${crypto.randomUUID()}`);

  it("the same key in two environments doesn't collide", async () => {
    const shared = await fresh();
    const staging = callCache(shared, "staging", new Subrequests(45));
    const production = callCache(shared, "production", new Subrequests(45));
    expect(await cached(staging, "edgar:v2:k", 60, async () => "staging value")).toEqual({ value: "staging value", hit: false });
    expect(await cached(production, "edgar:v2:k", 60, async () => "production value")).toEqual({ value: "production value", hit: false });
    expect(await cached(staging, "edgar:v2:k", 60, async () => "unused")).toEqual({ value: "staging value", hit: true });
    expect(await shared.match(BASE + encodeURIComponent("edgar:v2:k"))).toBeUndefined();
    expect(await shared.match(`${BASE}staging/${encodeURIComponent("edgar:v2:k")}`)).toBeDefined();
  });

  it("counts every match, put and delete against the call's subrequests", async () => {
    const s = new Subrequests(45);
    const c = callCache(await fresh(), "test", s);
    await cached(c, "k", 60, async () => 1); // a miss and a write
    await cached(c, "k", 60, async () => 1); // a hit
    await c.delete(BASE + "k");
    expect(s.used).toBe(4);
  });

  it("past the limit a read is a miss and a write is dropped, without touching the cache", async () => {
    const inner = await fresh();
    const s = new Subrequests(1);
    const c = callCache(inner, "test", s);
    let produced = 0;
    const produce = async () => ++produced;
    expect(await cached(c, "k", 60, produce)).toEqual({ value: 1, hit: false }); // the read takes the last one; the write is dropped
    expect(await inner.match(`${BASE}test/k`)).toBeUndefined();
    expect(await cached(c, "k", 60, produce)).toEqual({ value: 2, hit: false });
    expect(await c.delete(BASE + "k")).toBe(false);
    expect(s.used).toBe(1);
  });
});
