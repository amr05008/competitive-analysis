import { DurableObject } from "cloudflare:workers";
import type { ToolName } from "../contract/tools";
import { ArchiveGate } from "./archive-gate";
import type { ArchiveFetch, FetchOutcome } from "./http";
import { UsageStore, type Outcome, type UsageRow } from "./usage-store";

/** A cap that isn't a whole number of calls refuses every call rather than none. */
function parseCap(raw: string): number {
  const cap = Number(raw);
  return Number.isInteger(cap) && cap >= 0 ? cap : 0;
}

/**
 * The server-wide limits, in one global object (see limitsStub): the archive
 * gate, the daily call cap and the anonymous usage counts. Self-check calls
 * count toward the cap but not in usage.
 */
export class Limits extends DurableObject<Env> {
  readonly #store: UsageStore;
  readonly #gate: ArchiveGate;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new UsageStore(ctx.storage.sql, () => Date.now(), parseCap(env.DAILY_TOOL_CALL_CAP));
    this.#gate = new ArchiveGate(
      (input, init) => fetch(input, init),
      () => Date.now(),
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    );
  }

  /** Whether a call may run today. A refused ordinary call counts as server_busy in usage. */
  async admit(tool: ToolName, selfCheck: boolean): Promise<{ allowed: boolean }> {
    const allowed = this.#store.admit();
    if (!allowed && !selfCheck) this.#store.record(tool, "server_busy");
    return { allowed };
  }

  async record(tool: ToolName, outcome: Outcome, selfCheck: boolean): Promise<void> {
    if (!selfCheck) this.#store.record(tool, outcome);
  }

  async usage(fromDay: string, toDay: string): Promise<UsageRow[]> {
    return this.#store.usage(fromDay, toDay);
  }

  /** One Wayback Machine request, through the server-wide gate. */
  async archiveFetch(url: string, opts?: Parameters<ArchiveFetch>[1]): Promise<FetchOutcome> {
    return this.#gate.run(url, opts);
  }
}

export function limitsStub(env: Env): DurableObjectStub<Limits> {
  return env.LIMITS.get(env.LIMITS.idFromName("global"));
}
