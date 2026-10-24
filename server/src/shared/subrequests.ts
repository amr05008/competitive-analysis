import { DEFAULT_SUBREQUEST_LIMIT } from "../config";
import { REFUSED_STATUS, type Fetcher } from "./http";

/** SUBREQUEST_LIMIT as a whole number of at least 1. Anything else is the default, never unlimited. */
export function parseSubrequestLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SUBREQUEST_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_SUBREQUEST_LIMIT;
}

/**
 * One tool call's subrequests: every fetch() and every Cache API call, which the Workers platform
 * counts against one limit per request. Archive requests are calls to the Limits object, whose own
 * fetches count against that object's requests, so they aren't counted here.
 */
export class Subrequests {
  #used = 0;
  constructor(readonly limit: number) {}

  get used(): number {
    return this.#used;
  }

  get left(): number {
    return this.limit - this.#used;
  }

  /** Counts one subrequest; false, counting nothing, once the limit is reached. */
  take(): boolean {
    if (this.#used >= this.limit) return false;
    this.#used++;
    return true;
  }
}

/** `fetcher`, counted. Past the limit it answers REFUSED_STATUS without making a request. */
export function countedFetch(fetcher: Fetcher, subrequests: Subrequests): Fetcher {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    subrequests.take() ? fetcher(input, init) : new Response(null, { status: REFUSED_STATUS })) as Fetcher;
}

/** The start of every tool's note for a call stopped by the subrequest limit. */
export const limitReached = (limit: number): string =>
  `the server's per-request limit of ${limit} subrequests (fetches plus cache reads and writes) was reached`;
