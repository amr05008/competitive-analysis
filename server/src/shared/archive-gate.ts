import { ARCHIVE_COOLDOWN_MS, ARCHIVE_GAP_MS, ARCHIVE_MAX_QUEUE } from "../config";
import { politeFetch, type ArchiveFetch, type FailedOutcome, type FetchOutcome, type Fetcher } from "./http";

/**
 * A refusal: a 429, a 503, or a connection that was refused or dropped. A
 * timeout or another error status is a plain failure, not a refusal.
 */
function isRefusal(out: FailedOutcome): boolean {
  return out.reason === "source_rate_limited" || out.status === 503 || out.detail.includes("connection");
}

/**
 * Every Wayback Machine request on the server goes through one gate: one
 * request at a time, starts at least ARCHIVE_GAP_MS apart, at most
 * ARCHIVE_MAX_QUEUE pending (the running one included), and after a refusal
 * every request fails fast for ARCHIVE_COOLDOWN_MS. The state is in memory and
 * resets if the object is evicted.
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
    if (this.#queued >= ARCHIVE_MAX_QUEUE) {
      return Promise.resolve<FetchOutcome>({ ok: false, reason: "server_busy", url, detail: "archive queue full" });
    }
    this.#queued++;
    const turn = this.#chain.then(async (): Promise<FetchOutcome> => {
      const wait = this.#lastStart + ARCHIVE_GAP_MS - this.#now();
      if (wait > 0) await this.#sleep(wait);
      // A request ahead of this one may have been refused while it waited.
      if (this.#coolingDown()) return this.#paused(url);
      this.#lastStart = this.#now();
      const out = await politeFetch(this.#fetcher, url, opts);
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

  #paused(url: string): FetchOutcome {
    return { ok: false, reason: "source_rate_limited", url, detail: "archive requests paused after a refusal" };
  }
}
