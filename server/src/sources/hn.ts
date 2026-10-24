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

const API = "https://hn.algolia.com/api/v1/search";
const MAX_BYTES = 1_000_000;

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

/** One Algolia search of Hacker News; cached by address. Failures come back as values. */
export async function searchHn(
  fetcher: Fetcher,
  cache: Cache,
  p: HnSearch,
): Promise<({ ok: true } & Found) | FailedOutcome> {
  const url = searchUrl(p);
  let failure: FailedOutcome | null = null;
  const { value } = await cached<Found>(cache, url, TTL_HN, async () => {
    const r = await politeFetch(fetcher, url, { maxBytes: MAX_BYTES, accept: "application/json" });
    if (!r.ok) {
      failure = r;
      return null;
    }
    const found = parse(r.text);
    if (!found) {
      failure = { ok: false, reason: "source_unavailable", url, detail: "unexpected response from Hacker News search" };
      return null;
    }
    return found;
  });
  if (value) return { ok: true, ...value };
  return (
    failure ?? { ok: false, reason: "source_unavailable", url, detail: "Hacker News search gave no answer" }
  );
}
