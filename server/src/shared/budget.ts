import { TOOL_HARD_DEADLINE_MS } from "../config";
import type { Subrequests } from "./subrequests";

/** Why a call stopped starting requests: the per-request subrequest limit, its fetch budget, or its time. */
export type StopKind = "subrequests" | "fetches" | "time";

/**
 * Caps a tool call. It stops starting requests once the fetch budget is used, once `durationMs` has
 * passed (counted from construction), or, with `subrequests`, once fewer than `reserve` are left: enough
 * for the next request and the cache write that follows it, so what was fetched is also cached. A hard
 * deadline, `hardMs` from construction (TOOL_HARD_DEADLINE_MS unless given), cuts requests still running.
 */
export class Budget {
  #used = 0;
  #cut = false;
  readonly #maxFetches: number;
  readonly #durationMs: number;
  readonly #deadline: number;
  readonly #hardMs: number;
  readonly #hardAt: number;
  readonly #now: () => number;
  readonly #subrequests: Subrequests | undefined;
  readonly #reserve: number;

  constructor(
    maxFetches: number,
    durationMs: number,
    now: () => number,
    opts: { subrequests?: Subrequests; reserve?: number; hardMs?: number } = {},
  ) {
    const start = now();
    this.#maxFetches = maxFetches;
    this.#durationMs = durationMs;
    this.#deadline = start + durationMs;
    this.#hardMs = opts.hardMs ?? TOOL_HARD_DEADLINE_MS;
    this.#hardAt = start + this.#hardMs;
    this.#now = now;
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
    if (this.timeUp) return "time";
    return null;
  }

  /** Whether the time to start requests has passed, or the hard deadline has. */
  get timeUp(): boolean {
    return this.#cut || this.#now() > this.#deadline || this.#now() >= this.#hardAt;
  }

  /** The last moment a request may start. */
  get startBy(): number {
    return this.#deadline;
  }

  /** Whether the hard deadline cut a request short. */
  get cut(): boolean {
    return this.#cut;
  }

  /** The time limit a stop note names: the hard deadline once it cut a request, otherwise `durationMs`. */
  get timeLimitMs(): number {
    return this.#cut ? this.#hardMs : this.#durationMs;
  }

  /** `signal`, plus a timeout at the hard deadline that cuts the request it is given to. */
  signal(signal?: AbortSignal | null): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(0, this.#hardAt - this.#now()));
    timeout.addEventListener("abort", () => {
      this.#cut = true;
    });
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /**
   * Runs `work`, but gives `cut()` instead if it is still running at the hard deadline; for requests
   * that can't take a signal, such as calls to the Limits object.
   */
  async race<T>(work: () => Promise<T>, cut: () => T): Promise<T> {
    const ms = this.#hardAt - this.#now();
    if (ms <= 0) {
      this.#cut = true;
      return cut();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        this.#cut = true;
        resolve(cut());
      }, ms);
    });
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
