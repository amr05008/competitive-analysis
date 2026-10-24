import { PAGE_HISTORY_DEADLINE_MS, PAGE_HISTORY_MAX_FETCHES, RESPONSE_CAP_CHARS, SAMPLE_SIZE } from "../config";
import { errorResult, utcDay } from "../contract/envelope";
import type { PageHistoryInput, PageHistoryResult } from "../contract/tools";
import { Budget } from "../shared/budget";
import { REFUSED_STATUS, type ArchiveFetch, type FailedOutcome, type FetchOutcome } from "../shared/http";
import { normalizePageUrl } from "../shared/inputs";
import { limitReached } from "../shared/subrequests";
import { copyKey, type Fingerprint } from "../sources/fingerprint";
import { CDX_LIMIT, captureLink, earliestCapture, fingerprintAt, listCaptures, type CaptureRow } from "../sources/wayback";
import type { ToolDeps } from ".";

type Change = NonNullable<PageHistoryResult["changes"]>[number];
type Snapshot = Change["before"];
type CaptureFields = NonNullable<PageHistoryResult["first_capture"]>;

const EARLIEST_MONTH = "1996-01";
const DEFAULT_MONTHS = 24;
const DEFAULT_MAX_CHANGES = 10;
const MAX_CHANGES = 15;
/** Every capture link repeats the page address, so a long one could push a result past the cap. */
const MAX_URL_CHARS = 500;
const MAX_DETAIL_CHARS = 200;
const MAX_WIDE_LISTED = 5;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ inputs

const MONTH = /^(\d{4})-(\d{2})$/;

/** Months since year 0, or null when `s` isn't a real month as YYYY-MM. */
function monthIndex(s: string): number | null {
  const m = MONTH.exec(s);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? Number(m[1]) * 12 + month - 1 : null;
}

const monthString = (index: number): string =>
  `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;

/** The months to search: `to` defaults to this month, `from` to 24 months before `to`, and nothing before 1996-01. */
function resolveRange(
  input: PageHistoryInput,
  now: number,
): { ok: true; from: string; to: string } | { ok: false; detail: string } {
  const earliest = monthIndex(EARLIEST_MONTH) as number;
  const today = new Date(now);
  const to = input.to === undefined ? today.getUTCFullYear() * 12 + today.getUTCMonth() : monthIndex(input.to);
  if (to === null) return { ok: false, detail: "to must be a month as YYYY-MM" };
  if (to < earliest) return { ok: false, detail: `to is before ${EARLIEST_MONTH}, the earliest month allowed` };
  const from = input.from === undefined ? Math.max(earliest, to - DEFAULT_MONTHS) : monthIndex(input.from);
  if (from === null) return { ok: false, detail: "from must be a month as YYYY-MM" };
  if (from < earliest) return { ok: false, detail: `from is before ${EARLIEST_MONTH}, the earliest month allowed` };
  if (from > to) return { ok: false, detail: "from is after to" };
  return { ok: true, from: monthString(from), to: monthString(to) };
}

function maxChangesOf(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_MAX_CHANGES;
  return Math.min(MAX_CHANGES, Math.max(1, Math.floor(n)));
}

// -------------------------------------------------------------- timestamps

const TIMESTAMP = /^\d{14}$/;

const dateOf = (ts: string): string => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
const monthOf = (ts: string): string => `${ts.slice(0, 4)}-${ts.slice(4, 6)}`;

function msOf(ts: string): number {
  const n = (a: number, b: number) => Number(ts.slice(a, b));
  return Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(8, 10), n(10, 12), n(12, 14));
}

/** Well-formed captures, oldest first, one per timestamp. */
function distinct(rows: CaptureRow[]): CaptureRow[] {
  const sorted = rows.filter((r) => TIMESTAMP.test(r.timestamp)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return sorted.filter((r, k) => k === 0 || r.timestamp !== sorted[k - 1].timestamp);
}

const captureFields = (ts: string, url: string): CaptureFields => ({
  timestamp: ts,
  date: dateOf(ts),
  link: captureLink(ts, url),
});

// ------------------------------------------------------------------ search

type Read = { fp: Fingerprint; key: string } | "unreadable";
type Stop = { kind: "budget" } | { kind: "deadline" } | { kind: "subrequests" } | { kind: "refused"; failure: FailedOutcome };
type Bracket = { i: number; j: number; resolved: boolean };
type Search = {
  reads: (Read | undefined)[];
  brackets: Bracket[];
  stop: Stop | null;
  /** How many of the samples were fetched before any stop, out of how many there are. */
  samplesRead: number;
  samplesTotal: number;
};

/**
 * Ranks 0…count−1 coarse to fine: both ends, then the middle of each gap, widest gaps first. Read in
 * this order, samples cut short by a stop still span the whole range, with wider brackets.
 */
function coarseToFine(count: number): number[] {
  if (count <= 1) return count === 1 ? [0] : [];
  const order = [0, count - 1];
  const gaps: [number, number][] = [[0, count - 1]];
  for (let g = 0; g < gaps.length; g++) {
    const [a, b] = gaps[g];
    if (b - a < 2) continue;
    const m = Math.floor((a + b) / 2);
    order.push(m);
    gaps.push([a, m], [m, b]);
  }
  return order;
}

/**
 * The index to read between i and j: the middle, or the nearest unread capture
 * toward j, then toward i. Null when every capture between them is read, which
 * inside a bracket means unreadable.
 */
function middle(reads: (Read | undefined)[], i: number, j: number): number | null {
  const mid = Math.floor((i + j) / 2);
  for (let k = mid; k < j; k++) if (k > i && reads[k] === undefined) return k;
  for (let k = mid - 1; k > i; k--) if (reads[k] === undefined) return k;
  return null;
}

/**
 * Samples `sampleSize` captures evenly, read coarse to fine (both ends, then
 * middles), then bisects between readable samples in date order whose copy
 * differs, earliest bracket first, until each change sits between
 * two captures with no readable one between them. Stops for good at the first
 * capture fetch the budget or deadline refuses or the hard deadline cuts, or the
 * first archive failure; nothing is retried. Cached fingerprints cost no budget.
 */
async function findChanges(
  captures: CaptureRow[],
  url: string,
  cache: Cache,
  archive: ArchiveFetch,
  budget: Budget,
  sampleSize: number,
): Promise<Search> {
  const n = captures.length;
  const reads: (Read | undefined)[] = new Array(n);
  const state: { stop: Stop | null } = { stop: null };

  // Only uncached capture fetches reach this, so only they cost budget.
  const gated: ArchiveFetch = (u, o) => {
    if (budget.take()) return archive(u, o);
    const why = budget.stopKind ?? "time";
    state.stop = { kind: why === "subrequests" ? "subrequests" : why === "fetches" ? "budget" : "deadline" };
    return Promise.resolve({ ok: false, reason: "server_busy", status: REFUSED_STATUS, url: u, detail: "out of fetches or time" });
  };

  const read = async (i: number): Promise<boolean> => {
    if (state.stop) return false;
    if (reads[i] !== undefined) return true;
    const r = await fingerprintAt(gated, cache, captures[i].timestamp, url);
    if (!r.ok && r.reason === "not_found" && !state.stop) {
      // The index listed a capture the archive can't serve: skip it like an unreadable one.
      reads[i] = "unreadable";
      return true;
    }
    if (!r.ok) {
      // A request this server declined (its own budget, or a queue turn past the start time) or the
      // hard deadline cut is a time stop, not the archive refusing.
      state.stop ??= r.status === REFUSED_STATUS || budget.cut ? { kind: "deadline" } : { kind: "refused", failure: r };
      return false;
    }
    reads[i] = r.fp.readable ? { fp: r.fp, key: copyKey(r.fp) } : "unreadable";
    return true;
  };
  const isReadable = (i: number) => typeof reads[i] === "object";
  const keyAt = (i: number) => (reads[i] as { key: string }).key;

  const samples =
    n === 0
      ? []
      : [...new Set(Array.from({ length: sampleSize }, (_, k) => Math.round((k * (n - 1)) / (sampleSize - 1))))];
  const order = coarseToFine(samples.length);
  let sampled = 0;
  for (const rank of order) {
    if (!(await read(samples[rank]))) break;
    sampled++;
  }

  // Brackets run between the readable samples in date order, however many were read.
  const good = order
    .slice(0, sampled)
    .map((rank) => samples[rank])
    .sort((a, b) => a - b)
    .filter(isReadable);
  const pending: [number, number][] = [];
  for (let s = 1; s < good.length; s++) {
    if (keyAt(good[s - 1]) !== keyAt(good[s])) pending.push([good[s - 1], good[s]]);
  }

  const done: Bracket[] = [];
  while (pending.length && !state.stop) {
    const [i, j] = pending[0];
    const m = middle(reads, i, j);
    if (m === null) {
      pending.shift();
      done.push({ i, j, resolved: true });
      continue;
    }
    if (!(await read(m))) break;
    if (!isReadable(m)) continue; // the same bracket again, stepping past m
    pending.shift();
    const split: [number, number][] = [];
    if (keyAt(m) !== keyAt(i)) split.push([i, m]);
    if (keyAt(m) !== keyAt(j)) split.push([m, j]);
    pending.unshift(...split);
  }

  // A bracket left over after a stop may still have nothing unread inside it.
  return {
    reads,
    brackets: [...done, ...pending.map(([i, j]) => ({ i, j, resolved: middle(reads, i, j) === null }))],
    stop: state.stop,
    samplesRead: sampled,
    samplesTotal: samples.length,
  };
}

// ------------------------------------------------------------------ output

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const failureText = (f: FailedOutcome) => `${f.reason}: ${clip(f.detail, MAX_DETAIL_CHARS)}`;

/** How much of a snapshot's copy is kept; each level is tried in turn until the result fits the cap. */
const LEVELS = [
  { text: Number.POSITIVE_INFINITY, subheadings: Number.POSITIVE_INFINITY, prices: Number.POSITIVE_INFINITY },
  { text: 120, subheadings: 3, prices: 4 },
  { text: 80, subheadings: 2, prices: 3 },
  { text: 60, subheadings: 1, prices: 2 },
];
type Level = (typeof LEVELS)[number];

function snapshot(c: CaptureRow, fp: Fingerprint, url: string, level: Level): Snapshot {
  return {
    ...captureFields(c.timestamp, url),
    title: clip(fp.title, level.text),
    headline: clip(fp.headline, level.text),
    subheadings: fp.subheadings.slice(0, level.subheadings).map((s) => clip(s, level.text)),
    prices: fp.prices.slice(0, level.prices).map((s) => clip(s, level.text)),
  };
}

function stopNote(stop: Stop, maxFetches: number, deadlineMs: number, subrequestLimit: number): string {
  const resume = "call again with the same input to continue, since captures already read cost nothing";
  switch (stop.kind) {
    case "subrequests":
      return `${limitReached(subrequestLimit)}; call again with the same input to continue, since captures already read are cached`;
    case "budget":
      return `fetch budget of ${maxFetches} captures used up; ${resume}`;
    case "deadline":
      return `time limit of ${Math.round(deadlineMs / 1000)} s reached; ${resume}`;
    case "refused": {
      const f = stop.failure;
      // server_busy comes from this server (its archive queue or gate), never from the archive.
      if (f.reason === "server_busy") {
        return `${clip(f.detail, MAX_DETAIL_CHARS)} (server_busy), so the search stopped there without retrying; wait a few minutes before calling again`;
      }
      const advice = f.reason === "source_rate_limited" ? "wait a few minutes before calling again" : "call again with a narrower range";
      return `archive refused a request (${failureText(f)}); stopped there without retrying, so ${advice}`;
    }
  }
}

/** Visible copy only: what the snapshots show, without the meta description. */
const shownKey = (fp: Fingerprint) => copyKey({ ...fp, description: "" });

export async function pageHistory(
  input: PageHistoryInput,
  deps: ToolDeps,
  opts: { maxFetches?: number; deadlineMs?: number; sampleSize?: number; hardDeadlineMs?: number } = {},
): Promise<PageHistoryResult> {
  const maxFetches = opts.maxFetches ?? PAGE_HISTORY_MAX_FETCHES;
  const deadlineMs = opts.deadlineMs ?? PAGE_HISTORY_DEADLINE_MS;
  const sampleSize = Math.max(2, opts.sampleSize ?? SAMPLE_SIZE);

  const page = normalizePageUrl(input.url);
  if (!page.ok) return errorResult("bad_input", page.detail, [], deps.now());
  if (page.url.length > MAX_URL_CHARS) {
    return errorResult("bad_input", `page addresses over ${MAX_URL_CHARS} characters are not accepted`, [], deps.now());
  }
  const range = resolveRange(input, deps.now());
  if (!range.ok) return errorResult("bad_input", range.detail, [], deps.now());
  const maxChanges = maxChangesOf(input.max_changes);

  // The deadline counts from here. The budget gates capture fetches only. Archive requests aren't
  // subrequests of this call, but each capture read needs room for its cache write.
  const budget = new Budget(maxFetches, deadlineMs, deps.now, {
    subrequests: deps.subrequests,
    reserve: 1,
    hardMs: opts.hardDeadlineMs,
  });
  let requests = 0;
  // Every archive request asks the gate to start it by the deadline. The Limits object can't take a
  // signal, so at the hard deadline the call stops waiting for a request still running.
  const archive: ArchiveFetch = (url, o) => {
    requests++;
    return budget.race(
      () => deps.archive(url, { ...o, startBy: budget.startBy }),
      (): FetchOutcome => ({ ok: false, reason: "server_busy", status: REFUSED_STATUS, url, detail: "cut at the call's time limit" }),
    );
  };
  // The two index queries aren't budgeted, but they don't start after the deadline either.
  const indexQuery: ArchiveFetch = (url, o) =>
    budget.timeUp
      ? Promise.resolve({
          ok: false,
          reason: "server_busy",
          status: REFUSED_STATUS,
          url,
          detail: `time limit of ${Math.round(budget.timeLimitMs / 1000)} s reached before this index query`,
        })
      : archive(url, o);
  const notes: string[] = [];

  const earliest = await earliestCapture(indexQuery, deps.cache, page.cdxKey);
  let firstCapture: CaptureFields | null = null;
  if (!earliest.ok) {
    const who = earliest.reason === "server_busy" ? "this server turned away" : "archive refused";
    notes.push(`${who} the earliest-capture lookup (${failureText(earliest)}), so first_capture is missing`);
  } else if (earliest.capture && TIMESTAMP.test(earliest.capture.timestamp)) {
    firstCapture = captureFields(earliest.capture.timestamp, page.url);
  }

  const listed = await listCaptures(
    indexQuery,
    deps.cache,
    page.cdxKey,
    range.from.replace("-", ""),
    range.to.replace("-", ""),
  );
  if (!listed.ok) return errorResult(listed.reason, listed.detail, [listed.url], deps.now());
  const captures = distinct(listed.captures);
  const hitLimit = listed.captures.length >= CDX_LIMIT;
  if (hitLimit) {
    notes.push(
      `the archive index returned its limit of ${CDX_LIMIT} captures, so later ones in the range are missing; call again with a narrower range`,
    );
  }
  if (!captures.length) notes.push(`no captures of this page between ${range.from} and ${range.to}`);

  const search = await findChanges(captures, page.url, deps.cache, archive, budget, sampleSize);
  const fpAt = (i: number) => (search.reads[i] as { fp: Fingerprint }).fp;

  if (search.stop) notes.push(stopNote(search.stop, maxFetches, budget.timeLimitMs, deps.subrequests.limit));
  if (search.samplesRead < search.samplesTotal) {
    notes.push(
      search.samplesRead === 0
        ? "no capture in range was checked"
        : `${search.samplesTotal - search.samplesRead} of ${search.samplesTotal} samples weren't read, so the brackets are wider than usual and may each hide more than one change`,
    );
  }
  const unreadable = search.reads.filter((r) => r === "unreadable").length;
  if (unreadable) {
    notes.push(
      `${plural(unreadable, "capture")} had no readable copy, such as a page drawn by scripts or one the archive couldn't serve, and never count as a change`,
    );
  }

  const brackets = [...search.brackets].sort((a, b) =>
    captures[a.j].timestamp.localeCompare(captures[b.j].timestamp),
  );
  const span = (b: Bracket) => `${dateOf(captures[b.i].timestamp)} to ${dateOf(captures[b.j].timestamp)}`;
  const wide = brackets.filter((b) => !b.resolved);
  if (wide.length) {
    const spans = wide.slice(0, MAX_WIDE_LISTED).map(span).join(", ");
    const more = wide.length > MAX_WIDE_LISTED ? ` and ${wide.length - MAX_WIDE_LISTED} more` : "";
    notes.push(`${plural(wide.length, "change")} still wide, with unchecked captures in between: ${spans}${more}`);
  }
  const descriptionOnly = brackets.filter((b) => shownKey(fpAt(b.i)) === shownKey(fpAt(b.j)));
  if (descriptionOnly.length) {
    const dates = descriptionOnly.map((b) => dateOf(captures[b.j].timestamp)).join(", ");
    const one = descriptionOnly.length === 1;
    notes.push(`the ${one ? "change" : "changes"} dated ${dates} ${one ? "is" : "are"} in the meta description only, which isn't returned`);
  }

  const status = search.stop || !earliest.ok || hitLimit ? "partial" : "ok";

  /** The note for changes left out: their dates, and the call that shows them. */
  const hiddenNote = (hidden: Bracket[]): string => {
    const dates = hidden.map((b) => dateOf(captures[b.j].timestamp));
    const more = dates.length > MAX_WIDE_LISTED ? ` and ${dates.length - MAX_WIDE_LISTED} more` : "";
    const head = `${plural(hidden.length, "more change")} not shown, dated ${dates.slice(0, MAX_WIDE_LISTED).join(", ")}${more}`;
    // From the month of the first hidden change's earlier capture, so the next call still brackets it.
    const from = monthOf(captures[hidden[0].i].timestamp);
    if (from > range.from) return `${head}; call again with from=${from} to see ${hidden.length === 1 ? "it" : "them"}`;
    if (maxChanges < MAX_CHANGES) return `${head}; call again with max_changes up to ${MAX_CHANGES} to see more`;
    return head;
  };

  const assemble = (shown: number, level: number): PageHistoryResult => {
    const extra: string[] = [];
    if (brackets.length > shown) extra.push(hiddenNote(brackets.slice(shown)));
    if (level > 0) extra.push("titles, headings and prices are shortened to fit the response size");
    return {
      status,
      notes: [...notes, ...extra],
      retrieved_at: utcDay(deps.now()),
      url: page.url,
      range: { from: range.from, to: range.to },
      first_capture: firstCapture,
      captures_in_range: captures.length,
      changes: brackets.slice(0, shown).map((b) => {
        const before = captures[b.i];
        const after = captures[b.j];
        return {
          before: snapshot(before, fpAt(b.i), page.url, LEVELS[level]),
          after: snapshot(after, fpAt(b.j), page.url, LEVELS[level]),
          days_between: Math.max(0, Math.floor((msOf(after.timestamp) - msOf(before.timestamp)) / DAY_MS)),
          resolved: b.resolved,
        };
      }),
      fetches_used: requests,
    };
  };

  // Shorten the copy first, then drop the latest changes, until the result fits.
  const fits = (r: PageHistoryResult) => JSON.stringify(r).length <= RESPONSE_CAP_CHARS;
  let shown = Math.min(maxChanges, brackets.length);
  let level = 0;
  let result = assemble(shown, level);
  while (!fits(result) && level < LEVELS.length - 1) result = assemble(shown, ++level);
  while (!fits(result) && shown > 0) result = assemble(--shown, level);
  return result;
}

// --------------------------------------------------------------- rendering

const TEXT_CHARS = 60;
const TEXT_FIELDS = 2;

/** One change: its dates, up to two changed fields (headline first), and both capture links. */
function changeLine(c: Change): string {
  const fields: [string, string, string][] = [
    ["headline", c.before.headline, c.after.headline],
    ["title", c.before.title, c.after.title],
    ["prices", c.before.prices.join("; "), c.after.prices.join("; ")],
    ["subheadings", c.before.subheadings.join(" | "), c.after.subheadings.join(" | ")],
  ];
  const changed = fields.filter(([, a, b]) => a !== b);
  const shown = changed
    .slice(0, TEXT_FIELDS)
    .map(([name, a, b]) => `${name} "${clip(a, TEXT_CHARS)}" → "${clip(b, TEXT_CHARS)}"`);
  const others = changed.slice(TEXT_FIELDS).map(([name]) => name);
  if (others.length) shown.push(`${others.join(" and ")} also changed`);
  const what = shown.length ? shown.join("; ") : "the meta description changed (not returned)";
  const days = `${plural(c.days_between, "day")}${c.resolved ? "" : ", still wide"}`;
  return `- between ${c.before.date} and ${c.after.date} (${days}): ${what}. ${c.before.link} → ${c.after.link}`;
}

/** The short text that goes with a page_history result: a header, the notes, then one line per change. */
export function renderPageHistory(r: PageHistoryResult): string {
  if (r.status === "error") {
    const e = r.error;
    return e
      ? `page_history failed (${e.reason}): ${e.detail}. ${e.fallback}`
      : "page_history failed. fall back to browsing for this check.";
  }
  const changes = r.changes ?? [];
  const first = r.first_capture;
  // Notes come right after the header, so the render cap can only cut change lines.
  const lines = [
    `Page history of ${r.url} from ${r.range?.from} to ${r.range?.to} (${r.status})`,
    ...r.notes.map((n) => `note: ${n}`),
    first ? `first captured ${first.date}: ${first.link}` : "first capture: unknown",
    `${plural(r.captures_in_range ?? 0, "capture")} in range, ${plural(changes.length, "change")} shown, ${plural(r.fetches_used ?? 0, "archive request")}`,
    ...changes.map(changeLine),
  ];
  return lines.join("\n");
}
