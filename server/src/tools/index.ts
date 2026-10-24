import { errorResult } from "../contract/envelope";
import type { PageHistoryResult, ToolInputs, ToolName, ToolResult, ToolResults } from "../contract/tools";
import type { ArchiveFetch, Fetcher } from "../shared/http";
import { pageHistory, renderPageHistory } from "./page-history";

/** What a tool may reach: every outbound request goes through these. */
export type ToolDeps = { fetch: Fetcher; archive: ArchiveFetch; cache: Cache; now: () => number };

export type Implementation<K extends ToolName> = (input: ToolInputs[K], deps: ToolDeps) => Promise<ToolResults[K]>;

const notBuiltYet = async () => errorResult("source_unavailable", "not built yet", []);

export const IMPLEMENTATIONS: { [K in ToolName]: Implementation<K> } = {
  page_history: pageHistory,
  job_openings: notBuiltYet,
  hacker_news_mentions: notBuiltYet,
  sec_filings: notBuiltYet,
};

/** The short text rendering that goes with a result's structured content. */
export function render(name: ToolName, result: ToolResult): string {
  if (name === "page_history") return renderPageHistory(result as PageHistoryResult);
  return JSON.stringify(result);
}
