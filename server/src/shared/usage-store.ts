import { USAGE_RETENTION_DAYS } from "../config";
import { ERROR_REASONS, utcDay, type ErrorReason } from "../contract/envelope";
import { TOOL_NAMES, type ToolName, type ToolResult } from "../contract/tools";

/** How a tool call ended: its status, or its error reason when it failed. */
export type Outcome = "ok" | "partial" | ErrorReason;

const OUTCOMES: readonly Outcome[] = ["ok", "partial", ...ERROR_REASONS];

export type UsageRow = { day: string; tool: ToolName; outcome: Outcome; n: number };

const DAY_MS = 86_400_000;

export function outcomeOf(result: ToolResult): Outcome {
  return result.status === "error" ? (result.error?.reason ?? "source_unavailable") : result.status;
}

/**
 * The daily call cap and the usage counts, in the Limits object's SQLite.
 * A "day" is a UTC calendar day. `calls` holds how many calls each day
 * admitted; `usage` holds a count per day, tool and outcome, and nothing else:
 * no inputs, no addresses, no identifiers.
 */
export class UsageStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  readonly #cap: number;
  #prunedDay: string | null = null;

  constructor(sql: SqlStorage, now: () => number, cap: number) {
    this.#sql = sql;
    this.#now = now;
    this.#cap = cap;
    sql.exec("CREATE TABLE IF NOT EXISTS calls (day TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, tool, outcome))",
    );
  }

  /** Counts the call and returns true while today's admitted calls are under the cap; a refusal isn't counted. */
  admit(): boolean {
    const day = utcDay(this.#now());
    const row = this.#sql.exec<{ n: number }>("SELECT n FROM calls WHERE day = ?", day).toArray()[0];
    if ((row?.n ?? 0) >= this.#cap) return false;
    this.#sql.exec("INSERT INTO calls (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1", day);
    return true;
  }

  /** Adds one to today's count for this tool and outcome. The first record of a day prunes old rows. */
  record(tool: ToolName, outcome: Outcome): void {
    // Only known names are stored, so nothing a caller typed can end up here.
    if (!TOOL_NAMES.includes(tool) || !OUTCOMES.includes(outcome)) return;
    const day = utcDay(this.#now());
    if (day !== this.#prunedDay) {
      const cutoff = utcDay(Date.parse(day) - USAGE_RETENTION_DAYS * DAY_MS);
      this.#sql.exec("DELETE FROM usage WHERE day < ?", cutoff);
      this.#sql.exec("DELETE FROM calls WHERE day < ?", cutoff);
      this.#prunedDay = day;
    }
    this.#sql.exec(
      "INSERT INTO usage (day, tool, outcome, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, tool, outcome) DO UPDATE SET n = n + 1",
      day,
      tool,
      outcome,
    );
  }

  /** The counts from fromDay to toDay (YYYY-MM-DD, both included), by day, tool and outcome. */
  usage(fromDay: string, toDay: string): UsageRow[] {
    return this.#sql
      .exec<UsageRow>(
        "SELECT day, tool, outcome, n FROM usage WHERE day >= ? AND day <= ? ORDER BY day, tool, outcome",
        fromDay,
        toDay,
      )
      .toArray();
  }
}
