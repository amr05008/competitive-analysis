import { FetcherError, type Fetcher } from "./http";

/**
 * The header the archive relay (`relay/` in this repo) puts on its answers. "archive" means the status,
 * location, type and body are the archive's own; any other value, or none, is the relay's own answer.
 */
export const RELAY_MARK = "x-archive-relay";

async function dropBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // a failed cancel must not mask the relay's answer
  }
}

/**
 * Sends each archive request to the relay instead of the archive, which refuses Cloudflare's network. The
 * archive address goes in the body, never the relay's path, so the relay's request log can't show it. An
 * answer not marked as the archive's is the relay's own failure: never read as the archive's status, and
 * never a refusal, except that the relay failing to connect to the archive counts as one, as a direct
 * connection failure does.
 */
export function relayFetcher(relayUrl: string, token: string, fetcher: Fetcher): Fetcher {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/json");
    const res = await fetcher(relayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: String(input) }),
      signal: init?.signal,
      redirect: "manual",
    });
    const mark = res.headers.get(RELAY_MARK);
    if (mark === "archive") return res;
    await dropBody(res);
    if (mark === "unreachable") throw new TypeError("the relay couldn't connect to the archive");
    if (mark === "refused") throw new FetcherError("the relay refused this address");
    if (mark === "timeout") throw new FetcherError("the relay timed out waiting for the archive");
    throw new FetcherError(`relay unavailable (HTTP ${res.status})`);
  };
}

/** The fetcher for Wayback Machine requests: through the relay where ARCHIVE_RELAY_URL is set, else direct. */
export function archiveFetcher(env: Pick<Env, "ARCHIVE_RELAY_URL" | "ARCHIVE_RELAY_TOKEN">, fetcher: Fetcher): Fetcher {
  return env.ARCHIVE_RELAY_URL ? relayFetcher(env.ARCHIVE_RELAY_URL, env.ARCHIVE_RELAY_TOKEN ?? "", fetcher) : fetcher;
}
