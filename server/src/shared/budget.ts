import type { Subrequests } from "./subrequests";

/** Why a call stopped starting requests: the per-request subrequest limit, its fetch budget, or its time. */
export type StopKind = "subrequests" | "fetches" | "time";

/**
 * Caps a tool call's upstream fetches and wall-clock time. `durationMs` is counted from construction.
 * With `subrequests`, it also stops once fewer than `reserve` are left: enough for the next request
 * and the cache write that follows it, so what was fetched is also cached.
 */
export class Budget {
  #used = 0;
  readonly #maxFetches: number;
  readonly #deadline: number;
  readonly #now: () => number;
  readonly #subrequests: Subrequests | undefined;
  readonly #reserve: number;

  constructor(
    maxFetches: number,
    durationMs: number,
    now: () => number,
    opts: { subrequests?: Subrequests; reserve?: number } = {},
  ) {
    this.#maxFetches = maxFetches;
    this.#now = now;
    this.#deadline = now() + durationMs;
    this.#subrequests = opts.subrequests;
    this.#reserve = opts.reserve ?? 1;
  }

  take(): boolean {
    if (this.exhausted) return false;
    this.#used++;
    return true;
  }

  get used(): number {
    return this.#used;
  }

  get exhausted(): boolean {
    return this.stopKind !== null;
  }

  /** Why no more requests may start, or null while they may. */
  get stopKind(): StopKind | null {
    if (this.#subrequests && this.#subrequests.left < this.#reserve) return "subrequests";
    if (this.#used >= this.#maxFetches) return "fetches";
    if (this.#now() > this.#deadline) return "time";
    return null;
  }
}
