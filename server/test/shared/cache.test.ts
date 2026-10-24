import { describe, expect, it } from "vitest";
import { cached } from "../../src/shared/cache";

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
