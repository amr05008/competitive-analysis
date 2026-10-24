import { CAREERS_MAX_BYTES } from "../config";
import type { Ats } from "../contract/tools";
import { politeFetch, type Fetcher } from "../shared/http";

const PATHS = ["/careers", "/jobs", "/company/careers", "/about/careers"];

const PATTERNS: { ats: Ats; re: RegExp }[] = [
  { ats: "greenhouse", re: /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\\?\/embed\\?\/job_board\?(?:[^"'\s<>]*&(?:amp;)?)?for=([\w-]+)/gi },
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
): Promise<{ found: { ats: Ats; slug: string } | null; tried: string[]; failures: string[] }> {
  const tried: string[] = [];
  const failures: string[] = [];
  for (const path of PATHS) {
    const url = `https://${domain}${path}`;
    tried.push(url);
    const r = await politeFetch(fetcher, url, { maxBytes: CAREERS_MAX_BYTES, accept: "text/html" });
    if (!r.ok) {
      if (r.reason !== "not_found") failures.push(`${url}: ${r.reason}: ${r.detail}`);
      continue;
    }
    if (!onDomain(r.url, domain)) continue;
    const found = boardIn(r.text);
    if (found) return { found, tried, failures };
  }
  return { found: null, tried, failures };
}
