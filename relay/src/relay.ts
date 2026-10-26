import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The header on every answer the relay sends to a caller with the token. "archive" means the status,
 * location, type, memento-datetime and body are the archive's own. Anything else is the relay's: "refused" (an address it
 * won't fetch), "unreachable" (no connection to the archive), "timeout", or "error".
 */
export const MARK = "x-archive-relay";

export type RelayConfig = {
  /** ARCHIVE_RELAY_TOKEN. Unset or shorter than 32 characters, the relay refuses everyone. */
  token: string | undefined;
  fetcher: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

const MIN_TOKEN_LENGTH = 32;
/** Longer than any timeout the server sets, so the server's own timeout decides. */
const TIMEOUT_MS = 25_000;
/** Above the server's largest cap (2 MB), so the server sees its own truncation first. */
const MAX_BYTES = 4_000_000;
const MAX_REQUEST_BYTES = 8_192;
const CAPTURE_PATH = /^\/web\/\d{1,14}id_\//;

// Nothing here logs: the address names the company a user asked about.

const notFound = () => new Response("Not found\n", { status: 404 });

const marked = (mark: string, status: number, text: string) =>
  new Response(`${text}\n`, { status, headers: { [MARK]: mark, "content-type": "text/plain; charset=utf-8" } });

function authorized(req: Request, token: string | undefined): boolean {
  if (!token || token.length < MIN_TOKEN_LENGTH) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(auth.slice("Bearer ".length)), digest(token));
}

/** The two kinds of archive address page_history reads: the CDX index and raw captures. */
function allowed(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "web.archive.org" || url.port || url.username || url.password) return null;
  return url.pathname === "/cdx/search/cdx" || CAPTURE_PATH.test(url.pathname) ? raw : null;
}

async function requestedUrl(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    if (text.length > MAX_REQUEST_BYTES) return undefined;
    return (JSON.parse(text) as { url?: unknown } | null)?.url;
  } catch {
    return undefined;
  }
}

function capped(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let left = maxBytes;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const part = chunk.byteLength > left ? chunk.subarray(0, left) : chunk;
        left -= part.byteLength;
        controller.enqueue(part);
        if (left <= 0) controller.terminate();
      },
    }),
  );
}

/**
 * One archive request for the Competitive Analysis server, whose own network the archive refuses. The
 * caller POSTs `{ "url": ... }` with the token; the relay makes one GET, follows no redirects, and hands
 * back the archive's status, location, content type, memento-datetime and body, marked. Without the
 * token, it's a 404.
 */
export async function handle(req: Request, config: RelayConfig): Promise<Response> {
  try {
    if (req.method !== "POST" || !authorized(req, config.token)) return notFound();
    const url = allowed(await requestedUrl(req));
    if (!url) return marked("refused", 400, "only the archive's CDX index and raw captures");

    const headers: Record<string, string> = {};
    for (const name of ["user-agent", "accept"]) {
      const value = req.headers.get(name);
      if (value) headers[name] = value;
    }
    let upstream: Response;
    try {
      upstream = await config.fetcher(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      return (e as Error | undefined)?.name === "TimeoutError"
        ? marked("timeout", 504, "the archive didn't answer in time")
        : marked("unreachable", 502, "couldn't connect to the archive");
    }

    const out = new Headers({ [MARK]: "archive" });
    // memento-datetime marks a replayed capture, whose status is the archived page's own, not the archive's.
    for (const name of ["content-type", "location", "memento-datetime"]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    const body = upstream.body ? capped(upstream.body, config.maxBytes ?? MAX_BYTES) : null;
    return new Response(body, { status: upstream.status, headers: out });
  } catch {
    return marked("error", 500, "relay error");
  }
}
