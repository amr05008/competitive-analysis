import { ERROR_REASONS, utcDay } from "./contract/envelope";
import { TOOL_NAMES, type HnResult, type JobOpeningsResult, type PageHistoryResult, type SecResult, type ToolName, type ToolResult } from "./contract/tools";
import { postDiscord } from "./discord";
import type { runTool } from "./mcp";
import { limitsStub } from "./shared/limits";
import type { UsageRow } from "./shared/usage-store";

const DAY_MS = 86_400_000;

export type SelfCheck = {
  tool: ToolName;
  input: (now: number) => object;
  /** Null for a pass, or what failed. */
  pass: (result: ToolResult) => string | null;
};

/** The YYYY-MM three months before `now`, in UTC. */
function threeMonthsBefore(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1)).toISOString().slice(0, 7);
}

function errorDetail(result: ToolResult): string | null {
  return result.status === "error" ? `error ${result.error?.reason ?? "unknown"}` : null;
}

export const SELF_CHECKS: SelfCheck[] = [
  {
    tool: "page_history",
    input: (now) => ({ url: "https://hightouch.com/", from: threeMonthsBefore(now), max_changes: 2 }),
    pass(result) {
      const r = result as PageHistoryResult;
      if (r.status === "error") return errorDetail(r);
      if (!((r.captures_in_range ?? 0) > 0)) return "no captures in range";
      if (!r.first_capture) return "no first capture";
      return null;
    },
  },
  {
    tool: "job_openings",
    input: () => ({ domain: "hightouch.com", company_name: "Hightouch" }),
    pass(result) {
      const r = result as JobOpeningsResult;
      return errorDetail(r) ?? (r.board ? null : "no board found");
    },
  },
  {
    tool: "hacker_news_mentions",
    input: () => ({ query: "Hightouch", years: 2 }),
    pass(result) {
      const r = result as HnResult;
      const stories = (r.years ?? []).reduce((sum, y) => sum + y.stories, 0);
      return errorDetail(r) ?? (stories > 0 ? null : "no stories found");
    },
  },
  {
    tool: "sec_filings",
    input: () => ({ company_name: "Stripe" }),
    pass(result) {
      const r = result as SecResult;
      return errorDetail(r) ?? ((r.entities ?? []).some((e) => e.form_d.length > 0) ? null : "no Form D found");
    },
  },
];

/** Runs every check once through `run` (as self-check calls). Returns the ones that failed. */
export async function runSelfCheck(
  run: typeof runTool,
  env: Env,
  ctx: ExecutionContext,
  now: number,
): Promise<{ tool: ToolName; detail: string }[]> {
  // Honored only in dev, so a stray value in production can't fake an alarm.
  if (env.ENVIRONMENT === "dev" && env.SELF_CHECK_FORCE_FAIL) {
    return SELF_CHECKS.map((c) => ({ tool: c.tool, detail: "forced" }));
  }
  const failures: { tool: ToolName; detail: string }[] = [];
  for (const check of SELF_CHECKS) {
    let detail: string | null;
    try {
      detail = check.pass(await run(check.tool, check.input(now), env, ctx, { selfCheck: true }));
    } catch {
      detail = "check threw";
    }
    if (detail !== null) failures.push({ tool: check.tool, detail });
  }
  return failures;
}

const OUTCOME_ORDER: readonly string[] = ["ok", "partial", ...ERROR_REASONS];

/** One line of anonymous counts per tool, for the days from `fromDay` to `toDay`. */
export function weeklySummary(rows: UsageRow[], fromDay: string, toDay: string): string {
  const head = `competitive-analysis usage, ${fromDay} to ${toDay}: `;
  if (rows.length === 0) return `${head}no calls this week`;
  const parts = TOOL_NAMES.map((tool) => {
    const byOutcome = new Map<string, number>();
    for (const row of rows) if (row.tool === tool) byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + row.n);
    if (byOutcome.size === 0) return `${tool} none`;
    const total = [...byOutcome.values()].reduce((a, b) => a + b, 0);
    const detail = [...byOutcome]
      .sort(([a], [b]) => OUTCOME_ORDER.indexOf(a) - OUTCOME_ORDER.indexOf(b))
      .map(([outcome, n]) => `${outcome} ${n}`)
      .join(", ");
    return `${tool} ${total} (${detail})`;
  });
  return head + parts.join("; ");
}

/** The daily job: run the checks, post any failures, and on Mondays (UTC) post last week's usage. */
export async function runScheduled(
  env: Env,
  ctx: ExecutionContext,
  now: number,
  deps: { run: typeof runTool; fetcher: typeof fetch },
): Promise<void> {
  const failures = await runSelfCheck(deps.run, env, ctx, now);
  if (failures.length > 0) {
    const lines = failures.map((f) => `- ${f.tool}: ${f.detail}`);
    await postDiscord(deps.fetcher, env.DISCORD_WEBHOOK_URL, [`competitive-analysis self-check (${env.ENVIRONMENT}) failed:`, ...lines].join("\n"));
  }
  if (new Date(now).getUTCDay() === 1) {
    const fromDay = utcDay(now - 7 * DAY_MS);
    const toDay = utcDay(now - DAY_MS);
    let rows: UsageRow[] = [];
    try {
      rows = await limitsStub(env).usage(fromDay, toDay);
    } catch {
      return; // No counts to report; the next Monday will.
    }
    await postDiscord(deps.fetcher, env.DISCORD_WEBHOOK_URL, weeklySummary(rows, fromDay, toDay));
  }
}
