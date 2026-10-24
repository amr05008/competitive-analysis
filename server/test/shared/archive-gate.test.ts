import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_COOLDOWN_MS, ARCHIVE_GAP_MS, ARCHIVE_MAX_QUEUE } from "../../src/config";
import { ArchiveGate } from "../../src/shared/archive-gate";
import type { Fetcher } from "../../src/shared/http";

type Call = { url: string; startedAt: number; respond: (r: Response) => void; fail: (e: unknown) => void };

/**
 * A gate on a fake clock, whose sleep advances the clock, and a fetcher that
 * answers only when the test says so. It records each request's start time
 * and the most requests in flight at once.
 */
function harness() {
  let t = 1_000_000;
  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<Response>((resolve, reject) => {
      let finished = false;
      const done = () => {
        if (!finished) active--;
        finished = true;
      };
      calls.push({
        url: String(input),
        startedAt: t,
        respond: (r) => { done(); resolve(r); },
        fail: (e) => { done(); reject(e); },
      });
      init?.signal?.addEventListener("abort", () => { done(); reject(new DOMException("aborted", "AbortError")); });
    });
  }) as Fetcher;
  const gate = new ArchiveGate(fetcher, () => t, async (ms) => { t += ms; });
  return {
    gate,
    calls,
    advance: (ms: number) => { t += ms; },
    maxActive: () => maxActive,
    /** Waits until the fetcher has received n requests. */
    reached: (n: number) => vi.waitFor(() => expect(calls).toHaveLength(n), { interval: 1 }),
  };
}

/** Gives the gate a few turns of the event loop to start anything it would start. */
const settle = () => new Promise((r) => setTimeout(r, 10));

const A = "https://web.archive.org/a";
const B = "https://web.archive.org/b";
const C = "https://web.archive.org/c";
const D = "https://web.archive.org/d";

describe("ArchiveGate", () => {
  it("runs one archive request at a time", async () => {
    const h = harness();
    const runs = [h.gate.run(A), h.gate.run(B), h.gate.run(C)];
    for (let i = 0; i < 3; i++) {
      await h.reached(i + 1);
      await settle();
      expect(h.calls).toHaveLength(i + 1);
      h.calls[i].respond(new Response("ok"));
    }
    expect((await Promise.all(runs)).map((r) => r.ok)).toEqual([true, true, true]);
    expect(h.calls.map((c) => c.url)).toEqual([A, B, C]);
    expect(h.maxActive()).toBe(1);
  });

  it(`waits ARCHIVE_GAP_MS (${ARCHIVE_GAP_MS}) between requests`, async () => {
    expect(ARCHIVE_GAP_MS).toBe(1000);
    const h = harness();
    const runs = [h.gate.run(A), h.gate.run(B), h.gate.run(C)];
    await h.reached(1);
    h.advance(300); // a fast answer: the next request waits out the rest of the gap
    h.calls[0].respond(new Response("ok"));
    await h.reached(2);
    h.advance(2500); // a slow answer: the gap has already passed
    h.calls[1].respond(new Response("ok"));
    await h.reached(3);
    h.calls[2].respond(new Response("ok"));
    await Promise.all(runs);
    const starts = h.calls.map((c) => c.startedAt);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(ARCHIVE_GAP_MS);
    expect(gaps).toEqual([1000, 2500]);
  });

  it(`returns server_busy when ARCHIVE_MAX_QUEUE (${ARCHIVE_MAX_QUEUE}) calls are already waiting`, async () => {
    expect(ARCHIVE_MAX_QUEUE).toBe(3);
    const h = harness();
    const held = [h.gate.run(A), h.gate.run(B), h.gate.run(C)];
    await h.reached(1);
    const fourth = await Promise.race([h.gate.run(D), settle().then(() => "still waiting")]);
    expect(fourth).toMatchObject({ ok: false, reason: "server_busy", url: D, detail: "this server's archive queue is full" });
    for (let i = 0; i < 3; i++) {
      await h.reached(i + 1);
      h.calls[i].respond(new Response("ok"));
    }
    await Promise.all(held);
    expect(h.calls.map((c) => c.url)).not.toContain(D);
    // The finished requests freed their places.
    const after = h.gate.run(D);
    await h.reached(4);
    h.calls[3].respond(new Response("ok"));
    expect(await after).toMatchObject({ ok: true, url: D });
  });

  describe("after a refusal, fails fast until the cooldown passes", () => {
    it.each<[string, (c: Call) => void]>([
      ["a 429", (c) => c.respond(new Response("", { status: 429 }))],
      ["a 503", (c) => c.respond(new Response("", { status: 503 }))],
      ["a thrown connection error", (c) => c.fail(new TypeError("Network connection lost."))],
    ])("%s", async (_kind, refuse) => {
      expect(ARCHIVE_COOLDOWN_MS).toBe(120_000);
      const h = harness();
      const first = h.gate.run(A);
      await h.reached(1);
      refuse(h.calls[0]);
      expect(await first).toMatchObject({ ok: false, reason: "source_rate_limited", url: A });

      h.advance(ARCHIVE_COOLDOWN_MS - 1);
      expect(await h.gate.run(B)).toMatchObject({ ok: false, reason: "source_rate_limited", url: B });
      await settle();
      expect(h.calls).toHaveLength(1);

      h.advance(1);
      const later = h.gate.run(C);
      await h.reached(2);
      h.calls[1].respond(new Response("ok"));
      expect(await later).toMatchObject({ ok: true, url: C });
    });
  });

  it("calls already waiting behind a refusal don't fetch", async () => {
    const h = harness();
    const first = h.gate.run(A);
    const queued = h.gate.run(B);
    await h.reached(1);
    h.calls[0].respond(new Response("", { status: 429 }));
    expect(await first).toMatchObject({ ok: false, reason: "source_rate_limited" });
    expect(await queued).toMatchObject({ ok: false, reason: "source_rate_limited", url: B });
    expect(h.calls).toHaveLength(1);
  });

  describe("startBy", () => {
    const TOO_LATE = { ok: false, reason: "server_busy", status: 599, detail: "the archive queue would start this request too late" };

    it("refuses a request whose turn comes after startBy, without fetching it", async () => {
      const h = harness();
      const first = h.gate.run(A);
      const late = h.gate.run(B, { startBy: 1_000_000 + 2_000 });
      await h.reached(1);
      h.advance(5_000); // the first request is slow
      h.calls[0].respond(new Response("ok"));
      expect(await first).toMatchObject({ ok: true });
      expect(await late).toMatchObject({ ...TOO_LATE, url: B });
      await settle();
      expect(h.calls).toHaveLength(1);
    });

    it("refuses a turn whose gap wait would end after startBy, without waiting", async () => {
      const h = harness();
      const first = h.gate.run(A);
      await h.reached(1);
      h.calls[0].respond(new Response("ok"));
      await first;
      // The next start may come 1000 ms after the first; startBy is 500 ms after it.
      expect(await h.gate.run(B, { startBy: 1_000_000 + 500 })).toMatchObject({ ...TOO_LATE, url: B });
      expect(h.calls).toHaveLength(1);
    });

    it("runs a request whose turn comes by startBy, and a startBy already past is refused at once", async () => {
      const h = harness();
      const onTime = h.gate.run(A, { startBy: 1_000_000 + 10_000 });
      await h.reached(1);
      h.calls[0].respond(new Response("ok"));
      expect(await onTime).toMatchObject({ ok: true, url: A });
      expect(await h.gate.run(B, { startBy: 999_999 })).toMatchObject({ ...TOO_LATE, url: B });
      expect(h.calls).toHaveLength(1);
    });
  });

  it.each<[string, (c: Call) => void, string, string, number | undefined]>([
    ["HTTP 500", (c) => c.respond(new Response("", { status: 500 })), "source_unavailable", "HTTP 500", undefined],
    ["HTTP 404", (c) => c.respond(new Response("", { status: 404 })), "not_found", "HTTP 404", undefined],
    ["a timeout", () => {}, "source_unavailable", "timeout", 20],
    [
      "a failure whose detail mentions a connection",
      (c) => c.respond(new Response(null, { status: 302, headers: { location: "http://connection.internal/" } })),
      "source_unavailable",
      "redirect to a disallowed host: connection.internal",
      undefined,
    ],
  ])("%s is passed through and starts no cooldown", async (_kind, answer, reason, detail, timeoutMs) => {
    const h = harness();
    const first = h.gate.run(A, { timeoutMs });
    await h.reached(1);
    answer(h.calls[0]);
    const out = await first;
    expect(out).toMatchObject({ ok: false, reason });
    expect((out as { detail: string }).detail).toContain(detail);
    const next = h.gate.run(B);
    await h.reached(2);
    h.calls[1].respond(new Response("ok"));
    expect(await next).toMatchObject({ ok: true, url: B });
  });
});
