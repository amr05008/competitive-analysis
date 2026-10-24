/** Caps a tool call's upstream fetches and wall-clock time. `durationMs` is counted from construction. */
export class Budget {
  #used = 0;
  readonly #deadline: number;
  constructor(
    private readonly maxFetches: number,
    durationMs: number,
    private readonly now: () => number,
  ) {
    this.#deadline = now() + durationMs;
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
    return this.#used >= this.maxFetches || this.now() > this.#deadline;
  }
}
