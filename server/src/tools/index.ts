import type { ToolInputs, ToolName, ToolResults } from "../contract/tools";
import { callCache } from "../shared/cache";
import type { ArchiveFetch, Fetcher } from "../shared/http";
import { countedFetch, Subrequests } from "../shared/subrequests";
import { hackerNewsMentions } from "./hn-mentions";
import { jobOpenings } from "./job-openings";
import { pageHistory } from "./page-history";
import { secFilings } from "./sec-filings";

/**
 * What a tool may reach: every outbound request goes through these. `subrequests` counts this call's
 * fetches and cache calls, so a tool can stop before the platform's per-request limit.
 */
export type ToolDeps = { fetch: Fetcher; archive: ArchiveFetch; cache: Cache; now: () => number; subrequests: Subrequests };

/**
 * One tool call's deps: `fetch` and `cache` counted against `limit` subrequests, and every cache key
 * kept under `environment`. Every call's deps are built here, by makeDeps.
 */
export function callDeps(raw: Omit<ToolDeps, "subrequests">, limit: number, environment: string): ToolDeps {
  const subrequests = new Subrequests(limit);
  return {
    ...raw,
    fetch: countedFetch(raw.fetch, subrequests),
    cache: callCache(raw.cache, environment, subrequests),
    subrequests,
  };
}

export type Implementation<K extends ToolName> = (input: ToolInputs[K], deps: ToolDeps) => Promise<ToolResults[K]>;

export const IMPLEMENTATIONS: { [K in ToolName]: Implementation<K> } = {
  page_history: pageHistory,
  job_openings: jobOpenings,
  hacker_news_mentions: hackerNewsMentions,
  sec_filings: secFilings,
};
