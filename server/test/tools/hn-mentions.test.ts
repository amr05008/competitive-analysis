import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RESPONSE_CAP_CHARS } from "../../src/config";
import { hnOutput, type HnInput, type HnResult } from "../../src/contract/tools";
import { render, type ToolDeps } from "../../src/tools";
import { hackerNewsMentions, renderHn } from "../../src/tools/hn-mentions";
import { fakeFetch, type FakeFetch, type Route } from "../helpers/fake-fetch";
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
    expect(result.top_threads).toBeUndefined();
    expect(fetch.calls).not.toContain(storiesUrl("Hightouch", 2025));
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

  it("renders the notes right after the header, then years and threads", async () => {
    const { result } = await call({ query: "Hightouch", years: 1 }, {
      ...yearRoutes("Hightouch", [2026]),
      [threadsUrl("Hightouch")]: body(1, [hit(7, 9, "A thread", "https://example.com/a")]),
    });
    const lines = render("hacker_news_mentions", result).split("\n");
    expect(lines[0]).toBe('Hacker News mentions of "Hightouch" (ok)');
    expect(lines[1]).toBe("note: 2026 is counted to date");
    expect(lines[2]).toContain("2026: 26 stories, 1026 comments");
    expect(lines[2]).toContain("https://hn.algolia.com/?dateRange=custom");
    expect(lines).toContain("- A thread (9 points, 7 comments, 2024-05-06) https://news.ycombinator.com/item?id=7");
  });

  it("renders an error with the fallback line", () => {
    const text = renderHn({
      status: "error",
      notes: [],
      retrieved_at: "2026-10-20",
      error: { reason: "bad_input", detail: "nope", tried: [], fallback: "fall back to browsing for this check." },
    });
    expect(text).toBe("hacker_news_mentions failed (bad_input): nope. fall back to browsing for this check.");
  });
});
