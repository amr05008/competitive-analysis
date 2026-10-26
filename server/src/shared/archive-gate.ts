import { ARCHIVE_COOLDOWN_MS, ARCHIVE_GAP_MS, ARCHIVE_MAX_QUEUE } from "../config";
import { politeFetch, REFUSED_STATUS, type ArchiveFetch, type FailedOutcome, type FetchOutcome, type Fetcher } from "./http";

/**
 * A refusal: a 429, a 503, or a connection that was refused or dropped
 * (politeFetch's "connection failed (...)"). A timeout or another error status
 * is a plain failure, not a refusal.
 */
function isRefusal(out: FailedOutcome): boolean {
  // A replayed capture's own status is the archived page's answer, never the archive turning us away.
  if (out.recorded) return false;
  return out.reason === "source_rate_limited" || out.status === 503 || out.detail.startsWith("connection failed");
}

/**
 * Every Wayback Machine request on the server goes through one gate: one
 * request at a time, starts at least ARCHIVE_GAP_MS apart, at most
 * ARCHIVE_MAX_QUEUE pending (the running one included), and after a refusal
 * every request fails fast for ARCHIVE_COOLDOWN_MS. A request with `startBy` is
 * turned away, unstarted, when its turn would begin after that moment. The state
 * is in memory and resets if the object is evicted.
 */
export class ArchiveGate {
  readonly #fetcher: Fetcher;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #chain: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #lastStart = Number.NEGATIVE_INFINITY;
  #cooldownUntil = Number.NEGATIVE_INFINITY;

  constructor(fetcher: Fetcher, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.#fetcher = fetcher;
    this.#now = now;
    this.#sleep = sleep;
  }

  run: ArchiveFetch = (url, opts) => {
    if (this.#coolingDown()) return Promise.resolve(this.#paused(url));
    if (this.#late(opts?.startBy, 0)) return Promise.resolve(this.#tooLate(url));
    if (this.#queued >= ARCHIVE_MAX_QUEUE) {
      return Promise.resolve<FetchOutcome>({ ok: false, reason: "server_busy", url, detail: "this server's archive queue is full" });
    }
    this.#queued++;
    const turn = this.#chain.then(async (): Promise<FetchOutcome> => {
      const wait = Math.max(0, this.#lastStart + ARCHIVE_GAP_MS - this.#now());
      // The requests ahead of this one may have taken it past its start time.
      if (this.#late(opts?.startBy, wait)) return this.#tooLate(url);
      if (wait > 0) await this.#sleep(wait);
      // A request ahead of this one may have been refused while it waited.
      if (this.#coolingDown()) return this.#paused(url);
      this.#lastStart = this.#now();
      const out = await politeFetch(this.#fetcher, url, { timeoutMs: opts?.timeoutMs, maxBytes: opts?.maxBytes });
      if (!out.ok && isRefusal(out)) {
        this.#cooldownUntil = this.#now() + ARCHIVE_COOLDOWN_MS;
        return { ...out, reason: "source_rate_limited" };
      }
      return out;
    });
    const done = turn.finally(() => {
      this.#queued--;
    });
    this.#chain = done.catch(() => {});
    return done;
  };

  #coolingDown(): boolean {
    return this.#now() < this.#cooldownUntil;
  }

  /** Whether a request that may start until `startBy` would start too late after `wait` more ms. */
  #late(startBy: number | undefined, wait: number): boolean {
    return startBy !== undefined && this.#now() + wait > startBy;
  }

  #tooLate(url: string): FetchOutcome {
    return { ok: false, reason: "server_busy", status: REFUSED_STATUS, url, detail: "the archive queue would start this request too late" };
  }

  #paused(url: string): FetchOutcome {
    return { ok: false, reason: "source_rate_limited", url, detail: "archive requests paused after a refusal" };
  }
}
