import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorResult } from "../../src/contract/envelope";
import { pageHistoryOutput, type PageHistoryInput, type PageHistoryResult } from "../../src/contract/tools";
import type { ArchiveFetch } from "../../src/shared/http";
import type { CaptureRow } from "../../src/sources/wayback";
import { callDeps, MORE_LINE, render, type ToolDeps } from "../../src/tools";
import { pageHistory, renderPageHistory } from "../../src/tools/page-history";
import { Subrequests } from "../../src/shared/subrequests";
import { fakeArchive, type FakeArchive } from "../helpers/fake-archive";
import { fakeFetch } from "../helpers/fake-fetch";
import { meter } from "../helpers/meter";

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
    subrequests: new Subrequests(45),
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
    // Two index queries, eight samples, captures 12 and 13, then the first capture's copy.
    expect(fake.calls).toHaveLength(13);
    expect(r.fetches_used).toBe(13);
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

  it("over max_changes, keeps the changes with the most title and headline words changed, in date order", async () => {
    // Every capture renames a section; three of them also start a new headline.
    const era = (i: number) =>
      i < 5 ? "Sync data to every tool" : i < 12 ? "The composable customer data platform" : i < 17 ? "Marketing needs data and AI" : "Make your marketers limitless";
    const fake = fakeArchive(site((i) => `<title>Example</title><h1>${era(i)}</h1><h2>Section ${i}</h2>`));
    const r = await call({ ...JAN, max_changes: 3 }, fake);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual([
      [ts(4), ts(5)],
      [ts(11), ts(12)],
      [ts(16), ts(17)],
    ]);
  });

  it("counts each price gained or lost as more than a word of the title", async () => {
    // A three-word title change at capture 7, then a price change at capture 14.
    const page = (i: number) =>
      `<title>${i < 7 ? "Example" : "Example for growing teams"}</title><h1>Plans</h1><p>Team plan costs ${i < 14 ? "$350" : "$400"}/month</p>`;
    const r = await call({ ...JAN, max_changes: 1 }, fakeArchive(site(page)));
    expect(pairs(r)).toEqual([[ts(13), ts(14)]]);
  });

  it("breaks ties by subheading words before date", async () => {
    // A five-word subheading change at capture 5; a change in the meta description only at capture 14.
    const page = (i: number) =>
      `<title>Example</title><meta name="description" content="${i < 14 ? "One" : "Two"}"><h1>Plans</h1>` +
      `<h2>${i < 5 ? "Teams" : "Teams of every size and shape"}</h2>`;
    const r = await call({ ...JAN, max_changes: 1 }, fakeArchive(site(page)));
    expect(pairs(r)).toEqual([[ts(4), ts(5)]]);
  });

  it("between changes of the same size, keeps the later ones, and says how many more there are", async () => {
    const fake = fakeArchive(copies((i) => `Copy ${String.fromCharCode(65 + i)}`));
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual(Array.from({ length: 10 }, (_, k) => [ts(k + 9), ts(k + 10)]));
    expect(r.notes).toContain(
      `9 more changes not shown, the ones that changed the least copy, dated ${[1, 2, 3, 4, 5].map(dateOf).join(", ")} and 4 more; call again with max_changes up to 15 to see more`,
    );
  });

  it("at max_changes 15, names a narrower range that shows the first hidden change", async () => {
    // Twenty captures a month apart from 2025-01, each a different copy: nineteen changes.
    const monthly = (i: number) => new Date(Date.UTC(2025, i, 1, 12)).toISOString().replace(/\D/g, "").slice(0, 14);
    const rows = [EARLIEST, ...Array.from({ length: 20 }, (_, i) => ({ timestamp: monthly(i), digest: `D${i}` }))];
    const pages = Object.fromEntries(rows.slice(1).map((r, i) => [r.timestamp, html(`Copy ${String.fromCharCode(65 + i)}`)]));
    const r = await call({ url: PAGE, from: "2025-01", to: "2026-08", max_changes: 15 }, fakeArchive({ rows, pages }));
    expect(r.changes).toHaveLength(15);
    // The hidden changes are the four earliest; the first is between the 2025-01 and 2025-02 captures.
    expect(r.notes).toContain(
      "4 more changes not shown, the ones that changed the least copy, dated 2025-02-01, 2025-03-01, 2025-04-01, 2025-05-01; call again with a narrower range to see them, such as from=2025-01 to=2025-02 for the first",
    );
  });

  it("says 1 more change, not 1 more changes", async () => {
    const fake = fakeArchive(copies((i) => `Copy ${String.fromCharCode(65 + Math.min(i, 16))}`));
    const r = await call({ ...JAN, max_changes: 15 }, fake);
    expect(r.changes).toHaveLength(15);
    // The hidden change is in the range's only month, so no narrower range is named.
    expect(r.notes).toContain(`1 more change not shown, the one that changed the least copy, dated ${dateOf(1)}`);
  });

  it("samples sixteen captures by default before it bisects", async () => {
    // On a six-year homepage history, eight samples sat nine months apart and hid whole positioning
    // eras inside one bracket; earliest-first bisection never reached the later ones in two calls.
    const fake = fakeArchive(copies(() => "Alpha", 31));
    const r = await callDefault(JAN, fake);
    expect(r.status).toBe("ok");
    // Two index queries, sixteen samples, and the first capture's copy.
    expect(r.fetches_used).toBe(2 + 16 + 1);
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
    expect(r.fetches_used).toBe(2 + 16 + 2 + 1);
    // Both bisection reads come after every sample, the earlier bracket's first; the first capture's copy is read last.
    expect(fake.calls.slice(-3)).toEqual([
      expect.stringContaining(`/web/${ts(7)}id_/`),
      expect.stringContaining(`/web/${ts(23)}id_/`),
      expect.stringContaining(`/web/${EARLIEST.timestamp}id_/`),
    ]);
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

  it("skips a listed capture whose replay is a recorded error, as it does an unreadable one", async () => {
    // zeroclick.ai on 2026-10-26: the index listed 20241202193137 as a 200, but its replay is the domain's
    // previous owner's 403 page, served with 403 and memento-datetime. It was the first sample read.
    const fake = fakeArchive({
      ...copies((i) => (i < 13 ? "Alpha" : "Bravo")),
      failures: { [ts(0)]: { status: 403, recorded: true } },
    });
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual([[ts(12), ts(13)]]);
    expect(r.changes![0].resolved).toBe(true);
    expect(r.notes.join(" ")).not.toContain("archive refused");
    expect(r.notes.some((n) => n.startsWith("1 capture had no readable copy"))).toBe(true);
  });

  it("still stops at a 403 without the replay marker, as the archive refusing", async () => {
    const fake = fakeArchive({
      ...copies((i) => (i < 13 ? "Alpha" : "Bravo")),
      failures: { [ts(0)]: { status: 403 } },
    });
    const r = await call(JAN, fake);
    expect(r.status).toBe("partial");
    expect(r.notes.some((n) => n.includes("archive refused") && n.includes("HTTP 403"))).toBe(true);
    expect(r.changes).toEqual([]);
  });

  it("keeps a recorded error capture, so a repeat call doesn't fetch it again", async () => {
    const data = { ...copies((i) => (i < 13 ? "Alpha" : "Bravo")), failures: { [ts(0)]: { status: 403, recorded: true } } };
    const cache = await caches.open(`page-history-${crypto.randomUUID()}`);
    await call(JAN, fakeArchive(data), { cache });
    const again = fakeArchive(data);
    const r = await call(JAN, again, { cache });
    expect(again.calls.some((u) => u.includes(`/web/${ts(0)}id_/`))).toBe(false);
    expect(r.status).toBe("ok");
    expect(pairs(r)).toEqual([[ts(12), ts(13)]]);
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

  it("cuts a capture still running at the hard deadline and returns what's done as partial", async () => {
    const fake = fakeArchive(copies((i) => (i < 13 ? "Alpha" : "Bravo")));
    // Samples are read 0, 19, 8, …; the archive never answers for capture 8.
    const stuck: ArchiveFetch = (url, opts) => (url.includes(`/web/${ts(8)}id_/`) ? new Promise(() => {}) : fake(url, opts));
    const r = await pageHistory(JAN, await depsFor(stuck), { sampleSize: 8, hardDeadlineMs: 50 });
    expect(schema.safeParse(r).error).toBeUndefined();
    expect(r.status).toBe("partial");
    expect(pairs(r)).toEqual([[ts(0), ts(19)]]);
    expect(r.notes.some((n) => /^time limit of \d+ s reached/.test(n))).toBe(true);
    expect(r.notes.join(" ")).not.toContain("archive refused");
  });

  it("asks the archive gate to start every request by the 22 s mark", async () => {
    const fake = fakeArchive(copies((i) => (i < 13 ? "Alpha" : "Bravo")));
    const seen: (number | undefined)[] = [];
    const watched: ArchiveFetch = (url, opts) => {
      seen.push(opts?.startBy);
      return fake(url, opts);
    };
    await call(JAN, watched);
    // Twelve requests for the search, then the first capture's copy.
    expect(seen.length).toBe(13);
    expect(new Set(seen)).toEqual(new Set([NOW + 22_000]));
  });

  it("a request the archive queue would start too late stops the call as a time limit", async () => {
    const fake = fakeArchive(copies(() => "Alpha"));
    const late: ArchiveFetch = async (url, opts) =>
      url.includes(`/web/${ts(8)}id_/`)
        ? { ok: false, reason: "server_busy", status: 599, url, detail: "the archive queue would start this request too late" }
        : fake(url, opts);
    const r = await call(JAN, late);
    expect(r.status).toBe("partial");
    expect(r.notes.some((n) => n.startsWith("time limit of"))).toBe(true);
    expect(r.notes.join(" ")).not.toContain("archive refused");
  });

  it("starts no index query after 22 s", async () => {
    let t = NOW;
    const fake = fakeArchive(copies(() => "Alpha"));
    const slow: ArchiveFetch = async (url, opts) => {
      t += 23_000;
      return fake(url, opts);
    };
    const r = await call(JAN, slow, { now: () => t });
    expect(r.status).toBe("error");
    expect(r.error?.reason).toBe("server_busy");
    expect(r.error?.detail).toContain("time limit of 22 s");
    expect(fake.calls).toHaveLength(1);
  });

  it("a failed earliest-capture lookup is a note, and first_capture is null", async () => {
    const fake = fakeArchive({ ...copies((i) => (i < 13 ? "Alpha" : "Bravo")), failAt: 1 });
    const r = await call(JAN, fake);
    expect(r.status).toBe("partial");
    expect(r.first_capture).toBeNull();
    expect(r.notes.some((n) => n.includes("archive refused") && n.includes("earliest"))).toBe(true);
    expect(pairs(r)).toEqual([[ts(12), ts(13)]]);
  });

  it("a full queue on this server is named as this server's, never as the archive refusing", async () => {
    const fake = fakeArchive(copies((i) => (i < 13 ? "Alpha" : "Bravo")));
    const busy: ArchiveFetch = async (url, opts) =>
      url.includes(`/web/${ts(8)}id_/`) ? { ok: false, reason: "server_busy", url, detail: "this server's archive queue is full" } : fake(url, opts);
    const r = await call(JAN, busy);
    expect(r.status).toBe("partial");
    expect(r.notes).toContain(
      "this server's archive queue is full (server_busy), so the search stopped there without retrying; wait a few minutes before calling again",
    );
    expect(r.notes.join(" ")).not.toContain("archive refused");
  });

  it("a failed capture listing is an error with its reason", async () => {
    const fake = fakeArchive({ ...copies(() => "Alpha"), failAt: 2 });
    const r = await call(JAN, fake);
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ reason: "source_rate_limited", fallback: "fall back to browsing for this check." });
    expect(fake.calls).toHaveLength(2);
  });

  it("a failed capture listing keeps the notes from before it", async () => {
    // As on staging: the earliest-capture lookup is refused, and the gate then pauses the listing.
    const fake = fakeArchive({ ...copies(() => "Alpha"), failAt: 1 });
    const paused: ArchiveFetch = async (url, opts) =>
      fake.calls.length >= 1 ? { ok: false, reason: "source_rate_limited", url, detail: "archive requests paused after a refusal" } : fake(url, opts);
    const r = await call(JAN, paused);
    expect(r.status).toBe("error");
    expect(r.error?.detail).toBe("archive requests paused after a refusal");
    expect(r.notes.some((n) => n.includes("archive refused") && n.includes("earliest") && n.includes("HTTP 429"))).toBe(true);
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
    const changing = copies((i) => (i <= 8 ? "Alpha" : i <= 10 ? "Bravo" : "Charlie"));
    // A first capture that answers 404 isn't cached, any more than an in-range one is, so this one reads.
    const data = { ...changing, pages: { ...changing.pages, [EARLIEST.timestamp]: html("Earliest") } };
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
    expect(r.notes.some((n) => n.includes("more changes not shown, the ones that changed the least copy"))).toBe(true);
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

  it("renders an error's notes after its first line", () => {
    const failed = errorResult("source_rate_limited", "archive requests paused after a refusal", [], NOW);
    const text = renderPageHistory({ ...failed, notes: ["archive refused the earliest-capture lookup (HTTP 429)"] });
    expect(text.split("\n")).toEqual([
      "page_history failed (source_rate_limited): archive requests paused after a refusal. fall back to browsing for this check.",
      "note: archive refused the earliest-capture lookup (HTTP 429)",
    ]);
  });
});

describe("page_history: the first capture's copy", () => {
  // hightouch.com/pricing on 2026-10-26: first_capture was 2022-07-08, and the ChatGPT app can't open
  // archive links, so the skill couldn't check whose page it was. The capture's own title says.
  const earliestRaw = `https://web.archive.org/web/${EARLIEST.timestamp}id_/${PAGE}`;
  const withFirst = (copy: string) => {
    const s = copies((i) => (i < 13 ? "Alpha" : "Bravo"));
    return { ...s, pages: { ...s.pages, [EARLIEST.timestamp]: html(copy) } };
  };

  it("carries the first capture's title and headline, to check who held the address", async () => {
    const r = await call(JAN, fakeArchive(withFirst("Someone Else")));
    expect(r.status).toBe("ok");
    expect(r.first_capture).toMatchObject({ timestamp: EARLIEST.timestamp, title: "Someone Else | Example", headline: "Plans for Someone Else" });
  });

  it("reads it once, and from the cache after", async () => {
    const cache = await caches.open(`page-history-${crypto.randomUUID()}`);
    const first = fakeArchive(withFirst("Someone Else"));
    await call(JAN, first, { cache });
    expect(first.calls.filter((u) => u === earliestRaw)).toHaveLength(1);
    const again = fakeArchive(withFirst("Someone Else"));
    const r = await call(JAN, again, { cache });
    expect(again.calls).not.toContain(earliestRaw);
    expect(r.first_capture?.title).toBe("Someone Else | Example");
  });

  it("a first capture that can't be read leaves its copy out, and the result ok", async () => {
    const r = await call(JAN, fakeArchive(copies((i) => (i < 13 ? "Alpha" : "Bravo"))));
    expect(r.status).toBe("ok");
    expect(r.first_capture?.timestamp).toBe(EARLIEST.timestamp);
    expect(r.first_capture).not.toHaveProperty("title");
    expect(r.first_capture).not.toHaveProperty("headline");
  });

  it("a refused first-capture read says to wait, since the archive gate now pauses, and stays ok", async () => {
    const fake = fakeArchive({ ...withFirst("Someone Else"), failures: { [EARLIEST.timestamp]: { status: 429 } } });
    const r = await call(JAN, fake);
    expect(r.status).toBe("ok");
    expect(r.changes).toHaveLength(1);
    expect(r.first_capture).not.toHaveProperty("title");
    const note = r.notes.find((n) => n.includes("first capture's copy"));
    expect(note).toContain("source_rate_limited");
    expect(note).toContain("wait a few minutes before calling again");
  });

  it("a first capture that fails for another reason just leaves its copy out", async () => {
    const r = await call(JAN, fakeArchive({ ...withFirst("Someone Else"), failures: { [EARLIEST.timestamp]: { status: 500 } } }));
    expect(r.status).toBe("ok");
    expect(r.first_capture).not.toHaveProperty("title");
    expect(r.notes).toEqual([]);
  });

  it("a search the budget stops spends nothing on the first capture", async () => {
    const fake = fakeArchive(withFirst("Someone Else"));
    const r = await call(JAN, fake, { maxFetches: 3 });
    expect(r.status).toBe("partial");
    expect(fake.calls).not.toContain(earliestRaw);
    expect(r.first_capture).not.toHaveProperty("title");
  });

  it("renders the first capture's title", async () => {
    const r = await call(JAN, fakeArchive(withFirst("Someone Else")));
    expect(renderPageHistory(r)).toContain(`first captured 2020-03-01 ("Someone Else | Example"): https://web.archive.org/web/${EARLIEST.timestamp}/${PAGE}`);
  });

  it("the largest result, with a long first title, stays under the cap", async () => {
    const s = worstCase();
    const long = "First ".padEnd(200, "y");
    const page = `<html><head><title>${long}</title></head><body><h1>${long}</h1></body></html>`;
    const r = await call({ ...JAN, max_changes: 15 }, fakeArchive({ ...s, pages: { ...s.pages, [EARLIEST.timestamp]: page } }));
    expect(r.first_capture?.title?.startsWith("First ")).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
  });
});

describe("page_history: subrequests on a cold cache", () => {
  it("31 captures, each a different copy, stop at the limit of 45 cache calls with partial, and say to call again", async () => {
    // Archive requests go to the Limits object and count against its own requests; only cache calls count here.
    const m = meter(fakeFetch({}), await caches.open(`page-history-${crypto.randomUUID()}`));
    const fake = fakeArchive(copies((i) => `Copy ${i}`, 31));
    const deps = callDeps({ fetch: m.fetch, archive: fake, cache: m.cache, now: () => NOW }, 45, "test");
    const r = await pageHistory(JAN, deps);
    expect(schema.safeParse(r).error).toBeUndefined();
    expect(m.counts.fetch).toBe(0);
    expect(m.total()).toBeLessThanOrEqual(45);
    expect(r.status).toBe("partial");
    // Two index queries, the 16 samples and 4 bisection reads: a read and a write each.
    expect(fake.calls).toHaveLength(2 + 20);
    const note = r.notes.find((n) => n.includes("per-request limit of 45 subrequests"));
    expect(note).toContain("call again with the same input to continue");
    expect(r.notes.join(" ")).not.toContain("archive refused");
  });

  it("a repeat call reads what the first one cached and goes further", async () => {
    const cache = await caches.open(`page-history-${crypto.randomUUID()}`);
    const data = copies((i) => `Copy ${i}`, 31);
    const first = fakeArchive(data);
    await pageHistory(JAN, callDeps({ fetch: fakeFetch({}), archive: first, cache, now: () => NOW }, 45, "test"));
    const again = fakeArchive(data);
    const r = await pageHistory(JAN, callDeps({ fetch: fakeFetch({}), archive: again, cache, now: () => NOW }, 45, "test"));
    expect(again.calls.length).toBeGreaterThan(0);
    expect(again.calls.every((u) => !u.includes("/cdx/"))).toBe(true);
    expect(r.changes!.filter((c) => c.resolved).length).toBeGreaterThan(4);
  });
});
