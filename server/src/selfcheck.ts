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

/**
 * The production cron triggers, one tool each: a tool call may make only so many subrequests, and a
 * Cron Trigger gets little CPU on the free plan, so each check runs in its own invocation. The weekly
 * summary goes with the first.
 */
export const SCHEDULE: ReadonlyMap<string, ToolName> = new Map([
  ["0 13 * * *", "page_history"],
  ["5 13 * * *", "job_openings"],
  ["10 13 * * *", "hacker_news_mentions"],
  ["15 13 * * *", "sec_filings"],
]);
const SUMMARY_CRON = "0 13 * * *";

/** Runs the checks for `tools` (every tool unless given) once through `run`, as self-check calls. Returns the ones that failed. */
export async function runSelfCheck(
  run: typeof runTool,
  env: Env,
  ctx: ExecutionContext,
  now: number,
  tools: readonly ToolName[] = TOOL_NAMES,
): Promise<{ tool: ToolName; detail: string }[]> {
  const checks = SELF_CHECKS.filter((c) => tools.includes(c.tool));
  // Honored only in dev, so a stray value in production can't fake an alarm.
  if (env.ENVIRONMENT === "dev" && env.SELF_CHECK_FORCE_FAIL) {
    return checks.map((c) => ({ tool: c.tool, detail: "forced" }));
  }
  const failures: { tool: ToolName; detail: string }[] = [];
  for (const check of checks) {
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

/**
 * One daily cron invocation: run the check for the cron's tool (see SCHEDULE) and post a failure, and
 * with the first cron on Mondays (UTC), post last week's usage. A cron not in SCHEDULE does nothing.
 */
export async function runScheduled(
  env: Env,
  ctx: ExecutionContext,
  cron: string,
  now: number,
  deps: { run: typeof runTool; fetcher: typeof fetch },
): Promise<void> {
  const tool = SCHEDULE.get(cron);
  if (tool === undefined) return;
  const failures = await runSelfCheck(deps.run, env, ctx, now, [tool]);
  if (failures.length > 0) {
    const lines = failures.map((f) => `- ${f.tool}: ${f.detail}`);
    await postDiscord(deps.fetcher, env.DISCORD_WEBHOOK_URL, [`competitive-analysis self-check (${env.ENVIRONMENT}) failed:`, ...lines].join("\n"));
  }
  if (cron === SUMMARY_CRON && new Date(now).getUTCDay() === 1) {
    const fromDay = utcDay(now - 7 * DAY_MS);
    const toDay = utcDay(now - DAY_MS);
    let rows: UsageRow[];
    try {
      rows = await limitsStub(env).usage(fromDay, toDay);
    } catch {
      await postDiscord(deps.fetcher, env.DISCORD_WEBHOOK_URL, `competitive-analysis usage summary unavailable this week (${fromDay} to ${toDay})`);
      return;
    }
    await postDiscord(deps.fetcher, env.DISCORD_WEBHOOK_URL, weeklySummary(rows, fromDay, toDay));
  }
}
