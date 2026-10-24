import { CAREERS_MAX_BYTES } from "../config";
import type { ErrorReason } from "../contract/envelope";
import type { Ats } from "../contract/tools";
import { politeFetch, type Fetcher } from "../shared/http";

const PATHS = ["/careers", "/jobs", "/company/careers", "/about/careers"];

// The embed pattern reads at most 300 characters of query string before for=: an unbounded run backtracks
// over every & in it, which a crafted page can make quadratic.
const PATTERNS: { ats: Ats; re: RegExp }[] = [
  { ats: "greenhouse", re: /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\\?\/embed\\?\/job_board(?:\\?\/js)?\?(?:[^"'\s<>]{0,300}&(?:amp;)?)?for=([\w-]+)/gi },
  { ats: "greenhouse", re: /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\\?\/(?!embed\b)([\w-]+)/gi },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\\?\/([\w-]+)/gi },
  { ats: "lever", re: /jobs\.lever\.co\\?\/([\w-]+)/gi },
];

/** The first job-board link in a page, by position. */
function boardIn(html: string): { ats: Ats; slug: string } | null {
  let best: { at: number; ats: Ats; slug: string } | null = null;
  for (const { ats, re } of PATTERNS) {
    for (const m of html.matchAll(re)) {
      if (best === null || (m.index ?? 0) < best.at) best = { at: m.index ?? 0, ats, slug: m[1] };
      break;
    }
  }
  return best && { ats: best.ats, slug: best.slug };
}

const BOARD_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io", "jobs.ashbyhq.com", "jobs.lever.co"]);

/** The board a URL is a page of, when its host is a known board host exactly. */
function boardAt(url: string): { ats: Ats; slug: string } | null {
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
): Promise<{ found: { ats: Ats; slug: string } | null; tried: string[]; failures: { url: string; reason: ErrorReason; detail: string; status?: number }[] }> {
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
