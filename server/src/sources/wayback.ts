import { CAPTURE_MAX_BYTES, TTL_CDX, TTL_FINGERPRINT } from "../config";
import { cached } from "../shared/cache";
import type { ArchiveFetch, FailedOutcome } from "../shared/http";
import { extractFingerprint, type Fingerprint } from "./fingerprint";

export type CaptureRow = { timestamp: string; digest: string };

const CDX = "https://web.archive.org/cdx/search/cdx";
/** The most rows listCaptures asks the index for. */
export const CDX_LIMIT = 2000;
/** Starts every cache key; bump the version when what a cached value holds changes, so old entries are never read. */
const KEY = "wayback:v2";

/** Rows of a CDX `output=json` answer, minus the header row; null when the body isn't that shape. */
function parseRows(text: string): CaptureRow[] | null {
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return null;
    const rows: CaptureRow[] = [];
    for (const row of data.slice(1)) {
      if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string") {
        rows.push({ timestamp: row[0], digest: row[1] });
      }
    }
    return rows;
  } catch {
    return null;
  }
}

async function cdxRows(
  archive: ArchiveFetch,
  cache: Cache,
  url: string,
): Promise<{ ok: true; rows: CaptureRow[] } | FailedOutcome> {
  let failure: FailedOutcome | null = null;
  const { value } = await cached<CaptureRow[]>(cache, `${KEY}:cdx:${url}`, TTL_CDX, async () => {
    const res = await archive(url);
    if (!res.ok) {
      failure = res;
      return null;
    }
    const rows = parseRows(res.text);
    if (!rows) {
      failure = { ok: false, reason: "source_unavailable", url, detail: "unreadable index answer" };
      return null;
    }
    return rows;
  });
  if (value === null) {
    return failure ?? { ok: false, reason: "source_unavailable", url, detail: "no index answer" };
  }
  return { ok: true, rows: value };
}

/** Distinct-copy captures of a page between two months (`YYYYMM`), oldest first. */
export async function listCaptures(
  archive: ArchiveFetch,
  cache: Cache,
  cdxKey: string,
  from: string,
  to: string,
): Promise<{ ok: true; captures: CaptureRow[] } | FailedOutcome> {
  const url =
    `${CDX}?url=${encodeURIComponent(cdxKey)}&output=json&from=${from}&to=${to}` +
    `&collapse=digest&filter=statuscode:200&filter=mimetype:text/html&fl=timestamp,digest&limit=${CDX_LIMIT}`;
  const r = await cdxRows(archive, cache, url);
  return r.ok ? { ok: true, captures: r.rows } : r;
}

/** The earliest successful capture of a page, if the archive has one. */
export async function earliestCapture(
  archive: ArchiveFetch,
  cache: Cache,
  cdxKey: string,
): Promise<{ ok: true; capture: CaptureRow | null } | FailedOutcome> {
  const url =
    `${CDX}?url=${encodeURIComponent(cdxKey)}&output=json` +
    `&filter=statuscode:200&fl=timestamp,digest&limit=1`;
  const r = await cdxRows(archive, cache, url);
  return r.ok ? { ok: true, capture: r.rows[0] ?? null } : r;
}

export function captureLink(ts: string, url: string): string {
  return `https://web.archive.org/web/${ts}/${url}`;
}

/** The copy fingerprint of one capture, fetched raw (`id_`) and cached for good. */
export async function fingerprintAt(
  archive: ArchiveFetch,
  cache: Cache,
  ts: string,
  url: string,
): Promise<{ ok: true; fp: Fingerprint; fromCache: boolean } | FailedOutcome> {
  const rawUrl = `https://web.archive.org/web/${ts}id_/${url}`;
  let failure: FailedOutcome | null = null;
  const { value, hit } = await cached<Fingerprint>(cache, `${KEY}:fp:${rawUrl}`, TTL_FINGERPRINT, async () => {
    const res = await archive(rawUrl, { maxBytes: CAPTURE_MAX_BYTES });
    if (!res.ok) {
      failure = res;
      return null;
    }
    return extractFingerprint(res.text);
  });
  if (value === null) {
    return failure ?? { ok: false, reason: "source_unavailable", url: rawUrl, detail: "no capture" };
  }
  return { ok: true, fp: value, fromCache: hit };
}
