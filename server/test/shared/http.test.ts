import { describe, expect, it } from "vitest";
import { USER_AGENT } from "../../src/config";
import { FetcherError, politeFetch } from "../../src/shared/http";

const respond = (body: string, status = 200) => async () => new Response(body, { status });

describe("politeFetch", () => {
  it("sends the user agent", async () => {
    let seen: string | null = null;
    await politeFetch(async (_i, init) => {
      seen = new Headers(init?.headers).get("user-agent");
      return new Response("x");
    }, "https://a.com/");
    expect(seen).toBe(USER_AGENT);
  });

  it("returns text on 200", async () => {
    const r = await politeFetch(respond("hello"), "https://a.com/");
    expect(r).toMatchObject({ ok: true, status: 200, text: "hello", truncated: false });
  });

  it("maps 429 and 404", async () => {
    expect(await politeFetch(respond("", 429), "https://a.com/")).toMatchObject({ ok: false, reason: "source_rate_limited" });
    expect(await politeFetch(respond("", 404), "https://a.com/")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("maps 403 and 503 to source_unavailable with the status", async () => {
    for (const s of [403, 503]) {
      const r = await politeFetch(respond("", s), "https://a.com/");
      expect(r).toMatchObject({ ok: false, reason: "source_unavailable", status: s });
      expect((r as { detail: string }).detail).toContain(String(s));
    }
  });

  it("marks a failed answer that carries memento-datetime as a recorded status", async () => {
    // The Wayback Machine replays a capture of a page that answered 403 with 403 and this header.
    const replay = async () => new Response("403 Forbidden", { status: 403, headers: { "memento-datetime": "Mon, 02 Dec 2024 19:31:37 GMT" } });
    expect(await politeFetch(replay, "https://a.com/")).toMatchObject({
      ok: false,
      reason: "source_unavailable",
      status: 403,
      recorded: true,
    });
  });

  it("doesn't mark a 200 replay whose body fails to read as recorded", async () => {
    // A recorded failure is kept as an unreadable capture for good, so a passing fault must never be one.
    const body = new ReadableStream({ pull: (c) => c.error(new TypeError("connection reset")) });
    const r = await politeFetch(
      async () => new Response(body, { status: 200, headers: { "memento-datetime": "Fri, 14 Nov 2025 16:48:40 GMT" } }),
      "https://a.com/",
    );
    expect(r).toMatchObject({ ok: false, reason: "source_unavailable" });
    expect("recorded" in r).toBe(false);
  });

  it("doesn't mark a failed answer without memento-datetime as recorded", async () => {
    const r = await politeFetch(respond("", 403), "https://a.com/");
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect("recorded" in r).toBe(false);
  });

  it("maps a network error", async () => {
    const r = await politeFetch(async () => { throw new TypeError("boom"); }, "https://a.com/");
    expect(r).toMatchObject({ ok: false, reason: "source_unavailable" });
    expect((r as { detail: string }).detail).toContain("connection");
  });

  it("reports a fetcher's own failure in its words, not as a connection failure", async () => {
    const r = await politeFetch(async () => { throw new FetcherError("relay unavailable (HTTP 404)"); }, "https://a.com/");
    expect(r).toMatchObject({ ok: false, reason: "source_unavailable", detail: "relay unavailable (HTTP 404)" });
  });

  it("maps a timeout", async () => {
    const slow = (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    const r = await politeFetch(slow as typeof fetch, "https://a.com/", { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, reason: "source_unavailable" });
    expect((r as { detail: string }).detail).toContain("timeout");
  });

  it("truncates a body over maxBytes", async () => {
    const r = await politeFetch(respond("a".repeat(100)), "https://a.com/", { maxBytes: 10 });
    expect(r).toMatchObject({ ok: true, truncated: true, text: "a".repeat(10) });
  });

  const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

  it("follows a redirect to a public host and reports the final url", async () => {
    const f = (async (u: RequestInfo | URL) =>
      String(u) === "https://a.com/" ? redirect("https://b.com/x") : new Response("ok")) as typeof fetch;
    expect(await politeFetch(f, "https://a.com/")).toMatchObject({ ok: true, url: "https://b.com/x", text: "ok" });
  });

  it("resolves a relative Location", async () => {
    const f = (async (u: RequestInfo | URL) =>
      String(u) === "https://a.com/p/q" ? redirect("../z") : new Response("ok")) as typeof fetch;
    expect(await politeFetch(f, "https://a.com/p/q")).toMatchObject({ ok: true, url: "https://a.com/z" });
  });

  it.each(["http://127.0.0.1/", "http://localhost/", "https://localhost../", "ftp://b.com/"])("refuses a redirect to %s", async (to) => {
    const r = await politeFetch((async () => redirect(to)) as typeof fetch, "https://a.com/");
    expect(r).toMatchObject({ ok: false, reason: "source_unavailable" });
    expect((r as { detail: string }).detail).toContain("redirect to a disallowed host");
  });

  it("refuses a sixth redirect", async () => {
    let n = 0;
    const f = (async () => redirect(`https://a.com/${++n}`)) as typeof fetch;
    const r = await politeFetch(f, "https://a.com/");
    expect(r).toMatchObject({ ok: false, detail: "too many redirects" });
    expect(n).toBe(6);
  });

  it("allows exactly five redirects", async () => {
    let n = 0;
    const f = (async () => (n++ < 5 ? redirect(`https://a.com/${n}`) : new Response("ok"))) as typeof fetch;
    expect(await politeFetch(f, "https://a.com/")).toMatchObject({ ok: true, url: "https://a.com/5" });
  });

  it("keeps the status when body cancel rejects", async () => {
    const res = new Response("x", { status: 503 });
    Object.defineProperty(res, "body", { value: { cancel: () => Promise.reject(new Error("no")) } });
    const r = await politeFetch((async () => res) as typeof fetch, "https://a.com/");
    expect(r).toMatchObject({ ok: false, status: 503 });
  });
});
