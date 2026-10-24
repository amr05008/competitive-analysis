import { describe, expect, it } from "vitest";
import {
  captureLink,
  earliestCapture,
  fingerprintAt,
  listCaptures,
} from "../../src/sources/wayback";
import type { ArchiveFetch, FetchOutcome } from "../../src/shared/http";
import cdx from "../fixtures/wayback/cdx-hightouch-pricing.json";
import capture from "../fixtures/wayback/capture-hightouch-pricing.html?raw";

function fake(text: string | FetchOutcome) {
  const calls: { url: string; opts?: { timeoutMs?: number; maxBytes?: number } }[] = [];
  const archive: ArchiveFetch = async (url, opts) => {
    calls.push({ url, opts });
    return typeof text === "string" ? { ok: true, status: 200, url, text, truncated: false } : text;
  };
  return { archive, calls };
}
const uniq = () => `hightouch.com/pricing-${crypto.randomUUID()}`;

describe("listCaptures", () => {
  it("requests the exact CDX URL and parses rows without the header", async () => {
    const { archive, calls } = fake(JSON.stringify(cdx));
    const r = await listCaptures(archive, caches.default, "hightouch.com/pricing", "202501", "202610");
    expect(calls[0].url).toBe(
      "https://web.archive.org/cdx/search/cdx?url=hightouch.com%2Fpricing&output=json&from=202501&to=202610&collapse=digest&filter=statuscode:200&filter=mimetype:text/html&fl=timestamp,digest&limit=2000",
    );
    expect(r).toEqual({
      ok: true,
      captures: [{ timestamp: "20250114231348", digest: "WDRSKZLOHWYH7C2DC7BQ4WM6QQOYJSOR" }, ...(r.ok ? r.captures.slice(1) : [])],
    });
    expect(r.ok && r.captures).toHaveLength(8);
  });

  it("gives zero captures for []", async () => {
    const { archive } = fake("[]");
    expect(await listCaptures(archive, caches.default, uniq(), "202501", "202610")).toEqual({ ok: true, captures: [] });
  });

  it("passes a failure through unchanged and does not cache it", async () => {
    const failed: FetchOutcome = { ok: false, reason: "source_rate_limited", url: "u", detail: "HTTP 429", status: 429 };
    const key = uniq();
    const { archive, calls } = fake(failed);
    expect(await listCaptures(archive, caches.default, key, "202501", "202610")).toBe(failed);
    await listCaptures(archive, caches.default, key, "202501", "202610");
    expect(calls).toHaveLength(2);
  });

  it("answers a repeat call from the cache", async () => {
    const key = uniq();
    const { archive, calls } = fake(JSON.stringify(cdx));
    await listCaptures(archive, caches.default, key, "202501", "202610");
    const again = await listCaptures(archive, caches.default, key, "202501", "202610");
    expect(calls).toHaveLength(1);
    expect(again.ok && again.captures).toHaveLength(8);
  });
});

describe("earliestCapture", () => {
  it("uses limit=1", async () => {
    const { archive, calls } = fake(JSON.stringify([["timestamp", "digest"], ["20200101000000", "ABC"]]));
    const r = await earliestCapture(archive, caches.default, "hightouch.com/pricing");
    expect(calls[0].url).toBe(
      "https://web.archive.org/cdx/search/cdx?url=hightouch.com%2Fpricing&output=json&filter=statuscode:200&fl=timestamp,digest&limit=1",
    );
    expect(r).toEqual({ ok: true, capture: { timestamp: "20200101000000", digest: "ABC" } });
  });

  it("gives null capture when there are none", async () => {
    const { archive } = fake("[]");
    expect(await earliestCapture(archive, caches.default, uniq())).toEqual({ ok: true, capture: null });
  });

  it("passes a failure through", async () => {
    const failed: FetchOutcome = { ok: false, reason: "source_unavailable", url: "u", detail: "x" };
    const { archive } = fake(failed);
    expect(await earliestCapture(archive, caches.default, uniq())).toBe(failed);
  });
});

describe("captureLink", () => {
  it("builds the replay URL", () => {
    expect(captureLink("2025", "https://a.com/p")).toBe("https://web.archive.org/web/2025/https://a.com/p");
  });
});

describe("fingerprintAt", () => {
  it("fetches the raw capture with the byte cap, then serves repeats from cache", async () => {
    const url = `https://hightouch.com/pricing?${crypto.randomUUID()}`;
    const { archive, calls } = fake(capture);
    const a = await fingerprintAt(archive, caches.default, "20250114231348", url);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://web.archive.org/web/20250114231348id_/${url}`);
    expect(calls[0].opts?.maxBytes).toBe(1_500_000);
    expect(a.ok && a.fromCache).toBe(false);
    const b = await fingerprintAt(archive, caches.default, "20250114231348", url);
    expect(calls).toHaveLength(1);
    expect(b.ok && b.fromCache).toBe(true);
    expect(b.ok && b.fp.readable).toBe(true);
  });

  it("returns a failure unchanged", async () => {
    const failed: FetchOutcome = { ok: false, reason: "not_found", url: "u", detail: "HTTP 404", status: 404 };
    const { archive } = fake(failed);
    expect(await fingerprintAt(archive, caches.default, "2025", "https://a.com/x")).toBe(failed);
  });
});
