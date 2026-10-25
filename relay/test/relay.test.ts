import { afterEach, describe, expect, it, vi } from "vitest";
import { handle, MARK, type RelayConfig } from "../src/relay.js";

const TOKEN = "t".repeat(64);
const CAPTURE = "https://web.archive.org/web/20250601000000id_/https://example.com/";
const CDX = "https://web.archive.org/cdx/search/cdx?url=example.com&output=json&fl=timestamp,digest&limit=1";
const UA = "competitive-analysis-plugin/0.2 (+https://aaronroy.com/competitive-analysis/)";

type Seen = { url: string; init: RequestInit | undefined };

/** A stand-in for the archive: answers every request with `answer`, and records what it was asked. */
function archive(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return answer();
  }) as typeof fetch;
  return { fetcher, seen };
}

function config(fetcher: typeof fetch, extra: Partial<RelayConfig> = {}): RelayConfig {
  return { token: TOKEN, fetcher, ...extra };
}

/** A request to the relay, as the server sends one. */
function ask(body: unknown, { token = TOKEN, method = "POST" }: { token?: string | null; method?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", "user-agent": UA });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://relay.example/api/archive", {
    method,
    headers,
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("who may use the relay", () => {
  it("answers a plain 404, unmarked, to a request without the token", async () => {
    const a = archive(() => new Response("page"));
    const res = await handle(ask({ url: CAPTURE }, { token: null }), config(a.fetcher));
    expect(res.status).toBe(404);
    expect(res.headers.get(MARK)).toBeNull();
    expect(a.seen).toHaveLength(0);
  });

  it("answers a plain 404 to a wrong token", async () => {
    const a = archive(() => new Response("page"));
    const res = await handle(ask({ url: CAPTURE }, { token: "w".repeat(64) }), config(a.fetcher));
    expect(res.status).toBe(404);
    expect(res.headers.get(MARK)).toBeNull();
    expect(a.seen).toHaveLength(0);
  });

  it.each([
    ["no token", undefined],
    ["an empty token", ""],
    ["a token under 32 characters", "short-token"],
  ])("refuses everyone when it's configured with %s", async (_label, token) => {
    const a = archive(() => new Response("page"));
    const res = await handle(ask({ url: CAPTURE }, { token: token ?? "" }), config(a.fetcher, { token }));
    expect(res.status).toBe(404);
    expect(a.seen).toHaveLength(0);
  });

  it("answers a plain 404 to anything but POST, even with the token", async () => {
    const a = archive(() => new Response("page"));
    const res = await handle(ask(undefined, { method: "GET" }), config(a.fetcher));
    expect(res.status).toBe(404);
    expect(res.headers.get(MARK)).toBeNull();
    expect(a.seen).toHaveLength(0);
  });
});

describe("what the relay fetches", () => {
  it("fetches a capture once, without following redirects, with the caller's user agent", async () => {
    const a = archive(() => new Response("page"));
    await handle(ask({ url: CAPTURE }), config(a.fetcher));
    expect(a.seen).toHaveLength(1);
    expect(a.seen[0].url).toBe(CAPTURE);
    expect(a.seen[0].init?.redirect).toBe("manual");
    expect(new Headers(a.seen[0].init?.headers).get("user-agent")).toBe(UA);
  });

  it("fetches the CDX index", async () => {
    const a = archive(() => new Response("[]"));
    const res = await handle(ask({ url: CDX }), config(a.fetcher));
    expect(res.status).toBe(200);
    expect(a.seen.map((s) => s.url)).toEqual([CDX]);
  });

  it.each([
    ["another host", "https://example.com/"],
    ["plain http", "http://web.archive.org/web/20250601000000id_/https://example.com/"],
    ["another port", "https://web.archive.org:8443/cdx/search/cdx?url=example.com"],
    ["credentials", "https://user:pw@web.archive.org/cdx/search/cdx?url=example.com"],
    ["a capture without id_", "https://web.archive.org/web/20250601000000/https://example.com/"],
    ["the save endpoint", "https://web.archive.org/save/https://example.com/"],
    ["another archive path", "https://web.archive.org/wayback/available?url=example.com"],
    ["a lookalike host", "https://web.archive.org.example.com/cdx/search/cdx"],
    ["not a URL", "web.archive.org/cdx/search/cdx"],
    ["a number", 42],
    ["nothing", undefined],
  ])("refuses %s, marked so the caller knows why", async (_label, url) => {
    const a = archive(() => new Response("page"));
    const res = await handle(ask({ url }), config(a.fetcher));
    expect(res.status).toBe(400);
    expect(res.headers.get(MARK)).toBe("refused");
    expect(a.seen).toHaveLength(0);
  });

  it("refuses a body that isn't JSON", async () => {
    const a = archive(() => new Response("page"));
    const res = await handle(ask("not json"), config(a.fetcher));
    expect(res.status).toBe(400);
    expect(res.headers.get(MARK)).toBe("refused");
    expect(a.seen).toHaveLength(0);
  });
});

describe("what the relay answers", () => {
  it("passes the archive's answer through, marked as the archive's, without its other headers", async () => {
    const a = archive(
      () => new Response("<html>page</html>", { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "a=b" } }),
    );
    const res = await handle(ask({ url: CAPTURE }), config(a.fetcher));
    expect(res.status).toBe(200);
    expect(res.headers.get(MARK)).toBe("archive");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("<html>page</html>");
  });

  it("passes a redirect through with its location", async () => {
    const to = "https://web.archive.org/web/20250601123456id_/https://example.com/";
    const a = archive(() => new Response(null, { status: 302, headers: { location: to } }));
    const res = await handle(ask({ url: CAPTURE }), config(a.fetcher));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(to);
    expect(res.headers.get(MARK)).toBe("archive");
  });

  it.each([404, 429, 503])("passes the archive's %i through, marked as the archive's", async (status) => {
    const a = archive(() => new Response("no", { status }));
    const res = await handle(ask({ url: CAPTURE }), config(a.fetcher));
    expect(res.status).toBe(status);
    expect(res.headers.get(MARK)).toBe("archive");
  });

  it("cuts a body longer than its cap", async () => {
    const a = archive(() => new Response("a".repeat(100)));
    const res = await handle(ask({ url: CAPTURE }), config(a.fetcher, { maxBytes: 10 }));
    expect(await res.text()).toBe("a".repeat(10));
  });

  it("stops reading the archive at its cap", async () => {
    let pulls = 0;
    let cancelled = false;
    const long = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (++pulls > 1_000) controller.close();
        else controller.enqueue(new TextEncoder().encode("a".repeat(10)));
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const a = archive(() => new Response(long));
    const res = await handle(ask({ url: CAPTURE }), config(a.fetcher, { maxBytes: 25 }));
    expect(await res.text()).toBe("a".repeat(25));
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 500, interval: 5 });
    expect(pulls).toBeLessThan(1_000);
  });

  it("says when it can't reach the archive", async () => {
    const a = archive(() => {
      throw new TypeError("fetch failed");
    });
    const res = await handle(ask({ url: CAPTURE }), config(a.fetcher));
    expect(res.status).toBe(502);
    expect(res.headers.get(MARK)).toBe("unreachable");
  });

  it("says when the archive takes too long", async () => {
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const res = await handle(ask({ url: CAPTURE }), config(fetcher, { timeoutMs: 20 }));
    expect(res.status).toBe(504);
    expect(res.headers.get(MARK)).toBe("timeout");
  });

  it("logs nothing, whatever happens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    await handle(ask({ url: CAPTURE }), config(archive(() => new Response("page")).fetcher));
    await handle(ask({ url: "https://example.com/" }), config(archive(() => new Response("page")).fetcher));
    await handle(
      ask({ url: CAPTURE }),
      config(
        archive(() => {
          throw new TypeError("fetch failed");
        }).fetcher,
      ),
    );
    await handle(ask({ url: CAPTURE }, { token: null }), config(archive(() => new Response("page")).fetcher));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
