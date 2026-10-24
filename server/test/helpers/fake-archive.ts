import type { ArchiveFetch, FetchOutcome } from "../../src/shared/http";
import type { CaptureRow } from "../../src/sources/wayback";

/** An ArchiveFetch that records the URL of every call it gets. */
export type FakeArchive = ArchiveFetch & { calls: string[] };

const CDX = "https://web.archive.org/cdx/search/cdx?";
const RAW_CAPTURE = /^https:\/\/web\.archive\.org\/web\/(\d{14})id_\//;

/**
 * A stand-in for the Wayback Machine, so tests never reach it. A CDX query
 * answers from `rows`, kept to its from/to months, and only the first row when
 * it asks for limit=1. A raw capture answers with `pages[timestamp]`, or HTTP
 * 404 when there's no page for that timestamp. The `failAt`-th call (counting
 * from 1, CDX queries included) answers HTTP 429 instead; calls after it
 * answer normally, so a retry would show up as an extra call.
 */
export function fakeArchive({
  rows,
  pages,
  failAt,
}: {
  rows: CaptureRow[];
  pages: Record<string, string>;
  failAt?: number;
}): FakeArchive {
  const calls: string[] = [];
  const ok = (url: string, text: string): FetchOutcome => ({ ok: true, status: 200, url, text, truncated: false });
  const archive: ArchiveFetch = async (url) => {
    calls.push(url);
    if (calls.length === failAt) return { ok: false, reason: "source_rate_limited", status: 429, url, detail: "HTTP 429" };
    if (url.startsWith(CDX)) {
      const q = new URL(url).searchParams;
      const from = (q.get("from") ?? "").padEnd(14, "0");
      const to = (q.get("to") ?? "").padEnd(14, "9");
      let found = rows.filter((r) => r.timestamp >= from && r.timestamp <= to);
      if (q.get("limit") === "1") found = found.slice(0, 1);
      if (!found.length) return ok(url, "[]");
      return ok(url, JSON.stringify([["timestamp", "digest"], ...found.map((r) => [r.timestamp, r.digest])]));
    }
    const ts = RAW_CAPTURE.exec(url)?.[1];
    const page = ts === undefined ? undefined : pages[ts];
    if (page === undefined) return { ok: false, reason: "not_found", status: 404, url, detail: "HTTP 404" };
    return ok(url, page);
  };
  return Object.assign(archive, { calls });
}
