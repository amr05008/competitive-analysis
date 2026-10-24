import { RENDER_MAX_CHARS } from "../config";
import type { HnResult, JobOpeningsResult, PageHistoryResult, SecResult, ToolInputs, ToolName, ToolResult, ToolResults } from "../contract/tools";
import type { ArchiveFetch, Fetcher } from "../shared/http";
import { hackerNewsMentions, renderHn } from "./hn-mentions";
import { jobOpenings, renderJobOpenings } from "./job-openings";
import { pageHistory, renderPageHistory } from "./page-history";
import { renderSec, secFilings } from "./sec-filings";

/** What a tool may reach: every outbound request goes through these. */
export type ToolDeps = { fetch: Fetcher; archive: ArchiveFetch; cache: Cache; now: () => number };

export type Implementation<K extends ToolName> = (input: ToolInputs[K], deps: ToolDeps) => Promise<ToolResults[K]>;

export const IMPLEMENTATIONS: { [K in ToolName]: Implementation<K> } = {
  page_history: pageHistory,
  job_openings: jobOpenings,
  hacker_news_mentions: hackerNewsMentions,
  sec_filings: secFilings,
};

export const MORE_LINE = "… more in the structured result";

/**
 * Text cut to `max` characters, at the last line break that leaves room for
 * MORE_LINE, then MORE_LINE. A text with no such line break, such as one line
 * of JSON, is cut mid-line.
 */
export function capText(text: string, max: number = RENDER_MAX_CHARS): string {
  if (text.length <= max) return text;
  const room = max - MORE_LINE.length - 1;
  const lineEnd = text.lastIndexOf("\n", room);
  const head = lineEnd > 0 ? text.slice(0, lineEnd) : text.slice(0, room);
  return `${head}\n${MORE_LINE}`;
}

/** The short text rendering that goes with a result's structured content, at most RENDER_MAX_CHARS long. */
export function render(name: ToolName, result: ToolResult): string {
  const text =
    name === "page_history"
      ? renderPageHistory(result as PageHistoryResult)
      : name === "job_openings"
        ? renderJobOpenings(result as JobOpeningsResult)
        : name === "hacker_news_mentions"
          ? renderHn(result as HnResult)
          : renderSec(result as SecResult);
  return capText(text);
}
