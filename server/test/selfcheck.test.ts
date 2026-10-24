import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResult } from "../src/contract/envelope";
import type { ToolName, ToolResult } from "../src/contract/tools";
import type { runTool } from "../src/mcp";
import { SELF_CHECKS, runScheduled, runSelfCheck, weeklySummary } from "../src/selfcheck";
import { postDiscord } from "../src/discord";

const NOW = Date.parse("2026-10-24T06:00:00Z"); // a Saturday
const MONDAY = Date.parse("2026-10-26T06:00:00Z");

const base = { notes: [], retrieved_at: "2026-10-24" };
const PASSING: Record<ToolName, ToolResult> = {
  page_history: {
    ...base,
    status: "ok",
    captures_in_range: 5,
    first_capture: { timestamp: "20200101000000", date: "2020-01-01", link: "https://web.archive.org/x" },
  },
  job_openings: { ...base, status: "ok", board: { ats: "greenhouse", slug: "hightouch", url: "https://x.test" } },
  hacker_news_mentions: {
    ...base,
    status: "ok",
    years: [{ year: 2026, stories: 3, comments: 1, sample_titles: [], search_link: "https://x.test" }],
  },
  sec_filings: {
    ...base,
    status: "ok",
    entities: [
      {
        name: "Stripe, Inc.",
        cik: "1",
        state: null,
        former_names: [],
        exact_match: true,
        edgar_link: "https://x.test",
        filings: [],
        form_d: [
          {
            date_filed: "2026-01-01",
            link: "https://x.test",
            amendment: false,
            total_offering_amount: null,
            total_amount_sold: null,
            date_of_first_sale: null,
            industry_group: null,
            year_of_incorporation: null,
          },
        ],
      },
    ],
  },
} as Record<ToolName, ToolResult>;

type Call = { name: ToolName; input: unknown; selfCheck: boolean };

function fakeRunner(overrides: Partial<Record<ToolName, ToolResult>> = {}) {
  const calls: Call[] = [];
  const run = (async (name: ToolName, input: unknown, _env: Env, _ctx: ExecutionContext, opts: { selfCheck: boolean }) => {
    calls.push({ name, input, selfCheck: opts.selfCheck });
    return overrides[name] ?? PASSING[name];
  }) as typeof runTool;
  return { run, calls };
}

function fakeFetcher(status = 204) {
  const posts: { url: string; body: { content: string } }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetcher, posts };
}

const HOOK = "https://discord.test/api/webhooks/fake";
const withEnv = (extra: Record<string, string | undefined>) => ({ ...env, ...extra }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("SELF_CHECKS", () => {
  it("are exactly the four checks", () => {
    expect(SELF_CHECKS.map((c) => c.tool)).toEqual(["page_history", "job_openings", "hacker_news_mentions", "sec_filings"]);
    expect(SELF_CHECKS[0]!.input(NOW)).toEqual({ url: "https://hightouch.com/", from: "2026-07", max_changes: 2 });
    expect(SELF_CHECKS[1]!.input(NOW)).toEqual({ domain: "hightouch.com", company_name: "Hightouch" });
    expect(SELF_CHECKS[2]!.input(NOW)).toEqual({ query: "Hightouch", years: 2 });
    expect(SELF_CHECKS[3]!.input(NOW)).toEqual({ company_name: "Stripe" });
  });

  it("page_history's from wraps across the year", () => {
    expect(SELF_CHECKS[0]!.input(Date.parse("2026-02-10T00:00:00Z"))).toMatchObject({ from: "2025-11" });
  });

  it("each check fails on an empty answer", () => {
    const empty = { ...base, status: "ok" } as ToolResult;
    for (const c of SELF_CHECKS) expect(c.pass(empty)).not.toBeNull();
    for (const c of SELF_CHECKS) expect(c.pass(PASSING[c.tool])).toBeNull();
  });

  it("page_history fails with zero captures or status error", () => {
    const check = SELF_CHECKS[0]!;
    expect(check.pass({ ...PASSING.page_history, captures_in_range: 0 } as ToolResult)).not.toBeNull();
    expect(check.pass({ ...PASSING.page_history, status: "error" } as ToolResult)).not.toBeNull();
  });
});

describe("scheduled self-check", () => {
  it("posts nothing when every check passes", async () => {
    const { run } = fakeRunner();
    const { fetcher, posts } = fakeFetcher();
    await runScheduled(withEnv({ DISCORD_WEBHOOK_URL: HOOK, ENVIRONMENT: "production" }), createExecutionContext(), NOW, { run, fetcher });
    expect(posts).toEqual([]);
  });

  it("posts one message naming each failing tool and its detail", async () => {
    const { run } = fakeRunner({
      job_openings: { ...base, status: "ok" } as ToolResult,
      sec_filings: errorResult("source_unavailable", "EDGAR down", [], NOW),
    });
    const { fetcher, posts } = fakeFetcher();
    await runScheduled(withEnv({ DISCORD_WEBHOOK_URL: HOOK, ENVIRONMENT: "production" }), createExecutionContext(), NOW, { run, fetcher });
    expect(posts).toHaveLength(1);
    const text = posts[0]!.body.content;
    expect(posts[0]!.url).toBe(HOOK);
    expect(text.startsWith("competitive-analysis self-check (production) failed:")).toBe(true);
    expect(text).toContain("job_openings: no board found");
    expect(text).toContain("sec_filings: error source_unavailable");
    expect(text).not.toContain("page_history");
  });

  it("self-check calls run with selfCheck true", async () => {
    const { run, calls } = fakeRunner();
    await runSelfCheck(run, env, createExecutionContext(), NOW);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.selfCheck === true)).toBe(true);
  });

  it("a runner that throws is a failure, not a crash", async () => {
    const run = (async () => {
      throw new Error("boom with input");
    }) as unknown as typeof runTool;
    const failures = await runSelfCheck(run, env, createExecutionContext(), NOW);
    expect(failures).toHaveLength(4);
    expect(JSON.stringify(failures)).not.toContain("boom");
  });

  it("posts the weekly summary on Mondays (UTC) only", async () => {
    const { run } = fakeRunner();
    const e = withEnv({ DISCORD_WEBHOOK_URL: HOOK, ENVIRONMENT: "production" });
    const sat = fakeFetcher();
    await runScheduled(e, createExecutionContext(), NOW, { run, fetcher: sat.fetcher });
    expect(sat.posts).toEqual([]);
    const mon = fakeFetcher();
    await runScheduled(e, createExecutionContext(), MONDAY, { run, fetcher: mon.fetcher });
    expect(mon.posts).toHaveLength(1);
    expect(mon.posts[0]!.body.content).toBe("competitive-analysis usage, 2026-10-19 to 2026-10-25: no calls this week");
  });

  it("a missing webhook logs one warning and doesn't throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run } = fakeRunner({ job_openings: { ...base, status: "ok" } as ToolResult });
    const { fetcher, posts } = fakeFetcher();
    await runScheduled(withEnv({ DISCORD_WEBHOOK_URL: undefined }), createExecutionContext(), NOW, { run, fetcher });
    expect(posts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]!.join(" "))).not.toMatch(/https?:|hightouch/i);
  });

  it("SELF_CHECK_FORCE_FAIL is honored only when ENVIRONMENT is dev", async () => {
    const { run, calls } = fakeRunner();
    const dev = await runSelfCheck(run, withEnv({ ENVIRONMENT: "dev", SELF_CHECK_FORCE_FAIL: "1" }), createExecutionContext(), NOW);
    expect(dev).toHaveLength(4);
    expect(dev.every((f) => f.detail === "forced")).toBe(true);
    expect(calls).toEqual([]);
    const prod = await runSelfCheck(run, withEnv({ ENVIRONMENT: "production", SELF_CHECK_FORCE_FAIL: "1" }), createExecutionContext(), NOW);
    expect(prod).toEqual([]);
    expect(calls).toHaveLength(4);
  });
});

describe("weeklySummary", () => {
  it("lists each tool's total and outcomes, and none for tools without rows", () => {
    const rows = [
      { day: "2026-10-19", tool: "page_history", outcome: "ok", n: 6 },
      { day: "2026-10-20", tool: "page_history", outcome: "ok", n: 4 },
      { day: "2026-10-20", tool: "page_history", outcome: "partial", n: 1 },
      { day: "2026-10-21", tool: "page_history", outcome: "server_busy", n: 1 },
      { day: "2026-10-21", tool: "sec_filings", outcome: "not_found", n: 2 },
    ] as const;
    expect(weeklySummary([...rows], "2026-10-19", "2026-10-25")).toBe(
      "competitive-analysis usage, 2026-10-19 to 2026-10-25: page_history 12 (ok 10, partial 1, server_busy 1); job_openings none; hacker_news_mentions none; sec_filings 2 (not_found 2)",
    );
  });

  it("reads no calls this week when empty", () => {
    expect(weeklySummary([], "2026-10-19", "2026-10-25")).toBe(
      "competitive-analysis usage, 2026-10-19 to 2026-10-25: no calls this week",
    );
  });
});

describe("postDiscord", () => {
  it("posts { content } as JSON", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await postDiscord(fetcher, HOOK, "hello");
    expect(seen[0]!.method).toBe("POST");
    expect(new Headers(seen[0]!.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ content: "hello" });
  });

  it("swallows a non-2xx answer and a thrown fetch", async () => {
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    await expect(postDiscord(bad, HOOK, "x")).resolves.toBeUndefined();
    await expect(postDiscord(boom, HOOK, "x")).resolves.toBeUndefined();
  });

  it("Discord messages are capped at 1,900 characters", async () => {
    const { fetcher, posts } = fakeFetcher();
    await postDiscord(fetcher, HOOK, "x".repeat(5000));
    expect(posts[0]!.body.content.length).toBeLessThanOrEqual(1900);
  });
});

describe("scheduled handler", () => {
  it("is exported and does not throw without a webhook", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = (await import("../src/index")).default;
    expect(typeof worker.scheduled).toBe("function");
    const ctx = createExecutionContext();
    // The Limits object is real; ENVIRONMENT is dev with force-fail so no network is touched.
    await worker.scheduled!({ scheduledTime: NOW, cron: "0 6 * * *", noRetry() {} } as ScheduledController, withEnv({ SELF_CHECK_FORCE_FAIL: "1", DISCORD_WEBHOOK_URL: undefined }), ctx);
    await waitOnExecutionContext(ctx);
  });
});
