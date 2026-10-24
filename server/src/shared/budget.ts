/** Caps a tool call's upstream fetches and wall-clock time. `deadlineMs` is an absolute `now()` value. */
export class Budget {
  #used = 0;
  constructor(
    private readonly maxFetches: number,
    private readonly deadlineMs: number,
    private readonly now: () => number,
  ) {}

  take(): boolean {
    if (this.exhausted) return false;
    this.#used++;
    return true;
  }

  get used(): number {
    return this.#used;
  }

  get exhausted(): boolean {
    return this.#used >= this.maxFetches || this.now() > this.deadlineMs;
  }
}
