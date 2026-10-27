import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RESPONSE_CAP_CHARS } from "../../src/config";
import { hnOutput, type HnInput, type HnResult } from "../../src/contract/tools";
import { callDeps, type ToolDeps } from "../../src/tools";
import { hackerNewsMentions } from "../../src/tools/hn-mentions";
import { Subrequests } from "../../src/shared/subrequests";
import { fakeFetch, hangingOn, type FakeFetch, type Route } from "../helpers/fake-fetch";
import { meter } from "../helpers/meter";
import fixture from "../fixtures/hn/search-hightouch.json";

const NOW = Date.UTC(2026, 9, 20, 12); // 2026-10-20
const API = "https://hn.algolia.com/api/v1/search";
const q = (s: string) => encodeURIComponent(`"${s}"`);
const startOf = (y: number) => Date.UTC(y, 0, 1) / 1000;
const range = (y: number) => `&numericFilters=${encodeURIComponent(`created_at_i>=${startOf(y)},created_at_i<${startOf(y + 1)}`)}`;
const storiesUrl = (name: string, y: number) => `${API}?query=${q(name)}&tags=story&hitsPerPage=3${range(y)}`;
const commentsUrl = (name: string, y: number) => `${API}?query=${q(name)}&tags=comment&hitsPerPage=0${range(y)}`;
const linkingUrl = (domain: string, y: number) =>
  `${API}?query=${q(domain)}&tags=story&hitsPerPage=0${range(y)}&restrictSearchableAttributes=url`;
const threadsUrl = (name: string) => `${API}?query=${q(name)}&tags=story&hitsPerPage=20`;

const body = (nbHits: number, hits: object[] = []) => JSON.stringify({ nbHits, hits });
const hit = (id: number, points: number, title = `Story ${id}`, url: string | null = null) => ({
  objectID: String(id),
  title,
  points,
  num_comments: id,
  created_at: "2024-05-06T07:08:09Z",
  url,
  author: "someone",
});

/** Routes for every year of `name`; story counts are year - 2000, comments year - 1000. */
function yearRoutes(name: string, years: number[], domain?: string): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const y of years) {
    routes[storiesUrl(name, y)] = body(y - 2000, [hit(y, 5, `${name} in ${y}`)]);
    routes[commentsUrl(name, y)] = body(y - 1000);
    if (domain) routes[linkingUrl(domain, y)] = body(y - 2020);
  }
  return routes;
}
const ALL = [2021, 2022, 2023, 2024, 2025, 2026];

async function deps(fetch: FakeFetch, now: () => number = () => NOW): Promise<ToolDeps> {
  return {
    fetch,
    archive: async () => {
      throw new Error("hacker_news_mentions must not use the archive");
    },
    cache: await caches.open(`hn-${crypto.randomUUID()}`),
    now,
    subrequests: new Subrequests(45),
  };
}

const schema = z.object(hnOutput);

async function call(
  input: HnInput,
  routes: Record<string, Route>,
  opts: { now?: () => number; maxFetches?: number } = {},
): Promise<{ result: HnResult; fetch: FakeFetch }> {
  const fetch = fakeFetch(routes);
  const result = await hackerNewsMentions(input, await deps(fetch, opts.now), { maxFetches: opts.maxFetches });
  expect(() => schema.parse(result)).not.toThrow();
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_CAP_CHARS);
  return { result, fetch };
}

describe("hacker_news_mentions", () => {
  it("defaults to 6 calendar years ending this year", async () => {
    const { result, fetch } = await call({ query: "Hightouch" }, { ...yearRoutes("Hightouch", ALL), [threadsUrl("Hightouch")]: body(1, []) });
    expect(result.years?.map((y) => y.year)).toEqual(ALL);
    expect(result.notes).toContain("2026 is counted to date");
    expect(result.status).toBe("ok");
    expect(fetch.calls.some((u) => u.includes(`created_at_i%3E%3D${startOf(2020)}`))).toBe(false);
  });

  it("counts stories and comments per year with three sample titles", async () => {
    const routes = yearRoutes("Hightouch", ALL);
    routes[storiesUrl("Hightouch", 2024)] = body(
      30,
      [1, 2, 3, 4].map((i) => hit(i, i, `Title ${i}`)),
    );
    const { result, fetch } = await call({ query: "Hightouch" }, { ...routes, [threadsUrl("Hightouch")]: body(0) });
    const y2024 = result.years?.find((y) => y.year === 2024);
    expect(y2024).toMatchObject({ year: 2024, stories: 30, comments: 1024 });
    expect(y2024?.sample_titles).toEqual(["Title 1", "Title 2", "Title 3"]);
    expect(y2024?.stories_linking_domain).toBeUndefined();
    expect(fetch.calls).toHaveLength(ALL.length * 2 + 1); // 2 per year, then the top threads
  });

  it("domain adds stories linking the site", async () => {
    const { result, fetch } = await call(
      { query: "Hightouch", domain: "https://www.hightouch.com/pricing", years: 2 },
      { ...yearRoutes("Hightouch", [2025, 2026], "hightouch.com"), [threadsUrl("Hightouch")]: body(0) },
    );
    expect(result.years?.map((y) => y.stories_linking_domain)).toEqual([5, 6]);
    expect(fetch.calls).toHaveLength(2 * 3 + 1);
    expect(fetch.calls).toContain(linkingUrl("hightouch.com", 2025));
  });

  it("top threads are the 10 with the most points", async () => {
    const pool = Array.from({ length: 20 }, (_, i) => hit(100 + i, (i * 7) % 20, `Thread ${i}`, i % 2 ? `https://example.com/${i}` : null));
    const { result, fetch } = await call({ query: "Hightouch", years: 1 }, {
      ...yearRoutes("Hightouch", [2026]),
      [threadsUrl("Hightouch")]: body(20, pool),
    });
    const threads = result.top_threads ?? [];
    expect(threads).toHaveLength(10);
    expect(threads.map((t) => t.points)).toEqual([...threads.map((t) => t.points)].sort((a, b) => b - a));
    expect(Math.min(...threads.map((t) => t.points))).toBeGreaterThanOrEqual(10);
    expect(threads[0].hn_link).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=1\d\d$/);
    expect(threads[0]).toMatchObject({ date: "2024-05-06" });
    expect(threads.some((t) => t.story_link === null)).toBe(true);
    expect(threads.some((t) => t.story_link?.startsWith("https://example.com/"))).toBe(true);
    expect(fetch.calls.filter((u) => u === threadsUrl("Hightouch"))).toHaveLength(1);
  });

  it("each year carries a search_link", async () => {
    const { result } = await call({ query: "Hightouch", years: 1 }, { ...yearRoutes("Hightouch", [2026]), [threadsUrl("Hightouch")]: body(0) });
    expect(result.years?.[0].search_link).toBe(
      `https://hn.algolia.com/?dateRange=custom&dateStart=${startOf(2026)}&dateEnd=${startOf(2027)}&query=%22Hightouch%22&type=story`,
    );
  });

  it("a 429 midway returns the years done as partial", async () => {
    const routes = yearRoutes("Hightouch", ALL);
    routes[storiesUrl("Hightouch", 2024)] = { status: 429 };
    const { result, fetch } = await call({ query: "Hightouch" }, routes);
    expect(result.status).toBe("partial");
    expect(result.years?.map((y) => y.year)).toEqual([2021, 2022, 2023]);
    expect(result.notes.join(" ")).toContain("source_rate_limited");
    expect(result.notes.join(" ")).toContain("wait a few minutes before calling again");
    expect(result.top_threads).toBeUndefined();
    expect(fetch.calls).not.toContain(storiesUrl("Hightouch", 2025));
  });

  it("a 429 on the very first request is an error that says to wait", async () => {
    const { result } = await call({ query: "Hightouch" }, { [storiesUrl("Hightouch", 2021)]: { status: 429 } });
    expect(result.status).toBe("error");
    expect(result.error?.reason).toBe("source_rate_limited");
    expect(result.error?.detail).toContain("wait a few minutes before calling again");
  });

  it("returns an error when the very first request fails", async () => {
    const { result } = await call({ query: "Hightouch" }, { [storiesUrl("Hightouch", 2021)]: { status: 503 } });
    expect(result.status).toBe("error");
    expect(result.error?.reason).toBe("source_unavailable");
  });

  it("stops at the fetch budget and says so", async () => {
    const { result, fetch } = await call({ query: "Hightouch" }, yearRoutes("Hightouch", ALL), { maxFetches: 5 });
    expect(fetch.calls).toHaveLength(5);
    expect(result.status).toBe("partial");
    expect(result.years?.map((y) => y.year)).toEqual([2021, 2022]);
    expect(result.notes.join(" ")).toContain("fetch budget of 5 requests used up");
  });

  it("stops at the time limit", async () => {
    let t = NOW;
    const fetch = fakeFetch(yearRoutes("Hightouch", ALL));
    const d = await deps(fetch, () => t);
    const slow: ToolDeps = { ...d, fetch: (async (...a: Parameters<typeof fetch>) => { t += 30_000; return fetch(...a); }) as typeof fetch };
    const result = await hackerNewsMentions({ query: "Hightouch" }, slow);
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toContain("time limit of 25 s reached");
  });

  it("cuts a search still running at the hard deadline and returns the years done as partial", async () => {
    const fetch = hangingOn(fakeFetch(yearRoutes("Hightouch", ALL)), storiesUrl("Hightouch", 2023));
    const result = await hackerNewsMentions({ query: "Hightouch" }, await deps(fetch), { hardDeadlineMs: 50 });
    expect(schema.safeParse(result).error).toBeUndefined();
    expect(result.status).toBe("partial");
    expect(result.years?.map((y) => y.year)).toEqual([2021, 2022]);
    expect(result.notes.join(" ")).toMatch(/time limit of \d+ s reached, so the counts stop here/);
    expect(result.notes.join(" ")).not.toMatch(/connection failed|request failed/);
  });

  it("refuses a bad domain before any fetch", async () => {
    const { result, fetch } = await call({ query: "Example", domain: "127.0.0.1" }, {});
    expect(result.error?.reason).toBe("bad_input");
    expect(fetch.calls).toEqual([]);
  });

  it("caps titles at 200 characters", async () => {
    const routes = { ...yearRoutes("Hightouch", [2026]), [threadsUrl("Hightouch")]: body(1, [hit(1, 9, "x".repeat(500))]) };
    routes[storiesUrl("Hightouch", 2026)] = body(1, [hit(1, 9, "y".repeat(500))]);
    const { result } = await call({ query: "Hightouch", years: 1 }, routes);
    expect(result.years?.[0].sample_titles[0]).toHaveLength(200);
    expect(result.top_threads?.[0].title).toHaveLength(200);
  });

  it("returns no usernames", async () => {
    const authored = JSON.stringify({ nbHits: 5, hits: fixture.hits.map((h) => ({ ...h })) });
    const routes: Record<string, Route> = {};
    for (const y of ALL) {
      routes[storiesUrl("Hightouch", y)] = authored;
      routes[commentsUrl("Hightouch", y)] = authored;
    }
    routes[threadsUrl("Hightouch")] = authored;
    const { result } = await call({ query: "Hightouch" }, routes);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(result);
    expect(keys).not.toContain("author");
    expect(JSON.stringify(result)).not.toContain("user1");
    expect(result.top_threads).toHaveLength(5);
  });

  it("keeps a year's counts when only its domain search fails, and says the domain count is missing", async () => {
    const routes = { ...yearRoutes("Hightouch", [2025, 2026], "hightouch.com"), [threadsUrl("Hightouch")]: body(0) };
    routes[linkingUrl("hightouch.com", 2026)] = { status: 503 };
    const { result } = await call({ query: "Hightouch", domain: "hightouch.com", years: 2 }, routes);
    expect(result.status).toBe("partial");
    expect(result.years?.map((y) => [y.year, y.stories, y.comments, y.stories_linking_domain])).toEqual([
      [2025, 25, 1025, 5],
      [2026, 26, 1026, undefined],
    ]);
    expect(result.years?.[1]).not.toHaveProperty("stories_linking_domain");
    expect(result.notes.join(" ")).toContain("so stories_linking_domain is missing for 2026");
  });
});

describe("hacker_news_mentions: subrequests on a cold cache", () => {
  const span = (n: number) => Array.from({ length: n }, (_, i) => 2026 - n + 1 + i);

  /** Deps as makeDeps builds them (a 45-subrequest counter), over a meter that counts what reaches the network and cache. */
  async function metered(routes: Record<string, Route>, cache?: Cache) {
    const m = meter(fakeFetch(routes), cache ?? (await caches.open(`hn-${crypto.randomUUID()}`)));
    const noArchive = async () => {
      throw new Error("hacker_news_mentions must not use the archive");
    };
    return { m, deps: callDeps({ fetch: m.fetch, cache: m.cache, archive: noArchive, now: () => NOW }, 45, "test") };
  }

  it("six years with a domain take 33: per year a read, three searches and a write, then the threads", async () => {
    const { m, deps } = await metered({ ...yearRoutes("Hightouch", ALL, "hightouch.com"), [threadsUrl("Hightouch")]: body(0) });
    const result = await hackerNewsMentions({ query: "Hightouch", domain: "hightouch.com" }, deps);
    expect(result.status).toBe("ok");
    expect(result.years?.map((y) => y.stories_linking_domain)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(m.total()).toBe(33);
  });

  it("ten years without a domain take 43", async () => {
    const { m, deps } = await metered({ ...yearRoutes("Hightouch", span(10)), [threadsUrl("Hightouch")]: body(0) });
    const result = await hackerNewsMentions({ query: "Hightouch", years: 10 }, deps);
    expect(result.status).toBe("ok");
    expect(result.years).toHaveLength(10);
    expect(m.total()).toBe(43);
  });

  it("ten years with a domain stop at the limit of 45 with the years done, and say to call again", async () => {
    const { m, deps } = await metered({ ...yearRoutes("Hightouch", span(10), "hightouch.com"), [threadsUrl("Hightouch")]: body(0) });
    const result = await hackerNewsMentions({ query: "Hightouch", domain: "hightouch.com", years: 10 }, deps);
    expect(m.total()).toBeLessThanOrEqual(45);
    expect(result.status).toBe("partial");
    expect(result.years?.map((y) => y.year)).toEqual(span(10).slice(0, 9));
    const note = result.notes.find((n) => n.includes("per-request limit of 45 subrequests"));
    expect(note).toContain("call again with the same input to continue");
    expect(note).toContain("cached");
    expect(result.notes.join(" ")).not.toMatch(/connection failed|599/);
  });

  it("a repeat call reads each year from one cache entry", async () => {
    const cache = await caches.open(`hn-${crypto.randomUUID()}`);
    const routes = { ...yearRoutes("Hightouch", ALL, "hightouch.com"), [threadsUrl("Hightouch")]: body(0) };
    await hackerNewsMentions({ query: "Hightouch", domain: "hightouch.com" }, (await metered(routes, cache)).deps);
    const again = await metered(routes, cache);
    const result = await hackerNewsMentions({ query: "Hightouch", domain: "hightouch.com" }, again.deps);
    expect(result.status).toBe("ok");
    expect(again.m.counts).toEqual({ fetch: 0, cache: 7 }); // six years and the threads, one read each
  });
});
