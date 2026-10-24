import type { Fetcher } from "../../src/shared/http";

export type Route = string | { status: number; body?: string; headers?: Record<string, string> };
export type FakeFetch = Fetcher & { calls: string[] };

/**
 * A stand-in for the network, so tests never reach it. A URL answers from
 * `routes` (a string is a 200 body); a URL with no route answers HTTP 404.
 * Every requested URL is recorded in `calls`, in order.
 */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "string") return new Response(route, { status: 200 });
    return new Response(route.body ?? "", { status: route.status, headers: route.headers });
  }) as FakeFetch;
  fetcher.calls = calls;
  return fetcher;
}

/**
 * `fetch`, except that a request for `url` hangs until its signal aborts, then rejects with the
 * signal's reason, as a real fetch does. It is recorded in `calls` like any other.
 */
export function hangingOn(fetch: FakeFetch, url: string): FakeFetch {
  const hanging = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target !== url) return fetch(input, init);
    fetch.calls.push(target);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as FakeFetch;
  hanging.calls = fetch.calls;
  return hanging;
}
