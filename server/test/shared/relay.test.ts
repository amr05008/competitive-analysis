import { describe, expect, it } from "vitest";
import { USER_AGENT } from "../../src/config";
import { ArchiveGate } from "../../src/shared/archive-gate";
import { politeFetch, type Fetcher } from "../../src/shared/http";
import { archiveFetcher, RELAY_MARK, relayFetcher } from "../../src/shared/relay";

const RELAY = "https://relay.example/api/archive";
const TOKEN = "t".repeat(64);
const CAPTURE = "https://web.archive.org/web/20250601000000id_/https://example.com/";
const MOVED = "https://web.archive.org/web/20250601123456id_/https://example.com/";

type Sent = { url: string; method?: string; headers: Headers; body: unknown; redirect?: RequestInit["redirect"]; signal?: AbortSignal | null };

/** A stand-in for the relay: answers each archive address from `answers`, and records what it was sent. */
function relay(answers: Record<string, () => Response>) {
  const sent: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { url: string };
    sent.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body, redirect: init?.redirect, signal: init?.signal });
    const answer = answers[body.url];
    return answer ? answer() : new Response("Not found\n", { status: 404 });
  }) as Fetcher;
  return { fetcher, sent };
}

const fromArchive = (body: string | null, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { ...(init.headers as Record<string, string>), [RELAY_MARK]: "archive" } });

const fromRelay = (mark: string, status: number) => new Response("relay says no\n", { status, headers: { [RELAY_MARK]: mark } });

describe("relayFetcher", () => {
  it("POSTs the archive address in the body, with the token, our user agent and no redirect following", async () => {
    const r = relay({ [CAPTURE]: () => fromArchive("page") });
    await politeFetch(relayFetcher(RELAY, TOKEN, r.fetcher), CAPTURE);
    expect(r.sent).toHaveLength(1);
    const [s] = r.sent;
    expect(s.url).toBe(RELAY);
    expect(s.method).toBe("POST");
    expect(s.body).toEqual({ url: CAPTURE });
    expect(s.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(s.headers.get("content-type")).toBe("application/json");
    expect(s.headers.get("user-agent")).toBe(USER_AGENT);
    expect(s.redirect).toBe("manual");
    expect(s.signal).toBeInstanceOf(AbortSignal);
  });

  it("hands back the archive's answer", async () => {
    const r = relay({ [CAPTURE]: () => fromArchive("<html>page</html>") });
    expect(await politeFetch(relayFetcher(RELAY, TOKEN, r.fetcher), CAPTURE)).toMatchObject({
      ok: true,
      url: CAPTURE,
      text: "<html>page</html>",
    });
  });

  it("follows the archive's redirect through the relay", async () => {
    const r = relay({
      [CAPTURE]: () => fromArchive(null, { status: 302, headers: { location: MOVED } }),
      [MOVED]: () => fromArchive("page"),
    });
    expect(await politeFetch(relayFetcher(RELAY, TOKEN, r.fetcher), CAPTURE)).toMatchObject({ ok: true, url: MOVED, text: "page" });
    expect(r.sent.map((s) => s.body)).toEqual([{ url: CAPTURE }, { url: MOVED }]);
  });

  it("keeps the archive's own 404 and 429", async () => {
    const r = relay({
      [CAPTURE]: () => fromArchive("", { status: 404 }),
      [MOVED]: () => fromArchive("", { status: 429 }),
    });
    const fetcher = relayFetcher(RELAY, TOKEN, r.fetcher);
    expect(await politeFetch(fetcher, CAPTURE)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await politeFetch(fetcher, MOVED)).toMatchObject({ ok: false, reason: "source_rate_limited" });
  });

  it("keeps a replayed capture's recorded status recorded, through the relay", async () => {
    const r = relay({
      [CAPTURE]: () => fromArchive("403 Forbidden", { status: 403, headers: { "memento-datetime": "Mon, 02 Dec 2024 19:31:37 GMT" } }),
    });
    expect(await politeFetch(relayFetcher(RELAY, TOKEN, r.fetcher), CAPTURE)).toMatchObject({
      ok: false,
      status: 403,
      recorded: true,
    });
  });

  it("reports an unmarked answer as the relay's failure, never as the archive's status", async () => {
    // What a wrong token, a missing deploy or a paused project looks like: a plain 404.
    const r = relay({});
    expect(await politeFetch(relayFetcher(RELAY, TOKEN, r.fetcher), CAPTURE)).toMatchObject({
      ok: false,
      reason: "source_unavailable",
      detail: "relay unavailable (HTTP 404)",
    });
  });

  it.each([
    ["refused", 400, "the relay refused this address"],
    ["timeout", 504, "the relay timed out waiting for the archive"],
    ["error", 500, "relay unavailable (HTTP 500)"],
  ])("reports the relay's %s as source_unavailable", async (mark, status, detail) => {
    const r = relay({ [CAPTURE]: () => fromRelay(mark, status) });
    expect(await politeFetch(relayFetcher(RELAY, TOKEN, r.fetcher), CAPTURE)).toMatchObject({
      ok: false,
      reason: "source_unavailable",
      detail,
    });
  });
});

describe("relayFetcher behind the archive gate", () => {
  const gate = (fetcher: Fetcher) => {
    const t = 1_000_000;
    return new ArchiveGate(fetcher, () => t, async () => {});
  };

  it("treats the relay failing to connect to the archive as a refusal, as a direct connection failure is", async () => {
    const r = relay({ [CAPTURE]: () => fromRelay("unreachable", 502), [MOVED]: () => fromArchive("page") });
    const g = gate(relayFetcher(RELAY, TOKEN, r.fetcher));
    expect(await g.run(CAPTURE)).toMatchObject({ ok: false, reason: "source_rate_limited" });
    expect(await g.run(MOVED)).toMatchObject({ ok: false, detail: "archive requests paused after a refusal" });
  });

  it("doesn't pause archive requests when the relay itself is unavailable", async () => {
    const r = relay({ [MOVED]: () => fromArchive("page") });
    const g = gate(relayFetcher(RELAY, TOKEN, r.fetcher));
    expect(await g.run(CAPTURE)).toMatchObject({ ok: false, reason: "source_unavailable" });
    expect(await g.run(MOVED)).toMatchObject({ ok: true, text: "page" });
  });
});

describe("archiveFetcher", () => {
  const direct = (async () => new Response("direct")) as unknown as Fetcher;

  it("goes direct when no relay is configured", () => {
    expect(archiveFetcher({}, direct)).toBe(direct);
    expect(archiveFetcher({ ARCHIVE_RELAY_URL: "" }, direct)).toBe(direct);
  });

  it("goes through the relay when one is configured", async () => {
    const r = relay({ [CAPTURE]: () => fromArchive("via relay") });
    const f = archiveFetcher({ ARCHIVE_RELAY_URL: RELAY, ARCHIVE_RELAY_TOKEN: TOKEN }, r.fetcher);
    expect(await politeFetch(f, CAPTURE)).toMatchObject({ ok: true, text: "via relay" });
    expect(r.sent[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});
