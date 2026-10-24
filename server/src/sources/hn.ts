import { TTL_HN } from "../config";
import { cached } from "../shared/cache";
import { politeFetch, type FailedOutcome, type Fetcher } from "../shared/http";

/** One Hacker News item. There is no author field: usernames are never read. */
export type HnHit = {
  title: string;
  points: number;
  numComments: number;
  createdAt: string;
  id: string;
  url: string | null;
};

export type HnSearch = {
  query: string;
  tags: "story" | "comment";
  fromTs?: number;
  toTs?: number;
  urlOnly?: boolean;
  hitsPerPage: number;
};

type Found = { count: number; hits: HnHit[] };

/** One calendar year's searches, cached together: stories with sample hits, comments, and stories linking the site. */
export type YearCounts = { stories: Found; comments: number; linking: number | null };

const API = "https://hn.algolia.com/api/v1/search";
const MAX_BYTES = 1_000_000;
/** Starts every cache key; bump the version when a cached shape changes, so old entries are never read. */
const KEY = "hn:v1";

/** The exact phrase, in double quotes. */
export const phrase = (q: string): string => `"${q}"`;

export function searchUrl(p: HnSearch): string {
  let url = `${API}?query=${encodeURIComponent(phrase(p.query))}&tags=${p.tags}&hitsPerPage=${p.hitsPerPage}`;
  const filters: string[] = [];
  if (p.fromTs !== undefined) filters.push(`created_at_i>=${p.fromTs}`);
  if (p.toTs !== undefined) filters.push(`created_at_i<${p.toTs}`);
  if (filters.length) url += `&numericFilters=${encodeURIComponent(filters.join(","))}`;
  if (p.urlOnly) url += "&restrictSearchableAttributes=url";
  return url;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parse(text: string): Found | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { nbHits, hits } = body as { nbHits?: unknown; hits?: unknown };
  if (typeof nbHits !== "number" || !Number.isFinite(nbHits) || !Array.isArray(hits)) return null;
  const out: HnHit[] = [];
  for (const h of hits) {
    if (typeof h !== "object" || h === null) continue;
    const r = h as Record<string, unknown>;
    const id = str(r.objectID);
    if (id === null) continue;
    out.push({
      title: str(r.title) ?? "",
      points: num(r.points),
      numComments: num(r.num_comments),
      createdAt: str(r.created_at) ?? "",
      id,
      url: str(r.url) || null,
    });
  }
  return { count: nbHits, hits: out };
}

/** One Algolia search of Hacker News, uncached. Failures come back as values. */
async function search(fetcher: Fetcher, p: HnSearch): Promise<({ ok: true } & Found) | FailedOutcome> {
  const url = searchUrl(p);
  const r = await politeFetch(fetcher, url, { maxBytes: MAX_BYTES, accept: "application/json" });
  if (!r.ok) return r;
  const found = parse(r.text);
  return found
    ? { ok: true, ...found }
    : { ok: false, reason: "source_unavailable", url, detail: "unexpected response from Hacker News search" };
}

/** One Algolia search of Hacker News; cached by address. Failures come back as values. */
export async function searchHn(
  fetcher: Fetcher,
  cache: Cache,
  p: HnSearch,
): Promise<({ ok: true } & Found) | FailedOutcome> {
  const url = searchUrl(p);
  let failure: FailedOutcome | null = null;
  const { value } = await cached<Found>(cache, `${KEY}:search:${url}`, TTL_HN, async () => {
    const r = await search(fetcher, p);
    if (!r.ok) {
      failure = r;
      return null;
    }
    return { count: r.count, hits: r.hits };
  });
  if (value) return { ok: true, ...value };
  return (
    failure ?? { ok: false, reason: "source_unavailable", url, detail: "Hacker News search gave no answer" }
  );
}

/**
 * One calendar year's searches for a name: its stories (with `sampleTitles` hits) and comments, and,
 * with a site, the stories linking to it. They are cached as one entry, so a cached year costs one cache
 * read. Only a complete year is cached. When every search but the site's succeeds, the year comes back
 * with `linking: null` and the site's failure in `linkingFailure`.
 */
export async function searchYear(
  fetcher: Fetcher,
  cache: Cache,
  p: { query: string; site?: string; fromTs: number; toTs: number; sampleTitles: number },
): Promise<{ ok: true; counts: YearCounts; linkingFailure?: FailedOutcome } | FailedOutcome> {
  const range = { fromTs: p.fromTs, toTs: p.toTs };
  const out: { failure?: FailedOutcome; partial?: { counts: YearCounts; linkingFailure: FailedOutcome } } = {};
  const key = `${KEY}:year:${JSON.stringify([p.query, p.site ?? null, p.fromTs, p.toTs, p.sampleTitles])}`;
  const { value } = await cached<YearCounts>(cache, key, TTL_HN, async () => {
    const stories = await search(fetcher, { query: p.query, tags: "story", hitsPerPage: p.sampleTitles, ...range });
    if (!stories.ok) {
      out.failure = stories;
      return null;
    }
    const comments = await search(fetcher, { query: p.query, tags: "comment", hitsPerPage: 0, ...range });
    if (!comments.ok) {
      out.failure = comments;
      return null;
    }
    const counts: YearCounts = { stories: { count: stories.count, hits: stories.hits }, comments: comments.count, linking: null };
    if (p.site === undefined) return counts;
    const linking = await search(fetcher, { query: p.site, tags: "story", hitsPerPage: 0, urlOnly: true, ...range });
    if (!linking.ok) {
      out.partial = { counts, linkingFailure: linking };
      return null;
    }
    return { ...counts, linking: linking.count };
  });
  if (value) return { ok: true, counts: value };
  if (out.partial) return { ok: true, ...out.partial };
  return (
    out.failure ?? {
      ok: false,
      reason: "source_unavailable",
      url: searchUrl({ query: p.query, tags: "story", hitsPerPage: p.sampleTitles, ...range }),
      detail: "Hacker News search gave no answer",
    }
  );
}
