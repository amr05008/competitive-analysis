import { BOARD_MAX_BYTES, ROLE_DESCRIPTION_MAX_CHARS, TTL_BOARD } from "../config";
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
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}/g;

/** A description as stored: email addresses and phone numbers removed, then capped. */
const cap = (s: string) => {
  const clean = s.replace(EMAIL, "[email removed]").replace(PHONE, "[phone removed]");
  return clean.length > ROLE_DESCRIPTION_MAX_CHARS ? clean.slice(0, ROLE_DESCRIPTION_MAX_CHARS) : clean;
};

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
    return [
      {
        id,
        title,
        department: str(j.department) ?? str(j.team),
        location: str(j.location),
        date: day(j.publishedAt),
        dateKind: "posted",
        pay: j.shouldDisplayCompensationOnJobPostings === true ? comp : null,
        link,
        ...(description ? { description: cap(collapse(description)) } : {}),
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
    return [
      {
        id,
        title,
        department: str(cats.department) ?? str(cats.team),
        location: str(cats.location),
        date: day(p.createdAt),
        dateKind: "posted",
        pay: sr ? range(sr.currency, sr.min, sr.max, leverInterval(sr.interval)) : null,
        link,
        ...(description ? { description: cap(description) } : {}),
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
  const { value } = await cached<Board>(cache, `board:${ats}:${slug}`, TTL_BOARD, async () => {
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
): Promise<{ ok: true; description: string; pay: string | null } | FailedOutcome> {
  if (ats !== "greenhouse") {
    const url = apiUrl(ats, slug);
    if (listed?.description) return { ok: true, description: listed.description, pay: listed.pay };
    return { ok: false, reason: "not_found", url, detail: "the board lists no description for this role" };
  }
  const url = `${GH_API}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}?pay_transparency=true`;
  const r = await getJson(fetcher, url);
  if (!r.ok) return r;
  if (!isObj(r.data)) return unexpected(url);
  const content = typeof r.data.content === "string" ? r.data.content : "";
  return { ok: true, description: cap(htmlToText(content)), pay: greenhousePay(r.data.pay_input_ranges) };
}
