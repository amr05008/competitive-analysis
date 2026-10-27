import { CAREERS_MAX_BYTES } from "../config";
import type { ErrorReason } from "../contract/envelope";
import type { Ats } from "../contract/tools";
import { politeFetch, type Fetcher } from "../shared/http";

const PATHS = ["/careers", "/jobs", "/company/careers", "/about/careers"];

/** A job board a careers page links to. `region: "eu"` marks a board on an EU host, which the tool doesn't read. */
export type BoardLink = { ats: Ats; slug: string; region?: "eu" };

// Each pattern names the board in `slug`, and an EU host in `eu`. The embed pattern reads at most 300
// characters of query string before for=: an unbounded run backtracks over every & in it, which a crafted
// page can make quadratic.
const PATTERNS: { ats: Ats; re: RegExp }[] = [
  { ats: "greenhouse", re: /(?:job-boards|boards)(?<eu>\.eu)?\.greenhouse\.io\\?\/embed\\?\/job_board(?:\\?\/js)?\?(?:[^"'\s<>]{0,300}&(?:amp;)?)?for=(?<slug>[\w-]+)/gi },
  { ats: "greenhouse", re: /(?:job-boards|boards)(?<eu>\.eu)?\.greenhouse\.io\\?\/(?!embed\b)(?<slug>[\w-]+)/gi },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\\?\/(?<slug>[\w-]+)/gi },
  { ats: "lever", re: /jobs\.(?<eu>eu\.)?lever\.co\\?\/(?<slug>[\w-]+)/gi },
];

/** The first job-board link in a page, by position. */
function boardIn(html: string): BoardLink | null {
  let best: { at: number; link: BoardLink } | null = null;
  for (const { ats, re } of PATTERNS) {
    for (const m of html.matchAll(re)) {
      const slug = m.groups?.slug ?? "";
      if (best === null || (m.index ?? 0) < best.at) best = { at: m.index ?? 0, link: m.groups?.eu ? { ats, slug, region: "eu" } : { ats, slug } };
      break;
    }
  }
  return best && best.link;
}

const BOARD_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io", "jobs.ashbyhq.com", "jobs.lever.co", "jobs.eu.lever.co"]);

/** The public address of a board on an EU host. */
export function euBoardUrl(link: BoardLink): string {
  const slug = encodeURIComponent(link.slug);
  return link.ats === "lever" ? `https://jobs.eu.lever.co/${slug}` : `https://job-boards.eu.greenhouse.io/${slug}`;
}

/** The board a URL is a page of, when its host is a known board host exactly. */
function boardAt(url: string): BoardLink | null {
  try {
    const u = new URL(url);
    return BOARD_HOSTS.has(u.hostname.toLowerCase()) ? boardIn(`${u.hostname}${u.pathname}${u.search}`) : null;
  } catch {
    return null;
  }
}

const onDomain = (url: string, domain: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
};

const HREF = /href\s*=\s*["']([^"'<>\s]{1,300})["']/gi;
/** A role page's address ends in an id: a UUID (Ashby, Lever) or six or more digits (Greenhouse). */
const ROLE_ID = /(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[/_-]\d{6,})\/?$/i;
/** The most role-like links read from one page; a crafted page can hold thousands, each parsed as a URL. */
const MAX_ROLE_LINKS = 200;

/**
 * The first link from a careers page to one of its own role pages: https on the company's domain, under
 * the page's path, and ending in an id. Some companies list their roles on their own site and name the board
 * only in each role's apply link.
 */
function rolePageIn(html: string, pageUrl: string, domain: string): string | null {
  const base = new URL(pageUrl);
  const under = `${base.pathname.replace(/\/+$/, "")}/`;
  let seen = 0;
  for (const m of html.matchAll(HREF)) {
    if (!ROLE_ID.test(m[1])) continue;
    if (++seen > MAX_ROLE_LINKS) break;
    let u: URL;
    try {
      u = new URL(m[1].replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (u.protocol === "https:" && u.port === "" && onDomain(u.href, domain) && u.pathname.startsWith(under) && ROLE_ID.test(u.pathname)) {
      return u.href;
    }
  }
  return null;
}

type PageFailure = { url: string; reason: ErrorReason; detail: string; status?: number };

/** The board one page names, by where it ends up or by a link in it; null for a page off the company's domain. */
async function boardOnPage(
  fetcher: Fetcher,
  url: string,
  domain: string,
  failures: PageFailure[],
): Promise<{ found: BoardLink | null; page: { url: string; text: string } | null }> {
  const r = await politeFetch(fetcher, url, { maxBytes: CAREERS_MAX_BYTES, accept: "text/html" });
  if (!r.ok) {
    if (r.reason !== "not_found") failures.push({ url, reason: r.reason, detail: r.detail, status: r.status });
    return { found: null, page: null };
  }
  // A page that ends on a known board page is a link to that board, wherever the company hosts it.
  const landed = boardAt(r.url);
  if (landed) return { found: landed, page: null };
  if (!onDomain(r.url, domain)) return { found: null, page: null };
  return { found: boardIn(r.text), page: { url: r.url, text: r.text } };
}

/**
 * Looks for a job-board link on the company's careers pages, in order, and
 * stops at the first one that has it. A careers page that names no board but
 * links to one of its own role pages has that role page read too, at most one
 * per call. `tried` lists every page requested. A page that fails for any
 * reason but a 404 is in `failures`, since it is a page we couldn't check. A
 * page that ends up off the company's domain is ignored.
 */
export async function findBoardLink(
  fetcher: Fetcher,
  domain: string,
): Promise<{ found: BoardLink | null; tried: string[]; failures: PageFailure[] }> {
  const tried: string[] = [];
  const failures: PageFailure[] = [];
  let roleRead = false;
  for (const path of PATHS) {
    const url = `https://${domain}${path}`;
    tried.push(url);
    const { found, page } = await boardOnPage(fetcher, url, domain, failures);
    if (found) return { found, tried, failures };
    const role = page && !roleRead ? rolePageIn(page.text, page.url, domain) : null;
    if (!role) continue;
    roleRead = true;
    tried.push(role);
    const fromRole = (await boardOnPage(fetcher, role, domain, failures)).found;
    if (fromRole) return { found: fromRole, tried, failures };
  }
  return { found: null, tried, failures };
}
