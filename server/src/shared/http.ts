import type { ErrorReason } from "../contract/envelope";
import { USER_AGENT } from "../config";
import { isPublicHost } from "./inputs";

export type Fetcher = typeof fetch;

export type FetchOutcome =
  | { ok: true; status: number; url: string; text: string; truncated: boolean }
  | { ok: false; reason: ErrorReason; status?: number; url: string; detail: string };

export type FailedOutcome = Extract<FetchOutcome, { ok: false }>;

/**
 * The status of a request this server declined to make because the call's own limits ran out: its fetch
 * budget, its time, or the per-request subrequest limit. No upstream sends it, so tools read it as their
 * budget running out, never as a source failing.
 */
export const REFUSED_STATUS = 599;

/**
 * A fetcher's own failure, such as the archive relay's (see relay.ts). politeFetch reports it as
 * source_unavailable with its message as the detail, never as a connection failure, so it isn't a refusal.
 */
export class FetcherError extends Error {}

/**
 * One Wayback Machine request through the server-wide gate. With `startBy` (an absolute time in ms), the
 * gate answers server_busy with REFUSED_STATUS instead of starting the request after that moment.
 */
export type ArchiveFetch = (
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number; startBy?: number },
) => Promise<FetchOutcome>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

async function dropBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // a failed cancel must not mask the status
  }
}

/** One GET with our user agent, a timeout and a body cap; failures come back as values, never throws. */
export async function politeFetch(
  fetcher: Fetcher,
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<FetchOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  let finalUrl = url;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const fail = (reason: ErrorReason, detail: string, status?: number): FetchOutcome => ({
    ok: false,
    reason,
    url: finalUrl,
    detail,
    ...(status === undefined ? {} : { status }),
  });
  try {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (opts.accept) headers.accept = opts.accept;
    let current = url;
    let res: Response;
    for (let hops = 0; ; hops++) {
      res = await fetcher(current, { headers, signal: controller.signal, redirect: "manual" });
      if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) break;
      await dropBody(res);
      if (hops >= MAX_REDIRECTS) return fail("source_unavailable", "too many redirects");
      let next: URL;
      try {
        next = new URL(res.headers.get("location") as string, current);
      } catch {
        return fail("source_unavailable", "redirect to an invalid location");
      }
      if ((next.protocol !== "http:" && next.protocol !== "https:") || !isPublicHost(next.hostname)) {
        return fail("source_unavailable", `redirect to a disallowed host: ${next.hostname}`);
      }
      current = next.toString();
    }
    finalUrl = current;
    if (res.status === 429) {
      await dropBody(res);
      return fail("source_rate_limited", "HTTP 429", 429);
    }
    if (res.status === 404) {
      await dropBody(res);
      return fail("not_found", "HTTP 404", 404);
    }
    if (!res.ok) {
      await dropBody(res);
      return fail("source_unavailable", `HTTP ${res.status}`, res.status);
    }
    const { text, truncated } = await readCapped(res, maxBytes);
    return { ok: true, status: res.status, url: finalUrl, text, truncated };
  } catch (e) {
    if (timedOut) return fail("source_unavailable", `timeout after ${timeoutMs} ms`);
    if (e instanceof FetcherError) return fail("source_unavailable", e.message);
    return fail("source_unavailable", `connection failed (${e instanceof Error ? e.name : "error"})`);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { text: new TextDecoder().decode(all), truncated };
}
