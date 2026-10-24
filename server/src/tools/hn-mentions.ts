import { HN_DEADLINE_MS, HN_MAX_FETCHES, MAX_THREADS, RESPONSE_CAP_CHARS } from "../config";
import { errorResult, utcDay } from "../contract/envelope";
import type { HnInput, HnResult } from "../contract/tools";
import { Budget } from "../shared/budget";
import { REFUSED_STATUS, type FailedOutcome, type Fetcher } from "../shared/http";
import { normalizeDomain } from "../shared/inputs";
import { limitReached } from "../shared/subrequests";
import { phrase, searchHn, searchYear, type HnHit } from "../sources/hn";
import type { ToolDeps } from ".";

type Year = NonNullable<HnResult["years"]>[number];
type Thread = NonNullable<HnResult["top_threads"]>[number];

const DEFAULT_YEARS = 6;
const SAMPLE_TITLES = 3;
const THREAD_POOL = 20;
const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 200;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const yearStart = (y: number) => Math.floor(Date.UTC(y, 0, 1) / 1000);

function searchLink(q: string, from: number, to: number): string {
  return `https://hn.algolia.com/?dateRange=custom&dateStart=${from}&dateEnd=${to}&query=${encodeURIComponent(phrase(q))}&type=story`;
}

export async function hackerNewsMentions(
  input: HnInput,
  deps: ToolDeps,
  opts: { maxFetches?: number; deadlineMs?: number; hardDeadlineMs?: number } = {},
): Promise<HnResult> {
  const maxFetches = opts.maxFetches ?? HN_MAX_FETCHES;
  const deadlineMs = opts.deadlineMs ?? HN_DEADLINE_MS;

  let site: string | undefined;
  if (input.domain !== undefined && input.domain.trim() !== "") {
    const d = normalizeDomain(input.domain);
    if (!d.ok) return errorResult("bad_input", d.detail, [], deps.now());
    site = d.domain;
  }
  // Double quotes mark the phrase, so any in the name are dropped.
  const query = input.query.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  if (query.length < 2) return errorResult("bad_input", "the name needs at least 2 characters besides quotes", [], deps.now());

  // Each search needs room for itself and the year's cache write. At the hard deadline, a search still running is cut.
  const budget = new Budget(maxFetches, deadlineMs, deps.now, {
    subrequests: deps.subrequests,
    reserve: 2,
    hardMs: opts.hardDeadlineMs,
  });
  const tried: string[] = [];
  /** Requests the gate, or the subrequest counter below it, declined to make. */
  let refusals = 0;
  const gate: Fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!budget.take()) {
      refusals++;
      return new Response(null, { status: REFUSED_STATUS });
    }
    tried.push(String(url));
    const res = await deps.fetch(url, { ...init, signal: budget.signal(init?.signal) });
    if (res.status === REFUSED_STATUS) refusals++;
    return res;
  }) as Fetcher;
  const stopNote = (what: string): string => {
    const again = "call again with the same input to continue, since searches already made are cached";
    switch (budget.stopKind ?? "time") {
      case "subrequests":
        return `${limitReached(deps.subrequests.limit)}, so ${what}; call again with the same input to continue, since results so far are cached`;
      case "fetches":
        return `fetch budget of ${maxFetches} requests used up, so ${what}; ${again}`;
      case "time":
        return `time limit of ${Math.round(budget.timeLimitMs / 1000)} s reached, so ${what}; ${again}`;
    }
  };
  const failText = (f: FailedOutcome) => `${f.reason}: ${clip(f.detail, MAX_DETAIL_CHARS)}`;
  const wait = (f: FailedOutcome) => (f.reason === "source_rate_limited" ? "; wait a few minutes before calling again" : "");

  const now = deps.now();
  const thisYear = new Date(now).getUTCFullYear();
  const count = input.years ?? DEFAULT_YEARS;
  const notes: string[] = [];

  // A year's searches stop the counts at the first one the budget refused or the hard deadline cut (limit), or that failed.
  type Stop = { kind: "limit" } | { kind: "failed"; failure: FailedOutcome };
  let stop: Stop | null = null;
  const years: Year[] = [];
  for (let y = thisYear - count + 1; y <= thisYear; y++) {
    if (budget.exhausted) {
      stop = { kind: "limit" };
      break;
    }
    const from = yearStart(y);
    const to = yearStart(y + 1);
    const before = refusals;
    const r = await searchYear(gate, deps.cache, { query, site, fromTs: from, toTs: to, sampleTitles: SAMPLE_TITLES });
    const refused = refusals > before || budget.cut;
    if (!r.ok) {
      stop = refused ? { kind: "limit" } : { kind: "failed", failure: r };
      break;
    }
    years.push({
      year: y,
      stories: r.counts.stories.count,
      comments: r.counts.comments,
      ...(r.counts.linking === null ? {} : { stories_linking_domain: r.counts.linking }),
      sample_titles: r.counts.stories.hits.map((h) => clip(h.title, MAX_TITLE_CHARS)),
      search_link: searchLink(query, from, to),
    });
    if (r.linkingFailure) {
      // Only the domain search failed: the year's counts stand, without the linking count.
      const why = refused ? "was not made" : `failed (${failText(r.linkingFailure)})`;
      notes.push(`the domain search for ${y} ${why}, so stories_linking_domain is missing for ${y}`);
      stop = refused ? { kind: "limit" } : { kind: "failed", failure: r.linkingFailure };
      break;
    }
  }

  if (stop?.kind === "failed" && years.length === 0) {
    return errorResult(stop.failure.reason, `${stop.failure.detail}${wait(stop.failure)}`, tried, deps.now());
  }

  if (stop) {
    const done = years.length ? `years ${years[0].year} to ${years[years.length - 1].year} are shown` : "no year was counted";
    if (stop.kind === "limit") notes.push(stopNote(`the counts stop here (${done})`));
    else notes.push(`a request failed (${failText(stop.failure)}), so the counts stop here (${done})${wait(stop.failure)}`);
  }
  if (years.some((y) => y.year === thisYear)) notes.push(`${thisYear} is counted to date`);

  // Top threads: one search over all years, the most points first.
  let threads: Thread[] | undefined;
  if (!stop) {
    if (budget.exhausted) notes.push(stopNote("the top threads were not checked"));
    else {
      const before = refusals;
      const r = await searchHn(gate, deps.cache, { query, tags: "story", hitsPerPage: THREAD_POOL });
      if (r.ok) {
        const ranked: HnHit[] = r.hits
          .map((h, i) => ({ h, i }))
          .sort((a, b) => b.h.points - a.h.points || a.i - b.i)
          .map((x) => x.h);
        threads = ranked.slice(0, MAX_THREADS).map((h) => ({
          title: clip(h.title, MAX_TITLE_CHARS),
          points: h.points,
          comments: h.numComments,
          date: h.createdAt.slice(0, 10),
          hn_link: `https://news.ycombinator.com/item?id=${h.id}`,
          story_link: h.url,
        }));
      } else if (refusals > before || budget.cut) notes.push(stopNote("the top threads were not checked"));
      else notes.push(`the top threads could not be fetched (${failText(r)})${wait(r)}`);
    }
  } else notes.push("the top threads were not checked");

  const partial = stop !== null || threads === undefined;
  const assemble = (titles: number, threadCount: number): HnResult => ({
    status: partial ? "partial" : "ok",
    notes: titles < SAMPLE_TITLES || (threads && threadCount < threads.length) ? [...notes, "lists are shortened to fit the response size"] : notes,
    retrieved_at: utcDay(deps.now()),
    query,
    years: years.map((y) => ({ ...y, sample_titles: y.sample_titles.slice(0, titles) })),
    ...(threads ? { top_threads: threads.slice(0, threadCount) } : {}),
  });
  const fits = (r: HnResult) => JSON.stringify(r).length <= RESPONSE_CAP_CHARS;
  let result = assemble(SAMPLE_TITLES, MAX_THREADS);
  for (let t = SAMPLE_TITLES - 1; !fits(result) && t >= 0; t--) result = assemble(t, MAX_THREADS);
  for (let n = MAX_THREADS - 1; !fits(result) && n >= 0; n--) result = assemble(0, n);
  return result;
}

// --------------------------------------------------------------- rendering

/** The short text that goes with a hacker_news_mentions result: a header, the notes, a line per year, then the top threads. */
export function renderHn(r: HnResult): string {
  if (r.status === "error") {
    const e = r.error;
    return e
      ? `hacker_news_mentions failed (${e.reason}): ${e.detail}. ${e.fallback}`
      : "hacker_news_mentions failed. fall back to browsing for this check.";
  }
  const lines = [`Hacker News mentions of "${r.query ?? ""}" (${r.status})`, ...r.notes.map((n) => `note: ${n}`)];
  for (const y of r.years ?? []) {
    const linking = y.stories_linking_domain === undefined ? "" : `, ${y.stories_linking_domain} linking the site`;
    const titles = y.sample_titles.length ? `; e.g. ${y.sample_titles.map((t) => `"${t}"`).join("; ")}` : "";
    lines.push(`${y.year}: ${y.stories} stories, ${y.comments} comments${linking}${titles} ${y.search_link}`);
  }
  if (r.top_threads?.length) {
    lines.push("Top threads:");
    for (const t of r.top_threads) lines.push(`- ${t.title} (${t.points} points, ${t.comments} comments, ${t.date}) ${t.hn_link}`);
  }
  return lines.join("\n");
}
