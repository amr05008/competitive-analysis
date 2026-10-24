import type { Fetcher } from "../../src/shared/http";

/** A fetch and a cache that count every call that reaches them, as the platform counts subrequests. */
export type Metered = { fetch: Fetcher; cache: Cache; counts: { fetch: number; cache: number }; total: () => number };

/**
 * Wraps `fetch` and `cache` so each fetch() and each Cache API match, put and delete is counted. Calls
 * a limit refuses never reach these, so the total is what the platform would count.
 */
export function meter(fetch: Fetcher, cache: Cache): Metered {
  const counts = { fetch: 0, cache: 0 };
  const counted: Fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    counts.fetch++;
    return fetch(input, init);
  }) as Fetcher;
  const store = {
    match: (request: RequestInfo | URL, options?: CacheQueryOptions) => {
      counts.cache++;
      return cache.match(request, options);
    },
    put: (request: RequestInfo | URL, response: Response) => {
      counts.cache++;
      return cache.put(request, response);
    },
    delete: (request: RequestInfo | URL, options?: CacheQueryOptions) => {
      counts.cache++;
      return cache.delete(request, options);
    },
  } as Cache;
  return { fetch: counted, cache: store, counts, total: () => counts.fetch + counts.cache };
}
