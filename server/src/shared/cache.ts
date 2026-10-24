import type { Subrequests } from "./subrequests";

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

/**
 * The cache one tool call reads and writes. Every key sits under the environment's name, since staging
 * and production share one zone's cache, and every match, put and delete counts against the call's
 * subrequests. Past the limit a read is a miss and a write or delete is dropped, without a call.
 */
export function callCache(cache: Cache, environment: string, subrequests: Subrequests): Cache {
  const scoped = (request: RequestInfo | URL): Request => {
    const url = request instanceof Request ? request.url : String(request);
    const key = url.startsWith(BASE) ? url.slice(BASE.length) : encodeURIComponent(url);
    return new Request(`${BASE}${encodeURIComponent(environment)}/${key}`);
  };
  return {
    match: async (request: RequestInfo | URL, options?: CacheQueryOptions) =>
      subrequests.take() ? cache.match(scoped(request), options) : undefined,
    put: async (request: RequestInfo | URL, response: Response) => {
      if (subrequests.take()) await cache.put(scoped(request), response);
    },
    delete: async (request: RequestInfo | URL, options?: CacheQueryOptions) =>
      subrequests.take() ? cache.delete(scoped(request), options) : false,
  } as Cache;
}
