import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE_RETENTION_DAYS } from "../../src/config";
import { errorResult } from "../../src/contract/envelope";
import type { ToolName, ToolResult } from "../../src/contract/tools";
import { makeDeps } from "../../src/mcp";
import { limitsStub } from "../../src/shared/limits";
import { outcomeOf, UsageStore, type Outcome } from "../../src/shared/usage-store";

const DAY_MS = 86_400_000;
const ALL_DAYS = ["0000-01-01", "9999-12-31"] as const;

/** A Limits object of its own, so no test sees another's counts. */
const freshStub = () => env.LIMITS.get(env.LIMITS.newUniqueId());

/** Runs `fn` against a UsageStore with a cap of 3 on a fake clock, inside a fresh Limits object. */
function withStore<R>(start: number, fn: (store: UsageStore, clock: { t: number }, sql: SqlStorage) => R): Promise<R> {
  const clock = { t: start };
  return runInDurableObject(freshStub(), (_, state) =>
    fn(new UsageStore(state.storage.sql, () => clock.t, 3), clock, state.storage.sql),
  );
}

const columns = (sql: SqlStorage, table: string) =>
  sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((r) => r.name);

const days = (sql: SqlStorage, table: string) =>
  sql.exec<{ day: string }>(`SELECT DISTINCT day FROM ${table} ORDER BY day`).toArray().map((r) => r.day);

describe("UsageStore", () => {
  it("admits up to the cap, then refuses", async () => {
    const answers = await withStore(Date.UTC(2026, 9, 24, 12), (store) => [1, 2, 3, 4, 5].map(() => store.admit()));
    expect(answers).toEqual([true, true, true, false, false]);
  });

  it("the cap resets at UTC midnight", async () => {
    const answers = await withStore(Date.UTC(2026, 9, 24, 23, 59, 59, 999), (store, clock) => {
      const before = [1, 2, 3, 4].map(() => store.admit());
      clock.t += 1; // 2026-10-25T00:00:00.000Z
      return { before, after: store.admit() };
    });
    expect(answers).toEqual({ before: [true, true, true, false], after: true });
  });

  it("counts each tool and outcome per day", async () => {
    const rows = await withStore(Date.UTC(2026, 9, 24, 12), (store, clock) => {
      store.record("page_history", "ok");
      store.record("page_history", "ok");
      store.record("page_history", "source_rate_limited");
      store.record("sec_filings", "partial");
      clock.t += DAY_MS;
      store.record("page_history", "ok");
      return store.usage(...ALL_DAYS);
    });
    expect(rows).toEqual([
      { day: "2026-10-24", tool: "page_history", outcome: "ok", n: 2 },
      { day: "2026-10-24", tool: "page_history", outcome: "source_rate_limited", n: 1 },
      { day: "2026-10-24", tool: "sec_filings", outcome: "partial", n: 1 },
      { day: "2026-10-25", tool: "page_history", outcome: "ok", n: 1 },
    ]);
  });

  it("usage returns the days from fromDay to toDay, both included", async () => {
    const got = await withStore(Date.UTC(2026, 9, 20, 12), (store, clock) => {
      for (let i = 0; i < 5; i++) {
        store.record("job_openings", "ok");
        clock.t += DAY_MS;
      }
      return store.usage("2026-10-21", "2026-10-23").map((r) => r.day);
    });
    expect(got).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
  });

  it("usage keeps only day, tool, outcome and a count", async () => {
    const got = await withStore(Date.now(), (_store, _clock, sql) => ({
      usage: columns(sql, "usage"),
      calls: columns(sql, "calls"),
    }));
    expect(got).toEqual({ usage: ["day", "tool", "outcome", "n"], calls: ["day", "n"] });
  });

  it("records nothing for an unknown tool or outcome", async () => {
    const rows = await withStore(Date.now(), (store) => {
      store.record("example.com" as ToolName, "ok");
      store.record("page_history", "https://example.com/" as Outcome);
      return store.usage(...ALL_DAYS);
    });
    expect(rows).toEqual([]);
  });

  it(`rows older than USAGE_RETENTION_DAYS (${USAGE_RETENTION_DAYS}) are pruned on the first record of a new day`, async () => {
    expect(USAGE_RETENTION_DAYS).toBe(90);
    const today = Date.UTC(2026, 9, 24, 12);
    const got = await withStore(today - 91 * DAY_MS, (store, clock, sql) => {
      store.admit();
      store.record("page_history", "ok"); // 2026-07-25: 91 days before today
      clock.t = today - 90 * DAY_MS;
      store.admit();
      store.record("page_history", "ok"); // 2026-07-26: 90 days before today
      clock.t = today;
      store.record("page_history", "ok"); // the first record today prunes
      const afterFirst = { usage: days(sql, "usage"), calls: days(sql, "calls") };

      // Later records the same day don't prune again; the next day's first does.
      sql.exec("INSERT INTO usage (day, tool, outcome, n) VALUES ('2026-01-01', 'page_history', 'ok', 1)");
      store.record("page_history", "ok");
      const laterSameDay = days(sql, "usage");
      clock.t = today + DAY_MS;
      store.record("page_history", "ok");
      return { afterFirst, laterSameDay, nextDay: days(sql, "usage") };
    });
    expect(got.afterFirst).toEqual({ usage: ["2026-07-26", "2026-10-24"], calls: ["2026-07-26"] });
    expect(got.laterSameDay).toEqual(["2026-01-01", "2026-07-26", "2026-10-24"]);
    expect(got.nextDay).toEqual(["2026-10-24", "2026-10-25"]);
  });
});

describe("outcomeOf", () => {
  it.each<[string, ToolResult, Outcome]>([
    ["ok", { status: "ok", notes: [], retrieved_at: "2026-10-24" }, "ok"],
    ["partial", { status: "partial", notes: ["x"], retrieved_at: "2026-10-24" }, "partial"],
    ["error", errorResult("not_found", "x", []), "not_found"],
  ])("maps %s", (_s, result, outcome) => {
    expect(outcomeOf(result)).toBe(outcome);
  });
});

describe("Limits", () => {
  it("self-check calls count toward the cap but not usage", async () => {
    const stub = freshStub();
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push((await stub.admit("page_history", true)).allowed);
    expect(answers).toEqual([true, true, true, false]);
    await stub.record("page_history", "ok", true);
    expect(await stub.usage(...ALL_DAYS)).toEqual([]);
    // An ordinary call's outcome is counted.
    await stub.record("page_history", "ok", false);
    expect((await stub.usage(...ALL_DAYS)).map((r) => [r.tool, r.outcome, r.n])).toEqual([["page_history", "ok", 1]]);
  });

  it("an ordinary call refused by the cap counts as server_busy", async () => {
    const stub = freshStub();
    for (let i = 0; i < 3; i++) expect((await stub.admit("job_openings", false)).allowed).toBe(true);
    expect((await stub.admit("job_openings", false)).allowed).toBe(false);
    expect((await stub.usage(...ALL_DAYS)).map((r) => [r.tool, r.outcome, r.n])).toEqual([
      ["job_openings", "server_busy", 1],
    ]);
  });

  it("limitsStub is one global object", () => {
    expect(limitsStub(env).id.equals(env.LIMITS.idFromName("global"))).toBe(true);
  });

  describe("archive requests", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("archiveFetch passes its options on and returns the outcome", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("captured"));
      const url = "https://web.archive.org/web/2026/https://example.com/";
      expect(await freshStub().archiveFetch(url, { maxBytes: 4 })).toMatchObject({ ok: true, url, text: "capt", truncated: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toBe(url);
    });

    it("makeDeps's archive goes through the global object's gate", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
      const { archive } = makeDeps(env);
      expect(await archive("https://web.archive.org/a")).toMatchObject({ ok: false, reason: "source_rate_limited" });
      // The refusal started the cooldown in the global object: neither path fetches again.
      expect(await archive("https://web.archive.org/b")).toMatchObject({ ok: false, reason: "source_rate_limited" });
      expect(await limitsStub(env).archiveFetch("https://web.archive.org/c")).toMatchObject({
        ok: false,
        reason: "source_rate_limited",
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
