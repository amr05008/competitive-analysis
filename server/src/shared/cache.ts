const BASE = "https://cache.competitive-analysis.invalid/";

/** Read-through JSON cache. A cache failure never fails the call; null is never stored. */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T | null>,
): Promise<{ value: T | null; hit: boolean }> {
  const request = new Request(BASE + encodeURIComponent(key));
  try {
    const found = await cache.match(request);
    if (found) return { value: (await found.json()) as T, hit: true };
  } catch {
    // fall through to produce()
  }
  const value = await produce();
  if (value !== null) {
    try {
      await cache.put(
        request,
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` },
        }),
      );
    } catch {
      // a failed write only costs a future miss
    }
  }
  return { value, hit: false };
}
