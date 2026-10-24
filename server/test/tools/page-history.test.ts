import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorResult } from "../../src/contract/envelope";
import { pageHistoryOutput, type PageHistoryInput, type PageHistoryResult } from "../../src/contract/tools";
import type { ArchiveFetch } from "../../src/shared/http";
import type { CaptureRow } from "../../src/sources/wayback";
import { MORE_LINE, render, type ToolDeps } from "../../src/tools";
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

/** `n` captures (twenty unless given) in January 2025 with page HTML `pageAt(i)`, after the EARLIEST one. */
function site(pageAt: (i: number) => string, n = 20): { rows: CaptureRow[]; pages: Record<string, string> } {
  const inRange = Array.from({ length: n }, (_, i) => ({ timestamp: ts(i), digest: `D${i}` }));
  return { rows: [EARLIEST, ...inRange], pages: Object.fromEntries(inRange.map((r, i) => [r.timestamp, pageAt(i)])) };
}
const copies = (copyAt: (i: number) => string, n = 20) => site((i) => html(copyAt(i)), n);

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

/**
 * Runs the tool and checks the result against the published output schema. The search tests are written
 * for eight samples of twenty captures (0, 3, 5, 8, 11, 14, 16, 19, read in the order 0, 19, 8, 3, 14, 5,
 * 11, 16), so the sample size is eight here; the default has its own tests.
 */
async function call(
  input: PageHistoryInput,
  archive: ArchiveFetch,
  opts: { cache?: Cache; now?: () => number; maxFetches?: number; deadlineMs?: number } = {},
): Promise<PageHistoryResult> {
  const { maxFetches, deadlineMs, ...rest } = opts;
  const result = await pageHistory(input, await depsFor(archive, rest), { maxFetches, deadlineMs, sampleSize: 8 });
  expect(schema.safeParse(result).error).toBeUndefined();
  return result;
}

/** Runs the tool with the production sample size, checked against the output schema like call(). */
async function callDefault(input: PageHistoryInput, archive: ArchiveFetch): Promise<PageHistoryResult> {
  const result = await pageHistory(input, await depsFor(archive));
  expect(schema.safeParse(result).error).toBeUndefined();
  return result;
}

/** Nineteen changes whose title, headline and subheadings are 200 characters each, with eight prices. */
function worstCase() {
  const long = (label: string, i: number) => `${label} ${i} `.padEnd(200, "x");
  const prices = (i: number) =>
    Array.from({ length: 8 }, (_, k) => `Plan number ${k} for team ${i} costs $${i * 10 + k}/month`).join(". ");
  return site(
    (i) =>
      `<html><head><title>${long("Title", i)}</title><meta name="description" content="${long("About", i)}"></head><body>` +
      `<h1>${long("Headline", i)}</h1><h2>${long("One", i)}</h2><h2>${long("Two", i)}</h2><h2>${long("Three", i)}</h2>` +
      `<p>${prices(i)}</p></body></html>`,
  );
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

  it("says 1 more change, not 1 more changes", async () => {
    const fake = fakeArchive(copies((i) => `Copy ${String.fromCharCode(65 + Math.min(i, 16))}`));
    const r = await call({ ...JAN, max_changes: 15 }, fake);
    expect(r.changes).toHaveLength(15);
    expect(r.notes).toContain("1 more change not shown; call again with a narrower range");
  });

  it("samples sixteen captures by default before it bisects", async () => {
    // On a six-year homepage history, eight samples sat nine months apart and hid whole positioning
    // eras inside one bracket; earliest-first bisection never reached the later ones in two calls.
    const fake = fakeArchive(copies(() => "Alpha", 31));
    const r = await callDefault(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.fetches_used).toBe(2 + 16);
  });

  it("bisects between sixteen samples, earliest bracket first", async () => {
    // Thirty-one captures sample every other one (0, 2, …, 30). Copy changes at 7 and at 23, so
    // brackets (6,8) and (22,24) each take one more capture to pin.
    const fake = fakeArchive(copies((i) => (i < 7 ? "Alpha" : i < 23 ? "Bravo" : "Charlie"), 31));
    const r = await callDefault(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.changes!.map((c) => [c.before.timestamp, c.after.timestamp, c.resolved])).toEqual([
      [ts(6), ts(7), true],
      [ts(22), ts(23), true],
    ]);
    expect(r.fetches_used).toBe(2 + 16 + 2);
    // Both bisection reads come after every sample, the earlier bracket's first.
    expect(fake.calls.slice(-2)).toEqual([expect.stringContaining(`/web/${ts(7)}id_/`), expect.stringContaining(`/web/${ts(23)}id_/`)]);
  });

  it.each([
    ["the fetch budget", { maxFetches: 2 }, 2, [[0, 19]]],
    ["the deadline", { deadline: true }, 3, [[8, 19]]],
  ] as const)("a stop at %s during sampling still covers the last capture", async (_, how, read, expected) => {
    // Copy changes at 17, between the last two samples (16 and 19). Samples are read both ends
    // first, then middles (0, 19, 8, 3, …), so a stop leaves wide brackets across the whole range
    // rather than an unchecked tail.
    let t = NOW;
    const fake = fakeArchive(copies((i) => (i < 17 ? "Alpha" : "Bravo")));
    // For the deadline, every request takes five seconds: captures start at 10, 15 and 20 s, not 25.
    const slow: ArchiveFetch = async (url, opts) => {
      t += 5_000;
      return fake(url, opts);
    };
    const r =
      "deadline" in how ? await call(JAN, slow, { now: () => t }) : await call(JAN, fake, { maxFetches: how.maxFetches });
    expect(r.status).toBe("partial");
    expect(pairs(r)).toEqual(expected.map(([i, j]) => [ts(i), ts(j)]));
    expect(r.changes!.every((c) => !c.resolved)).toBe(true);
    expect(r.notes).toContain(
      `${8 - read} of 8 samples weren't read, so the brackets are wider than usual and may each hide more than one change`,
    );
    expect(r.notes.some((n) => n.includes("weren't checked"))).toBe(false);
  });

  it("works on the earliest bracket first", async () => {
    // Brackets (0,3) and (16,19) after sampling. Earliest first, two more fetches pin
    // the first change and the budget runs out on the second; latest first would do the reverse.
    const fake = fakeArchive(copies((i) => (i < 2 ? "Alpha" : i < 17 ? "Bravo" : "Charlie")));
    const r = await call(JAN, fake, { maxFetches: 10 });
    expect(r.status).toBe("partial");
    expect(r.changes!.map((c) => [c.before.timestamp, c.after.timestamp, c.resolved])).toEqual([
      [ts(1), ts(2), true],
      [ts(16), ts(19), false],
    ]);
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
    // Samples are read both ends first, then middles: 0, 19, 8, 3. The change sits between 3 and 8.
    expect(pairs(r)).toEqual([[ts(3), ts(8)]]);
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
    expect(
      r.notes.some(
        (n) => n.includes("archive refused") && n.includes("source_rate_limited") && n.includes("wait a few minutes"),
      ),
    ).toBe(true);
    expect(fake.calls).toHaveLength(5);
    expect(r.fetches_used).toBe(5);
    // Samples 0 and 19 (both ends first) were read before the refusal; their change stays wide.
    expect(pairs(r)).toEqual([[ts(0), ts(19)]]);
    expect(r.changes![0].resolved).toBe(false);
    expect(r.first_capture?.timestamp).toBe(EARLIEST.timestamp);
  });

  it("after a stop, a bracket with nothing unread inside is still resolved", async () => {
    // Six captures, all sampled, read 0, 5, 2, 1, 3, 4; the fifth capture fetch (call 7, capture 3)
    // fails after A (0), C (5), B (2) and A (1) are read. (1,2) has nothing unread inside, so it is
    // resolved; (2,5) still has 3 and 4 unread, so it stays wide.
    const fake = fakeArchive({ ...copies((i) => ["Alpha", "Alpha", "Bravo", "Bravo", "Charlie", "Charlie"][i], 6), failAt: 7 });
    const r = await call(JAN, fake);
    expect(r.status).toBe("partial");
    expect(r.changes!.map((c) => [c.before.timestamp, c.after.timestamp, c.resolved])).toEqual([
      [ts(1), ts(2), true],
      [ts(2), ts(5), false],
    ]);
    expect(r.notes.some((n) => n.includes("still wide") && n.includes(`${dateOf(2)} to ${dateOf(5)}`))).toBe(true);
    expect(fake.calls).toHaveLength(7);
  });

  it("a capture the archive answers 404 for is skipped, and the change is still pinned", async () => {
    const data = copies((i) => (i < 13 ? "Alpha" : "Bravo"));
    delete data.pages[ts(12)];
    const fake = fakeArchive(data);
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.changes!.map((c) => [c.before.timestamp, c.after.timestamp, c.resolved])).toEqual([[ts(11), ts(13), true]]);
    expect(fake.calls.some((u) => u.includes(`/web/${ts(12)}id_/`))).toBe(true);
  });

  it("any other capture failure stops the call, and suggests a narrower range", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const flaky: ArchiveFetch = async (url, opts) => {
      const out = await fake(url, opts);
      return url.includes(`/web/${ts(5)}id_/`)
        ? { ok: false, reason: "source_unavailable", status: 500, url, detail: "HTTP 500" }
        : out;
    };
    const r = await call(JAN, flaky);
    expect(r.status).toBe("partial");
    const note = r.notes.find((n) => n.includes("archive refused"));
    expect(note).toContain("source_unavailable");
    expect(note).toContain("narrower range");
    expect(note).not.toContain("wait a few minutes");
    // Two index queries, samples 0, 19, 8, 3 and 14 (both ends, then middles), then the failed
    // sample 5, never retried.
    expect(fake.calls).toHaveLength(8);
    expect(fake.calls.filter((u) => u.includes(`/web/${ts(5)}id_/`))).toHaveLength(1);
  });

  it("an index answer at its row limit is partial", async () => {
    const stamp = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString().replace(/\D/g, "").slice(0, 14);
    const rows = Array.from({ length: 2000 }, (_, i) => ({ timestamp: stamp(i), digest: `D${i}` }));
    const pages = Object.fromEntries(rows.map((r) => [r.timestamp, html("Alpha")]));
    const r = await call(JAN, fakeArchive({ rows, pages }));
    expect(r.captures_in_range).toBe(2000);
    expect(r.status).toBe("partial");
    expect(r.notes.some((n) => n.includes("limit of 2000"))).toBe(true);
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
    // Index queries end at 20 s; the first capture starts before the 22 s deadline, the second would start after.
    expect(fake.calls).toHaveLength(3);
  });

  it("starts no capture fetch after 22 s, so a slow last answer still ends the call near 30 s", async () => {
    let t = NOW;
    const fake = fakeArchive(copies(() => "Alpha"));
    // Every archive request takes six seconds: captures start at 12, 18 and 24 s.
    const slow: ArchiveFetch = async (url, opts) => {
      t += 6_000;
      return fake(url, opts);
    };
    const r = await call(JAN, slow, { now: () => t });
    expect(r.status).toBe("partial");
    expect(r.notes.some((n) => n.includes("time limit of 22 s"))).toBe(true);
    // Two index queries and the captures started at 12 and 18 s; the one at 24 s never starts.
    expect(fake.calls).toHaveLength(4);
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

  it("when every capture from the middle to j is unreadable, the search turns toward i", async () => {
    // Samples 3 and 5 are unreadable, so the bracket is (0,8); 4, 6 and 7 are unreadable too.
    const page = (i: number) =>
      i >= 3 && i <= 7 ? `<div id="root"></div>` : html(i < 2 ? "Alpha" : "Bravo");
    const r = await call(JAN, fakeArchive(site(page)));
    expect(r.status).toBe("ok");
    expect(r.changes!.map((c) => [c.before.timestamp, c.after.timestamp, c.resolved])).toEqual([[ts(1), ts(2), true]]);
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

  it("a homepage's captures are fetched at the address the archive stores, so none needs a redirect", async () => {
    // The archive keeps homepage captures under https://example.com/ and answers the bare
    // https://example.com with a redirect to it, which costs a second request every time.
    const fake = fakeArchive(copies((i) => (i < 13 ? "Alpha" : "Bravo")));
    const r = await call({ ...JAN, url: "https://example.com" }, fake);
    const captures = fake.calls.filter((u) => u.includes("id_/"));
    expect(captures.length).toBeGreaterThan(0);
    for (const u of captures) expect(u).toMatch(/id_\/https:\/\/example\.com\/$/);
    expect(r.url).toBe("https://example.com/");
    expect(r.changes![0].after.link).toBe(`https://web.archive.org/web/${ts(13)}/https://example.com/`);
  });

  it("the largest result stays under the cap", async () => {
    const r = await call({ ...JAN, max_changes: 15 }, fakeArchive(worstCase()));
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

  it("the worst-case render stops at 4000 characters, at a line break, with a pointer to the structured result", async () => {
    const r = await call({ ...JAN, max_changes: 15 }, fakeArchive(worstCase()));
    const full = renderPageHistory(r);
    expect(full.length).toBeGreaterThan(4000);
    const text = render("page_history", r);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.endsWith(`\n${MORE_LINE}`)).toBe(true);
    const kept = text.slice(0, -MORE_LINE.length - 1);
    expect(full.startsWith(`${kept}\n`)).toBe(true);
    // The notes come before the change lines, so the cap keeps them.
    for (const n of r.notes) expect(text).toContain(`note: ${n}`);
    expect(text.indexOf("note: ")).toBeLessThan(text.indexOf("- between "));
  });

  it("a short render is unchanged", async () => {
    const r = await call(JAN, fakeArchive(copies((i) => (i <= 8 ? "Alpha" : i <= 10 ? "Bravo" : "Charlie"))));
    expect(render("page_history", r)).toBe(renderPageHistory(r));
  });

  it("renders an error with the fallback line", () => {
    const text = renderPageHistory(errorResult("bad_input", "IP addresses are not accepted", [], NOW));
    expect(text).toContain("bad_input");
    expect(text).toContain("fall back to browsing for this check.");
  });
});
