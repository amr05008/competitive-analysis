import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorResult } from "../../src/contract/envelope";
import { pageHistoryOutput, type PageHistoryInput, type PageHistoryResult } from "../../src/contract/tools";
import type { ArchiveFetch } from "../../src/shared/http";
import type { CaptureRow } from "../../src/sources/wayback";
import type { ToolDeps } from "../../src/tools";
import { pageHistory, renderPageHistory } from "../../src/tools/page-history";
import { fakeArchive, type FakeArchive } from "../helpers/fake-archive";

const NOW = Date.UTC(2026, 9, 20, 12); // 2026-10-20
const PAGE = "https://example.com/pricing";
const JAN: PageHistoryInput = { url: PAGE, from: "2025-01", to: "2025-01" };
/** A capture from before every test's range, so first_capture is set. */
const EARLIEST: CaptureRow = { timestamp: "20200301000000", digest: "EARLIEST" };

/** Capture i of twenty, one day apart from 2025-01-01. */
const ts = (i: number) => `202501${String(i + 1).padStart(2, "0")}120000`;
const dateOf = (i: number) => `2025-01-${String(i + 1).padStart(2, "0")}`;

const html = (copy: string) =>
  `<!doctype html><html><head><title>${copy} | Example</title><meta name="description" content="All about ${copy}"></head>` +
  `<body><h1>Plans for ${copy}</h1><h2>${copy} features</h2><p>Team plan for ${copy} costs $${copy.length * 10}/month</p></body></html>`;

/** Twenty captures in January 2025 with page HTML `pageAt(i)`, after the EARLIEST one. */
function site(pageAt: (i: number) => string): { rows: CaptureRow[]; pages: Record<string, string> } {
  const inRange = Array.from({ length: 20 }, (_, i) => ({ timestamp: ts(i), digest: `D${i}` }));
  return { rows: [EARLIEST, ...inRange], pages: Object.fromEntries(inRange.map((r, i) => [r.timestamp, pageAt(i)])) };
}
const copies = (copyAt: (i: number) => string) => site((i) => html(copyAt(i)));

async function depsFor(archive: ArchiveFetch, opts: { cache?: Cache; now?: () => number } = {}): Promise<ToolDeps> {
  return {
    fetch: async () => {
      throw new Error("page_history must not use fetch");
    },
    archive,
    // A fresh cache per test, so no test reads another's fingerprints.
    cache: opts.cache ?? (await caches.open(`page-history-${crypto.randomUUID()}`)),
    now: opts.now ?? (() => NOW),
  };
}

const schema = z.object(pageHistoryOutput);

/** Runs the tool and checks the result against the published output schema. */
async function call(
  input: PageHistoryInput,
  archive: ArchiveFetch,
  opts: { cache?: Cache; now?: () => number; maxFetches?: number; deadlineMs?: number } = {},
): Promise<PageHistoryResult> {
  const { maxFetches, deadlineMs, ...rest } = opts;
  const result = await pageHistory(input, await depsFor(archive, rest), { maxFetches, deadlineMs });
  expect(schema.safeParse(result).error).toBeUndefined();
  return result;
}

const pairs = (r: PageHistoryResult) => (r.changes ?? []).map((c) => [c.before.timestamp, c.after.timestamp]);

describe("page_history: dating changes", () => {
  it("pins a single change to adjacent captures", async () => {
    const fake = fakeArchive(copies((i) => (i < 13 ? "Alpha" : "Bravo")));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.changes).toHaveLength(1);
    const [c] = r.changes!;
    expect(c.before.timestamp).toBe(ts(12));
    expect(c.after.timestamp).toBe(ts(13));
    expect(c.resolved).toBe(true);
    expect(c.days_between).toBe(1);
    expect(c.before.headline).toBe("Plans for Alpha");
    expect(c.after.headline).toBe("Plans for Bravo");
    expect(r.captures_in_range).toBe(20);
    // Two index queries, eight samples, then captures 12 and 13.
    expect(fake.calls).toHaveLength(12);
    expect(r.fetches_used).toBe(12);
  });

  it("finds two changes between one sampled pair", async () => {
    const fake = fakeArchive(copies((i) => (i <= 8 ? "Alpha" : i <= 10 ? "Bravo" : "Charlie")));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual([
      [ts(8), ts(9)],
      [ts(10), ts(11)],
    ]);
    expect(r.changes!.every((c) => c.resolved)).toBe(true);
  });

  it("keeps the first max_changes changes by date, defaulting to 10, and says how many more there are", async () => {
    const fake = fakeArchive(copies((i) => `Copy ${String.fromCharCode(65 + i)}`));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual(Array.from({ length: 10 }, (_, i) => [ts(i), ts(i + 1)]));
    expect(r.notes).toContain("9 more changes not shown; call again with a narrower range");
  });

  it("days_between counts whole days, rounded down", async () => {
    const rows = [
      { timestamp: "20250101230000", digest: "A" },
      { timestamp: "20250103220000", digest: "B" },
    ];
    const pages = { [rows[0].timestamp]: html("Alpha"), [rows[1].timestamp]: html("Bravo") };
    const r = await call(JAN, fakeArchive({ rows, pages }));
    expect(r.changes).toHaveLength(1);
    expect(r.changes![0].days_between).toBe(1);
  });

  it("notes a change that is in the meta description only", async () => {
    const fake = fakeArchive(
      site((i) => html("Alpha").replace("All about Alpha", i < 13 ? "All about Alpha" : "Everything about Alpha")),
    );
    const r = await call(JAN, fake);
    expect(pairs(r)).toEqual([[ts(12), ts(13)]]);
    expect(r.notes.some((n) => n.includes("meta description") && n.includes(dateOf(13)))).toBe(true);
    expect(renderPageHistory(r)).toContain("meta description");
  });
});

describe("page_history: budget, deadline and failures", () => {
  it("stops at the fetch budget and reports wide brackets", async () => {
    const fake = fakeArchive(copies((i) => (i < 4 ? "Alpha" : "Bravo")));
    const r = await call(JAN, fake, { maxFetches: 4 });
    expect(r.status).toBe("partial");
    expect(r.changes).toHaveLength(1);
    expect(r.changes![0]).toMatchObject({ resolved: false });
    expect(pairs(r)).toEqual([[ts(3), ts(5)]]);
    expect(r.notes.some((n) => n.includes("still wide"))).toBe(true);
    expect(r.notes.some((n) => n.includes("archive refused"))).toBe(false);
    // The two index queries aren't budgeted; four captures are.
    expect(fake.calls).toHaveLength(6);
    expect(r.fetches_used).toBe(6);
  });

  it("an archive refusal midway returns what's done", async () => {
    const fake = fakeArchive({ ...copies((i) => (i < 2 ? "Alpha" : "Bravo")), failAt: 5 });
    const r = await call(JAN, fake);
    expect(r.status).toBe("partial");
    expect(r.notes.some((n) => n.includes("archive refused") && n.includes("source_rate_limited"))).toBe(true);
    expect(fake.calls).toHaveLength(5);
    expect(r.fetches_used).toBe(5);
    // Samples 0 and 3 were read before the refusal; their change stays wide.
    expect(pairs(r)).toEqual([[ts(0), ts(3)]]);
    expect(r.changes![0].resolved).toBe(false);
    expect(r.first_capture?.timestamp).toBe(EARLIEST.timestamp);
  });

  it("stops at the deadline, checked before each capture fetch", async () => {
    let t = NOW;
    const fake = fakeArchive(copies(() => "Alpha"));
    // Every archive request takes ten seconds.
    const slow: ArchiveFetch = async (url, opts) => {
      t += 10_000;
      return fake(url, opts);
    };
    const r = await call(JAN, slow, { now: () => t });
    expect(r.status).toBe("partial");
    expect(r.notes.some((n) => n.includes("time limit"))).toBe(true);
    // Index queries end at 20 s; the first capture starts before 25 s, the second would start after.
    expect(fake.calls).toHaveLength(3);
  });

  it("a failed earliest-capture lookup is a note, and first_capture is null", async () => {
    const fake = fakeArchive({ ...copies((i) => (i < 13 ? "Alpha" : "Bravo")), failAt: 1 });
    const r = await call(JAN, fake);
    expect(r.status).toBe("partial");
    expect(r.first_capture).toBeNull();
    expect(r.notes.some((n) => n.includes("archive refused") && n.includes("earliest"))).toBe(true);
    expect(pairs(r)).toEqual([[ts(12), ts(13)]]);
  });

  it("a failed capture listing is an error with its reason", async () => {
    const fake = fakeArchive({ ...copies(() => "Alpha"), failAt: 2 });
    const r = await call(JAN, fake);
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ reason: "source_rate_limited", fallback: "fall back to browsing for this check." });
    expect(fake.calls).toHaveLength(2);
  });
});

describe("page_history: unreadable captures", () => {
  it("unreadable captures are never a change", async () => {
    const fake = fakeArchive(site((i) => (i === 6 ? `<div id="root"></div>` : html("Alpha"))));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.changes).toEqual([]);
  });

  it("a client-rendered shell, PDF bytes and a redirect stub among the samples are skipped", async () => {
    const unreadable: Record<number, string> = {
      3: `<!doctype html><html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
      5: "%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj",
      8: `<html><head><meta http-equiv="refresh" content="0; url=/pricing-new"></head><body></body></html>`,
    };
    const fake = fakeArchive(site((i) => unreadable[i] ?? html("Alpha")));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.changes).toEqual([]);
    expect(fake.calls.some((u) => u.includes(ts(5)))).toBe(true);
  });

  it("an unreadable capture inside a bracket is stepped over", async () => {
    const fake = fakeArchive(site((i) => (i === 12 ? `<div id="root"></div>` : html(i < 13 ? "Alpha" : "Bravo"))));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual([[ts(11), ts(13)]]);
    expect(r.changes![0]).toMatchObject({ resolved: true, days_between: 2 });
  });
});

describe("page_history: caching and inputs", () => {
  it("repeat calls cost the archive nothing", async () => {
    const data = copies((i) => (i <= 8 ? "Alpha" : i <= 10 ? "Bravo" : "Charlie"));
    const cache = await caches.open(`page-history-${crypto.randomUUID()}`);
    const first = await call(JAN, fakeArchive(data), { cache });
    const again: FakeArchive = fakeArchive(data);
    const second = await call(JAN, again, { cache });
    expect(again.calls).toHaveLength(0);
    expect(second.fetches_used).toBe(0);
    expect({ ...second, fetches_used: first.fetches_used }).toEqual(first);
  });

  it("cached captures cost no budget", async () => {
    const data = copies((i) => (i < 13 ? "Alpha" : "Bravo"));
    const cache = await caches.open(`page-history-${crypto.randomUUID()}`);
    await call(JAN, fakeArchive(data), { cache });
    const r = await call(JAN, fakeArchive(data), { cache, maxFetches: 0 });
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual([[ts(12), ts(13)]]);
  });

  it("defaults to the last 24 months", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const r = await call({ url: PAGE }, fake);
    expect(r.range).toEqual({ from: "2024-10", to: "2026-10" });
    expect(fake.calls[1]).toContain("&from=202410&to=202610&");
    expect(r.captures_in_range).toBe(20);
  });

  it("from before 1996 is bad_input", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const r = await call({ url: PAGE, from: "1995-12" }, fake);
    expect(r.status).toBe("error");
    expect(r.error?.reason).toBe("bad_input");
    expect(fake.calls).toHaveLength(0);
  });

  it("from after to is bad_input", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const r = await call({ url: PAGE, from: "2025-06", to: "2025-01" }, fake);
    expect(r.error?.reason).toBe("bad_input");
    expect(fake.calls).toHaveLength(0);
  });

  it("a month that doesn't exist is bad_input", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const r = await call({ url: PAGE, to: "2025-13" }, fake);
    expect(r.error?.reason).toBe("bad_input");
    expect(fake.calls).toHaveLength(0);
  });

  it("a private host is bad_input without a fetch", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const r = await call({ url: "http://127.0.0.1/" }, fake);
    expect(r.status).toBe("error");
    expect(r.error?.reason).toBe("bad_input");
    expect(r.retrieved_at).toBe("2026-10-20");
    expect(fake.calls).toHaveLength(0);
  });

  it("a page address too long to repeat in every link is bad_input", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const r = await call({ url: `https://example.com/${"a".repeat(600)}` }, fake);
    expect(r.error?.reason).toBe("bad_input");
    expect(fake.calls).toHaveLength(0);
  });

  it("no captures in range is ok with a note", async () => {
    const fake = fakeArchive({ rows: [EARLIEST], pages: {} });
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.captures_in_range).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.first_capture?.timestamp).toBe(EARLIEST.timestamp);
    expect(r.notes.some((n) => n.includes("no captures"))).toBe(true);
  });
});

describe("page_history: output", () => {
  it("every snapshot carries a link and a date", async () => {
    const r = await call(JAN, fakeArchive(copies((i) => (i <= 8 ? "Alpha" : i <= 10 ? "Bravo" : "Charlie"))));
    expect(r.url).toBe(PAGE);
    expect(r.retrieved_at).toBe("2026-10-20");
    const snapshots = [r.first_capture!, ...r.changes!.flatMap((c) => [c.before, c.after])];
    expect(snapshots).toHaveLength(5);
    for (const s of snapshots) {
      expect(s.link.startsWith(`https://web.archive.org/web/${s.timestamp}/`)).toBe(true);
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("the largest result stays under the cap", async () => {
    const long = (label: string, i: number) => `${label} ${i} `.padEnd(200, "x");
    const prices = (i: number) =>
      Array.from({ length: 8 }, (_, k) => `Plan number ${k} for team ${i} costs $${i * 10 + k}/month`).join(". ");
    const page = (i: number) =>
      `<html><head><title>${long("Title", i)}</title><meta name="description" content="${long("About", i)}"></head><body>` +
      `<h1>${long("Headline", i)}</h1><h2>${long("One", i)}</h2><h2>${long("Two", i)}</h2><h2>${long("Three", i)}</h2>` +
      `<p>${prices(i)}</p></body></html>`;
    const r = await call({ ...JAN, max_changes: 15 }, fakeArchive(site(page)));
    expect(r.changes!.length).toBeGreaterThan(0);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    expect(r.notes.some((n) => n.includes("more changes not shown"))).toBe(true);
  });

  it("renders one line per change", async () => {
    const r = await call(JAN, fakeArchive(copies((i) => (i <= 8 ? "Alpha" : i <= 10 ? "Bravo" : "Charlie"))));
    const text = renderPageHistory(r);
    expect(text).toContain("first captured 20");
    const lines = text.split("\n").filter((l) => l.includes("between 2025-"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`between ${dateOf(8)} and ${dateOf(9)}`);
    expect(lines[0]).toContain("Plans for Bravo");
  });

  it("renders an error with the fallback line", () => {
    const text = renderPageHistory(errorResult("bad_input", "IP addresses are not accepted", [], NOW));
    expect(text).toContain("bad_input");
    expect(text).toContain("fall back to browsing for this check.");
  });
});
