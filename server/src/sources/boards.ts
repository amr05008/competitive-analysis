import { BOARD_MAX_BYTES, PAY_TEXT_MAX_CHARS, ROLE_DESCRIPTION_MAX_CHARS, TTL_BOARD } from "../config";
import { utcDay } from "../contract/envelope";
import type { ErrorReason } from "../contract/envelope";
import type { Ats } from "../contract/tools";
import { cached } from "../shared/cache";
import { politeFetch, type FailedOutcome, type Fetcher } from "../shared/http";
import { cleanCompanyName } from "../shared/inputs";

export type RawRole = {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  date: string | null;
  dateKind: "posted" | "updated";
  pay: string | null;
  link: string;
  /** Plain text, capped. Only Ashby and Lever list it; a Greenhouse description is a separate request. */
  description?: string;
  /** The pay the whole description states, when `pay` is null. Only Ashby and Lever list it. */
  payText?: string;
};

export type Board =
  | { kind: "found"; ats: Ats; slug: string; /** The board's public page. */ url: string; /** The address that listed the roles. */ apiUrl: string; roles: RawRole[]; /** Set when Greenhouse's departments lookup failed: the roles have no departments, and the read is never cached. */ departmentsError?: { reason: ErrorReason; detail: string } }
  | { kind: "absent"; url: string }
  | { kind: "error"; url: string; reason: ErrorReason; detail: string };

// ------------------------------------------------------------------- text

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
// Parts are bounded, so a long run with no spaces stays linear.
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}/g;

const scrub = (s: string) => s.replace(EMAIL, "[email removed]").replace(PHONE, "[phone removed]");
const clip = (s: string) => (s.length > ROLE_DESCRIPTION_MAX_CHARS ? s.slice(0, ROLE_DESCRIPTION_MAX_CHARS) : s);

// ------------------------------------------------------------------- pay in the text

const CODES = "USD|EUR|GBP|CAD|AUD|CHF|SGD|INR|JPY";
// Digits are bounded, so a long run like "1.1.1…" stays linear.
const NUM = "\\d[\\d,.]{0,20}";
/** A figure with its currency before it ($150,000, GBP 50,000, $2M) or after it (65.000 €). */
const MONEY = new RegExp(`[$€£₹]\\s?${NUM}\\s?[kKmM]?\\b|\\b(?:${CODES})\\s?${NUM}\\s?[kKmM]?\\b|\\b${NUM}\\s?(?:€|£|EUR|GBP|USD|CHF)(?![A-Za-z])`, "g");
/** The second figure of a range, right after the first. */
const RANGE_NEXT = new RegExp(`^[^\\S]*(?:-|–|—|to)\\s*(?:[$€£₹]|(?:${CODES})\\s?)?\\d`);
const PAY_LABEL =
  /\b(?:salary|salaries|compensation|remuneration|earnings|OTE|wages?|hourly|base (?:pay|salary|compensation|range)|starting base|pay (?:range|rate|band|scale)|pays|pay\s*:|(?:the|your) pay (?:is|for this (?:role|position)))(?![A-Za-z])/i;
/** Right after a figure: pay by the hour. */
const PER_HOUR = /^\s?(?:\/\s?(?:hr|hour)|per hour|an hour|hourly)\b/i;
const RANGE_WORD = /\b(?:ranges?|rate)\b/i;
/** Figures in the same clause as these words are perks, targets or company numbers, never pay. */
const NOT_PAY = /\b(?:stipends?|budgets?|allowances?|reimburs\w*|quotas?|401\(?k|raised|funding|valuation|revenue|ARR|book of business|deal sizes?|territor(?:y|ies)|pipeline)\b/i;
/** Where a clause ends, for NOT_PAY: punctuation, "plus", or a slash. */
const CLAUSE_BREAK = /[,;.!?]\s|\splus\s|\s\/\s/g;
const MAX_PAY_SNIPPETS = 4;

type Span = { a: number; b: number; score: number };

/** `lo` moved forward to the start of a whole word, but not past `max`. */
const wordStart = (t: string, lo: number, max: number) => {
  if (lo === 0 || /\s/.test(t[lo - 1])) return lo;
  const m = /\s/.exec(t.slice(lo, max));
  return m ? lo + m.index + 1 : max;
};
/** `hi` moved back to the end of a whole word, but not before `min`. */
const wordEnd = (t: string, min: number, hi: number) => {
  if (hi >= t.length || /\s/.test(t[hi])) return hi;
  const k = t.lastIndexOf(" ", hi);
  return k > min ? k : hi;
};

/** The clause around a figure: back to the previous clause break or figure, forward to the next, within a few words. */
function clauseAround(text: string, f: { i: number; end: number }, prevEnd: number, nextStart: number): string {
  const back = Math.max(prevEnd, f.i - 40);
  let lo = back;
  for (const m of text.slice(back, f.i).matchAll(CLAUSE_BREAK)) lo = back + m.index + m[0].length;
  let hi = Math.min(nextStart, f.end + 60);
  const brk = text.slice(f.end, hi).search(CLAUSE_BREAK);
  if (brk >= 0) hi = f.end + brk;
  return text.slice(lo, hi);
}

/**
 * What a posting's text says about pay, for a board whose pay field is empty.
 * A figure is pay when a pay word comes before it (close, or further back for a
 * range or a list that continues one), or it's paid by the hour, and no perk,
 * target or company-figure word shares its clause. A sentence up to
 * PAY_TEXT_MAX_CHARS is kept whole; in a longer run the words around the pay
 * figures are kept, cut only at spaces or after a whole figure, and never past
 * a figure that isn't pay. At most four pieces, the strongest, in the posting's
 * order. Each step is one pass, so the cost stays linear in the text.
 */
function payFromText(text: string): string | undefined {
  const starts = [0];
  for (const m of text.matchAll(/(?<=[.!?])\s+(?=[A-Z(])/g)) starts.push(m.index + m[0].length);
  const sentenceOf = (i: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return { s: starts[lo], e: lo + 1 < starts.length ? starts[lo + 1] : text.length };
  };

  const figures = [...text.matchAll(MONEY)].map((m) => ({ i: m.index, end: m.index + m[0].length }));
  const pay: { i: number; end: number; n: number; score: number }[] = [];
  const isPay = figures.map(() => false);
  let lastPayEnd = -Infinity;
  figures.forEach((f, n) => {
    const prev = figures[n - 1];
    const next = figures[n + 1];
    if (NOT_PAY.test(clauseAround(text, f, prev ? prev.end : 0, next ? next.i : text.length))) return;
    const label = PAY_LABEL.test(text.slice(Math.max(0, f.i - 120), f.end + 40)) || PER_HOUR.test(text.slice(f.end, f.end + 12)) ? 2 : PAY_LABEL.test(text.slice(Math.max(0, f.i - 300), f.i)) ? 1 : 0;
    const continues = f.i - lastPayEnd <= 120;
    if (!label && !continues) return;
    const inRange = RANGE_NEXT.test(text.slice(f.end, f.end + 12)) || (prev !== undefined && RANGE_NEXT.test(text.slice(prev.end, f.end)));
    const score = label + (inRange ? 1 : 0) + (RANGE_WORD.test(text.slice(Math.max(0, f.i - 60), f.i)) ? 1 : 0) + (continues ? 1 : 0);
    if (score < 2) return;
    // Past 3 a figure is no surer to be pay, so the ranking of pieces stops counting there.
    pay.push({ ...f, n, score: Math.min(score, 3) });
    isPay[n] = true;
    lastPayEnd = f.end;
  });
  if (!pay.length) return undefined;

  // The nearest figure that isn't pay on each side of every figure, in one pass each way.
  const nonPayBefore: ({ i: number; end: number } | undefined)[] = [];
  const nonPayAfter: ({ i: number; end: number } | undefined)[] = [];
  let seen: { i: number; end: number } | undefined;
  figures.forEach((f, n) => {
    nonPayBefore[n] = seen;
    if (!isPay[n]) seen = f;
  });
  seen = undefined;
  for (let n = figures.length - 1; n >= 0; n--) {
    nonPayAfter[n] = seen;
    if (!isPay[n]) seen = figures[n];
  }

  // Each pay figure's piece: its sentence when short, else the words around it, stopping at other figures.
  const spans: Span[] = pay.map((f) => {
    const { s, e } = sentenceOf(f.i);
    if (e - s <= PAY_TEXT_MAX_CHARS) return { a: s, b: e, score: f.score };
    const before = nonPayBefore[f.n];
    const after = nonPayAfter[f.n];
    const lo = Math.max(s, f.i - 120, before ? before.end : 0);
    const hi = Math.min(e, f.end + 80, after ? after.i : e);
    return { a: wordStart(text, lo, f.i), b: wordEnd(text, f.end, hi), score: f.score };
  });
  const merged: Span[] = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp.a < last.b) {
      last.b = Math.max(last.b, sp.b);
      last.score = Math.max(last.score, sp.score);
    } else merged.push({ ...sp });
  }

  const kept = [...merged]
    .sort((x, y) => y.score - x.score || x.a - y.a)
    .slice(0, MAX_PAY_SNIPPETS)
    .sort((x, y) => x.a - y.a);
  return kept
    .map(({ a, b }) => {
      const { s, e } = sentenceOf(a);
      let end = b;
      if (b - a > PAY_TEXT_MAX_CHARS * 2) {
        // Cut after the last whole pay figure that fits and doesn't open a range.
        const whole = pay.filter((f) => f.i >= a && f.end - a <= PAY_TEXT_MAX_CHARS * 2 && !RANGE_NEXT.test(text.slice(f.end, f.end + 12)));
        end = whole.length ? whole[whole.length - 1].end : a + text.slice(a, a + PAY_TEXT_MAX_CHARS * 2).lastIndexOf(" ");
      }
      const piece = text.slice(a, end).trim();
      const cut = end < e && text.slice(end, e).trim() !== "";
      return `${a > s ? "…" : ""}${piece}${cut ? "…" : ""}`;
    })
    .join(" ");
}

/** The pay a posting's whole text states, for a role whose pay field is empty; the text is already scrubbed. */
const payTextFor = (pay: string | null, clean: string) => (pay === null ? payFromText(clean) : undefined);

/** HTML, possibly escaped, as plain text: entities decoded, tags stripped, whitespace collapsed. */
export function htmlToText(html: string): string {
  const once = decodeEntities(html);
  const stripped = once.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(stripped));
}

// ------------------------------------------------------------------- slugs

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** The name before the public suffix: "acme.io" and "careers.acme.co.uk" both give "acme". */
function domainLabel(domain: string): string {
  const parts = domain.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2])) {
    return parts[parts.length - 3];
  }
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The board names to try, best first: the name run together, the domain's name, the name hyphenated. */
export function slugCandidates(domain: string, companyName?: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (VALID_SLUG.test(s) && !out.includes(s)) out.push(s);
  };
  const name = companyName ? cleanCompanyName(companyName).toLowerCase() : "";
  const alnum = name.replace(/[^a-z0-9]+/g, "");
  const hyphen = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  add(alnum);
  add(domainLabel(domain));
  add(hyphen);
  return out;
}

// ------------------------------------------------------------------- shapes

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A timestamp (ISO text or milliseconds) as a UTC YYYY-MM-DD, or null. */
function day(v: unknown): string | null {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? utcDay(ms) : null;
}

const money = (n: number) => Math.round(n).toLocaleString("en-US");

function range(currency: unknown, min: unknown, max: unknown, interval?: string | null): string | null {
  if (typeof min !== "number" || typeof max !== "number") return null;
  const unit = typeof currency === "string" && currency ? `${currency} ` : "";
  return `${unit}${money(min)}–${money(max)}${interval ? ` ${interval}` : ""}`;
}

function leverInterval(v: unknown): string | null {
  const m = typeof v === "string" ? /^per-(\w+)/.exec(v) : null;
  return m ? `per ${m[1]}` : null;
}

function greenhousePay(ranges: unknown): string | null {
  if (!Array.isArray(ranges)) return null;
  const parts = ranges
    .filter(isObj)
    .map((r) =>
      range(r.currency_type, typeof r.min_cents === "number" ? r.min_cents / 100 : null, typeof r.max_cents === "number" ? r.max_cents / 100 : null),
    )
    .filter((p): p is string => p !== null);
  return parts.length ? parts.join("; ") : null;
}

// ------------------------------------------------------------------- fetch

const GH_API = "https://boards-api.greenhouse.io/v1/boards";
/** Starts every cache key; bump the version when a cached shape changes, so old entries are never read. */
const KEY = "boards:v2";

function apiUrl(ats: Ats, slug: string): string {
  const s = encodeURIComponent(slug);
  if (ats === "greenhouse") return `${GH_API}/${s}/jobs`;
  if (ats === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`;
  return `https://api.lever.co/v0/postings/${s}?mode=json`;
}

function boardUrl(ats: Ats, slug: string): string {
  const s = encodeURIComponent(slug);
  if (ats === "greenhouse") return `https://job-boards.greenhouse.io/${s}`;
  if (ats === "ashby") return `https://jobs.ashbyhq.com/${s}`;
  return `https://jobs.lever.co/${s}`;
}

async function getJson(fetcher: Fetcher, url: string): Promise<{ ok: true; data: unknown } | FailedOutcome> {
  const r = await politeFetch(fetcher, url, { maxBytes: BOARD_MAX_BYTES, accept: "application/json" });
  if (!r.ok) return r;
  if (r.truncated) return { ok: false, reason: "source_unavailable", url, detail: "the board is too large to read" };
  try {
    return { ok: true, data: JSON.parse(r.text) };
  } catch {
    return { ok: false, reason: "source_unavailable", url, detail: "unexpected response (not JSON)" };
  }
}

const unexpected = (url: string): FailedOutcome => ({ ok: false, reason: "source_unavailable", url, detail: "unexpected response shape" });

function greenhouseRoles(jobs: unknown[], departments: Map<string, string>): RawRole[] {
  return jobs.filter(isObj).flatMap((j) => {
    const id = j.id === undefined || j.id === null ? null : String(j.id);
    const title = str(j.title);
    const link = str(j.absolute_url);
    if (!id || !title || !link) return [];
    const published = day(j.first_published);
    return [
      {
        id,
        title,
        department: departments.get(id) ?? null,
        location: isObj(j.location) ? str(j.location.name) : null,
        date: published ?? day(j.updated_at),
        dateKind: published ? "posted" : "updated",
        pay: null,
        link,
      } satisfies RawRole,
    ];
  });
}

function ashbyRoles(jobs: unknown[]): RawRole[] {
  return jobs.filter(isObj).flatMap((j) => {
    const id = str(j.id);
    const title = str(j.title);
    const link = str(j.jobUrl);
    if (!id || !title || !link || j.isListed !== true) return [];
    const comp = isObj(j.compensation) ? str(j.compensation.compensationTierSummary) : null;
    const description = str(j.descriptionPlain);
    const clean = description ? scrub(collapse(description)) : null;
    const pay = j.shouldDisplayCompensationOnJobPostings === true ? comp : null;
    const payText = clean ? payTextFor(pay, clean) : undefined;
    return [
      {
        id,
        title,
        department: str(j.department) ?? str(j.team),
        location: str(j.location),
        date: day(j.publishedAt),
        dateKind: "posted",
        pay,
        link,
        ...(clean ? { description: clip(clean) } : {}),
        ...(payText ? { payText } : {}),
      } satisfies RawRole,
    ];
  });
}

function leverDescription(p: Json): string | null {
  const lists = Array.isArray(p.lists)
    ? p.lists.filter(isObj).map((l) => [str(l.text), typeof l.content === "string" ? htmlToText(l.content) : null].filter(Boolean).join(": "))
    : [];
  const text = collapse([str(p.descriptionPlain), ...lists, str(p.additionalPlain)].filter(Boolean).join(" "));
  return text || null;
}

function leverRoles(postings: unknown[]): RawRole[] {
  return postings.filter(isObj).flatMap((p) => {
    const id = str(p.id);
    const title = str(p.text);
    const link = str(p.hostedUrl);
    if (!id || !title || !link) return [];
    const cats = isObj(p.categories) ? p.categories : {};
    const sr = isObj(p.salaryRange) ? p.salaryRange : null;
    const description = leverDescription(p);
    const clean = description ? scrub(description) : null;
    const pay = sr ? range(sr.currency, sr.min, sr.max, leverInterval(sr.interval)) : null;
    const payText = clean ? payTextFor(pay, clean) : undefined;
    return [
      {
        id,
        title,
        department: str(cats.department) ?? str(cats.team),
        location: str(cats.location),
        date: day(p.createdAt),
        dateKind: "posted",
        pay,
        link,
        ...(clean ? { description: clip(clean) } : {}),
        ...(payText ? { payText } : {}),
      } satisfies RawRole,
    ];
  });
}

async function readBoard(fetcher: Fetcher, ats: Ats, slug: string): Promise<Board> {
  const url = apiUrl(ats, slug);
  const r = await getJson(fetcher, url);
  const fail = (f: FailedOutcome): Board => ({ kind: "error", url, reason: f.reason, detail: f.detail });
  if (!r.ok) return r.reason === "not_found" ? { kind: "absent", url } : fail(r);
  const found = (roles: RawRole[], departmentsError?: { reason: ErrorReason; detail: string }): Board => ({
    kind: "found",
    ats,
    slug,
    url: boardUrl(ats, slug),
    apiUrl: url,
    roles,
    ...(departmentsError ? { departmentsError } : {}),
  });

  if (ats === "greenhouse") {
    const jobs = isObj(r.data) ? r.data.jobs : null;
    if (!Array.isArray(jobs)) return fail(unexpected(url));
    const depsUrl = `${GH_API}/${encodeURIComponent(slug)}/departments`;
    const d = await getJson(fetcher, depsUrl);
    const map = new Map<string, string>();
    let departmentsError: { reason: ErrorReason; detail: string } | undefined;
    const list = d.ok && isObj(d.data) ? d.data.departments : null;
    if (Array.isArray(list)) {
      for (const dep of list.filter(isObj)) {
        const name = str(dep.name);
        if (!name || !Array.isArray(dep.jobs)) continue;
        for (const j of dep.jobs.filter(isObj)) if (j.id !== undefined && !map.has(String(j.id))) map.set(String(j.id), name);
      }
    } else {
      departmentsError = d.ok ? { reason: "source_unavailable", detail: "unexpected response shape" } : { reason: d.reason, detail: d.detail };
    }
    return found(greenhouseRoles(jobs, map), departmentsError);
  }
  if (ats === "ashby") {
    const jobs = isObj(r.data) ? r.data.jobs : null;
    return Array.isArray(jobs) ? found(ashbyRoles(jobs)) : fail(unexpected(url));
  }
  return Array.isArray(r.data) ? found(leverRoles(r.data)) : fail(unexpected(url));
}

/**
 * One board's open roles. Found and absent boards are cached for TTL_BOARD; a
 * failure never is. A 404 is absence; anything else that goes wrong is an error.
 */
export async function fetchBoard(fetcher: Fetcher, cache: Cache, ats: Ats, slug: string): Promise<Board> {
  let failure: Board | null = null;
  const { value } = await cached<Board>(cache, `${KEY}:${ats}:${slug}`, TTL_BOARD, async () => {
    const b = await readBoard(fetcher, ats, slug);
    if (b.kind === "error" || (b.kind === "found" && b.departmentsError)) {
      failure = b;
      return null;
    }
    return b;
  });
  return value ?? (failure as Board | null) ?? { kind: "error", url: apiUrl(ats, slug), reason: "source_unavailable", detail: "no answer" };
}

/**
 * One role's full description and pay. Ashby and Lever list descriptions with
 * the roles, so those come from `listed`; Greenhouse needs its own request.
 */
export async function fetchRoleDetail(
  fetcher: Fetcher,
  ats: Ats,
  slug: string,
  id: string,
  listed?: RawRole,
): Promise<{ ok: true; description: string; pay: string | null; /** The pay the posting's text states, when the pay field is empty. */ payText?: string } | FailedOutcome> {
  if (ats !== "greenhouse") {
    const url = apiUrl(ats, slug);
    if (listed?.description) return { ok: true, description: listed.description, pay: listed.pay, ...(listed.payText ? { payText: listed.payText } : {}) };
    return { ok: false, reason: "not_found", url, detail: "the board lists no description for this role" };
  }
  const url = `${GH_API}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}?pay_transparency=true`;
  const r = await getJson(fetcher, url);
  if (!r.ok) return r;
  if (!isObj(r.data)) return unexpected(url);
  const clean = scrub(htmlToText(typeof r.data.content === "string" ? r.data.content : ""));
  const pay = greenhousePay(r.data.pay_input_ranges);
  const payText = payTextFor(pay, clean);
  return { ok: true, description: clip(clean), pay, ...(payText ? { payText } : {}) };
}
