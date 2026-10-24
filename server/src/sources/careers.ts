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

/**
 * Looks for a job-board link on the company's careers pages, in order, and
 * stops at the first one that has it. `tried` lists every page requested. A page
 * that fails for any reason but a 404 is in `failures`, since it is a page we
 * couldn't check. A page that ends up off the company's domain is ignored.
 */
export async function findBoardLink(
  fetcher: Fetcher,
  domain: string,
): Promise<{ found: BoardLink | null; tried: string[]; failures: { url: string; reason: ErrorReason; detail: string; status?: number }[] }> {
  const tried: string[] = [];
  const failures: { url: string; reason: ErrorReason; detail: string; status?: number }[] = [];
  for (const path of PATHS) {
    const url = `https://${domain}${path}`;
    tried.push(url);
    const r = await politeFetch(fetcher, url, { maxBytes: CAREERS_MAX_BYTES, accept: "text/html" });
    if (!r.ok) {
      if (r.reason !== "not_found") failures.push({ url, reason: r.reason, detail: r.detail, status: r.status });
      continue;
    }
    // A path that ends on a known board page is a link to that board, wherever the company hosts it.
    const landed = boardAt(r.url);
    if (landed) return { found: landed, tried, failures };
    if (!onDomain(r.url, domain)) continue;
    const found = boardIn(r.text);
    if (found) return { found, tried, failures };
  }
  return { found: null, tried, failures };
}
