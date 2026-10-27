import { JOBS_DEADLINE_MS, JOBS_MAX_FETCHES, MAX_ROLES, MAX_ROLE_IDS, RESPONSE_CAP_CHARS } from "../config";
import { errorResult, utcDay } from "../contract/envelope";
import type { ErrorReason } from "../contract/envelope";
import type { Ats, JobOpeningsInput, JobOpeningsResult } from "../contract/tools";
import { Budget } from "../shared/budget";
import { REFUSED_STATUS, type Fetcher } from "../shared/http";
import { cleanCompanyName, normalizeDomain } from "../shared/inputs";
import { limitReached } from "../shared/subrequests";
import { fetchBoard, fetchRoleDetail, slugCandidates, type RawRole } from "../sources/boards";
import { euBoardUrl, findBoardLink } from "../sources/careers";
import type { ToolDeps } from ".";

type Role = NonNullable<JobOpeningsResult["roles"]>[number];
type Counts = NonNullable<JobOpeningsResult["counts"]>;

const ATS_ORDER: readonly Ats[] = ["greenhouse", "ashby", "lever"];
const MAX_NAME_CHARS = 100;
const MAX_TITLE_CHARS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_DETAIL_CHARS = 200;
/** The longest role id echoed back in a note. */
const MAX_ECHO_CHARS = 100;

/** How much of the count tables, then of each description, then of the role list is kept to fit the cap. */
const COUNT_ROWS = [25, 10, 5];
const DESCRIPTION_CHARS = [Number.POSITIVE_INFINITY, 1500, 800, 300];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const label = (s: string | null, max: number) => (s === null ? null : clip(s, max));

function countBy(roles: RawRole[], field: "department" | "location"): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of roles) {
    const name = clip(r[field] ?? "Unspecified", MAX_LABEL_CHARS);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** A board whose roles are all older than this may be one the company left behind. */
const STALE_AFTER_MS = 365 * 86_400_000;

/** The newest role date on a board when every dated role is more than a year old; otherwise null. */
function staleSince(roles: RawRole[], now: number): string | null {
  const dates = roles.map((r) => r.date).filter((d): d is string => d !== null);
  if (!dates.length) return null;
  const newest = dates.reduce((a, b) => (b > a ? b : a));
  return newest < utcDay(now - STALE_AFTER_MS) ? newest : null;
}

/** Newest first; roles with no date last, in the board's order. */
const newestFirst = (roles: RawRole[]): RawRole[] =>
  roles
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.date ?? "").localeCompare(a.r.date ?? "") || a.i - b.i)
    .map((x) => x.r);

export async function jobOpenings(
  input: JobOpeningsInput,
  deps: ToolDeps,
  opts: { maxFetches?: number; deadlineMs?: number; hardDeadlineMs?: number } = {},
): Promise<JobOpeningsResult> {
  const maxFetches = opts.maxFetches ?? JOBS_MAX_FETCHES;
  const deadlineMs = opts.deadlineMs ?? JOBS_DEADLINE_MS;

  const site = normalizeDomain(input.domain);
  if (!site.ok) return errorResult("bad_input", site.detail, [], deps.now());
  const name = input.company_name ? cleanCompanyName(input.company_name).slice(0, MAX_NAME_CHARS) : undefined;
  const wanted = [...new Set((input.role_ids ?? []).map((id) => id.trim()).filter(Boolean))];
  const roleIds = wanted.slice(0, MAX_ROLE_IDS);

  // The deadline counts from here. Every request goes through the gate, with room for itself and a cache
  // write; at the hard deadline, a request still running is cut.
  const budget = new Budget(maxFetches, deadlineMs, deps.now, {
    subrequests: deps.subrequests,
    reserve: 2,
    hardMs: opts.hardDeadlineMs,
  });
  /** Every address checked, in order: each request the gate let through, and each board answered from the cache. */
  const tried: string[] = [];
  const refusedUrls = new Set<string>();
  const gate: Fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (budget.take()) {
      tried.push(String(url));
      const res = await deps.fetch(url, { ...init, signal: budget.signal(init?.signal) });
      // The subrequest counter below the gate declined it.
      if (res.status === REFUSED_STATUS) refusedUrls.add(String(url));
      return res;
    }
    refusedUrls.add(String(url));
    // The caller sees a failed request; the gate's own record says why.
    return new Response(null, { status: REFUSED_STATUS });
  }) as Fetcher;
  const stopNote = (): string => {
    const rest = "so some boards and pages were not checked; call again with the same input to continue, since boards already read are cached";
    switch (budget.stopKind ?? "time") {
      case "subrequests":
        return `${limitReached(deps.subrequests.limit)}, ${rest}`;
      case "fetches":
        return `fetch budget of ${maxFetches} requests used up, ${rest}`;
      case "time":
        return `time limit of ${Math.round(budget.timeLimitMs / 1000)} s reached, ${rest}`;
    }
  };

  const notes: string[] = [];
  if (wanted.length > MAX_ROLE_IDS) notes.push(`only the first ${MAX_ROLE_IDS} role_ids were used`);
  let stopNoted = false;
  /** The note for a budget or time stop, added once however many requests it refuses. */
  const noteStop = () => {
    if (!stopNoted) notes.push(stopNote());
    stopNoted = true;
  };
  const failures: string[] = [];
  const errors: { reason: ErrorReason }[] = [];
  /** Set when any source answered 429, so the result says to wait. */
  let rateLimited = false;
  const WAIT = "a source rate-limited the request, so wait a few minutes before calling again";
  /** The note for a careers link to an EU-hosted board, which isn't read. */
  let euNote: string | null = null;
  let absent = 0;
  let stopped = false;
  const attempted = new Set<string>();
  const failureText = (reason: string, detail: string) => `${reason}: ${clip(detail, MAX_DETAIL_CHARS)}`;

  type Found = Extract<Awaited<ReturnType<typeof fetchBoard>>, { kind: "found" }>;
  let board: Found | null = null;
  let partial = false;
  /** What each board lookup found, by `ats:slug`. */
  const outcomes = new Map<string, "found" | "absent" | "error">();

  /** One board lookup; false when the budget or the clock ran out first. */
  const tryBoard = async (ats: Ats, slug: string): Promise<boolean> => {
    if (budget.exhausted) return false;
    attempted.add(`${ats}:${slug}`);
    const refusals = refusedUrls.size;
    const r = await fetchBoard(gate, deps.cache, ats, slug);
    const cut = refusedUrls.size > refusals || budget.cut;
    if (r.kind === "error" && cut) return false;
    const url = r.kind === "found" ? r.apiUrl : r.url;
    if (!tried.includes(url)) tried.push(url); // a board answered from the cache
    outcomes.set(`${ats}:${slug}`, r.kind === "found" ? "found" : r.kind === "absent" ? "absent" : "error");
    if (r.kind === "found") {
      board = r;
      if (r.departmentsError) {
        partial = true;
        if (r.departmentsError.reason === "source_rate_limited") rateLimited = true;
        if (cut) noteStop();
        else notes.push(`the departments lookup failed (${failureText(r.departmentsError.reason, r.departmentsError.detail)}), so departments are missing`);
      }
    }
    else if (r.kind === "absent") absent++;
    else {
      failures.push(`${ats} board "${slug}" could not be checked (${failureText(r.reason, r.detail)})`);
      errors.push({ reason: r.reason });
      if (r.reason === "source_rate_limited") rateLimited = true;
    }
    return true;
  };

  search: for (const slug of slugCandidates(site.domain, name)) {
    for (const ats of ATS_ORDER) {
      if (!(await tryBoard(ats, slug))) {
        stopped = true;
        break search;
      }
      if (board) break search;
    }
  }

  // A board found under a guessed name with no roles, or none in the last year, may be one the company left
  // behind, so the careers pages are read for the board they name now.
  const guessed = board as Found | null;
  const staleNewest = guessed ? staleSince(guessed.roles, deps.now()) : null;
  const leftBehind = guessed !== null && (staleNewest !== null || guessed.roles.length === 0);
  const careersFailuresBefore = failures.length;
  /** The board the careers pages name, when it isn't on an EU host. */
  let named: { ats: Ats; slug: string } | null = null;
  /** Set when the careers pages link to the guessed board itself, so the company does use it. */
  let linksGuessed = false;
  if ((!guessed || leftBehind) && !stopped) {
    if (budget.exhausted) stopped = true;
    else {
      const refusals = refusedUrls.size;
      const link = await findBoardLink(gate, site.domain);
      const isRefusal = (f: { status?: number }) => (f.status === REFUSED_STATUS && refusedUrls.size > refusals) || budget.cut;
      const careersFailures = link.failures.filter((f) => !isRefusal(f));
      for (const f of careersFailures) {
        failures.push(`careers page ${f.url} could not be checked (${failureText(f.reason, f.detail)})`);
        errors.push({ reason: f.reason });
        if (f.reason === "source_rate_limited") rateLimited = true;
      }
      absent += link.tried.length - link.failures.length;
      if (refusedUrls.size > refusals || budget.cut) stopped = true;
      if (link.found?.region === "eu") {
        // The board is on an EU host, whose API this tool doesn't read: it exists, but wasn't checked.
        const label = link.found.ats === "lever" ? "Lever" : "Greenhouse";
        euNote = `the careers page links to a ${label} board hosted in the EU region, ${euBoardUrl(link.found)}, which wasn't checked`;
      } else if (link.found) {
        named = link.found;
        // Board names are matched without regard to case, as the boards' own addresses are.
        if (guessed && link.found.ats === guessed.ats && link.found.slug.toLowerCase() === guessed.slug.toLowerCase()) linksGuessed = true;
        else if (!attempted.has(`${link.found.ats}:${link.found.slug}`)) {
          if (!(await tryBoard(link.found.ats, link.found.slug))) stopped = true;
        }
      }
    }
  }

  const found = board as Found | null;
  if (!found) {
    if (stopped) noteStop();
    if (euNote) notes.push(euNote);
    notes.push(...failures);
    if (!stopped && failures.length && absent === 0 && !euNote) {
      const first = errors[0].reason;
      return errorResult(first, first === "source_rate_limited" ? `${failures[0]}; wait a few minutes before calling again` : failures[0], tried, deps.now());
    }
    if (rateLimited) notes.push(WAIT);
    const complete = !stopped && failures.length === 0 && !euNote;
    return {
      status: complete ? "ok" : "partial",
      notes,
      retrieved_at: utcDay(deps.now()),
      board: null,
      no_public_board_found: complete,
      tried,
    };
  }

  if (guessed && leftBehind) {
    if (found !== guessed) {
      const why = staleNewest ? `has no role posted or updated since ${staleNewest}` : "lists no roles";
      notes.push(`the ${guessed.ats} board "${guessed.slug}", found by guessing the name, ${why}, so the board the company's careers pages name was used instead`);
    } else {
      const head = staleNewest
        ? `every role on this board was posted or updated more than a year ago (the newest on ${staleNewest})`
        : "this board, found by guessing the name, lists no roles";
      const maybe = ", so it may be one the company no longer uses";
      const outcome = named ? outcomes.get(`${named.ats}:${named.slug}`) : undefined;
      let tail = maybe;
      if (linksGuessed) tail = ", though the company's careers pages link to it";
      else if (named && outcome === "absent") tail = `${maybe}; the careers pages link to the ${named.ats} board "${named.slug}", which wasn't found`;
      else if (named && outcome === "error") {
        tail = `${maybe}; the careers pages link to the ${named.ats} board "${named.slug}", which could not be checked`;
        partial = true;
      } else if (!named && !stopped && !euNote && failures.length === careersFailuresBefore) tail = `${maybe}; the careers pages name no other board`;
      notes.push(head + tail);
    }
    // The check for a newer board didn't finish, so the board returned may not be the company's current one.
    if (failures.length > careersFailuresBefore) partial = true;
    if (stopped) {
      noteStop();
      partial = true;
    }
    if (euNote) {
      notes.push(euNote);
      partial = true;
    }
  }
  if (failures.length) notes.push(...failures.map((f) => `${f}; the board found above was used`));

  // The roles asked for by id, with descriptions; otherwise the newest.
  const all = newestFirst(found.roles);
  const toRole = (r: RawRole, extra: { description?: string; pay?: string | null } = {}): Role => ({
    id: r.id,
    title: clip(r.title, MAX_TITLE_CHARS),
    department: label(r.department, MAX_LABEL_CHARS),
    location: label(r.location, MAX_LABEL_CHARS),
    date: r.date,
    date_kind: r.dateKind,
    pay: extra.pay === undefined ? r.pay : extra.pay,
    link: r.link,
    ...(extra.description === undefined ? {} : { description: extra.description }),
  });

  let detailed: Role[] | null = null;
  if (roleIds.length) {
    const byId = new Map(all.map((r) => [r.id, r]));
    const missing = roleIds.filter((id) => !byId.has(id));
    if (missing.length) notes.push(`role ${missing.map((id) => clip(id, MAX_ECHO_CHARS)).join(", ")} ${missing.length === 1 ? "is" : "are"} not on the board`);
    detailed = [];
    for (const r of all.filter((x) => roleIds.includes(x.id))) {
      if (budget.exhausted) {
        noteStop();
        notes.push(`role ${clip(r.id, MAX_ECHO_CHARS)}: description not fetched`);
        partial = true;
        detailed.push(toRole(r));
        continue;
      }
      const refusals = refusedUrls.size;
      const d = await fetchRoleDetail(gate, found.ats, found.slug, r.id, r);
      if (d.ok) detailed.push(toRole(r, { description: d.description, pay: d.pay ?? r.pay }));
      else {
        if (refusedUrls.size > refusals || budget.cut) noteStop();
        else {
          notes.push(`role ${clip(r.id, MAX_ECHO_CHARS)}: the description could not be fetched (${failureText(d.reason, d.detail)})`);
          if (d.reason === "source_rate_limited") rateLimited = true;
        }
        partial = true;
        detailed.push(toRole(r));
      }
    }
  }

  if (rateLimited) notes.push(WAIT);
  const byDepartment = countBy(all, "department");
  const byLocation = countBy(all, "location");
  const status = partial ? "partial" : "ok";

  const assemble = (rows: number, descChars: number, shown: number): JobOpeningsResult => {
    const extra: string[] = [];
    let listNote: string[] = [];
    const counts: Counts = { total: all.length, by_department: byDepartment.slice(0, rows), by_location: byLocation.slice(0, rows) };
    if (byDepartment.length > rows) extra.push(`showing the top ${rows} of ${plural(byDepartment.length, "department")}`);
    if (byLocation.length > rows) extra.push(`showing the top ${rows} of ${plural(byLocation.length, "location")}`);
    let roles: Role[];
    if (detailed) {
      roles = detailed.map((r) => (r.description === undefined ? r : { ...r, description: r.description.slice(0, descChars) }));
      if (descChars < Number.POSITIVE_INFINITY) extra.push("descriptions are shortened to fit the response size");
    } else {
      roles = all.slice(0, shown).map((r) => toRole(r));
      if (all.length > shown) {
        listNote = [`showing ${shown} of ${all.length} roles, newest first; the counts cover all ${all.length}; pass role_ids for full descriptions`];
      }
    }
    return {
      status,
      notes: [...listNote, ...notes, ...extra],
      retrieved_at: utcDay(deps.now()),
      board: { ats: found.ats, slug: found.slug, url: found.url },
      no_public_board_found: false,
      tried,
      counts,
      roles,
    };
  };

  // Fewer count rows first, then shorter descriptions, then fewer roles, until the result fits.
  const fits = (r: JobOpeningsResult) => JSON.stringify(r).length <= RESPONSE_CAP_CHARS;
  const startShown = Math.min(MAX_ROLES, all.length);
  let result = assemble(COUNT_ROWS[0], DESCRIPTION_CHARS[0], startShown);
  for (const rows of COUNT_ROWS.slice(1)) if (!fits(result)) result = assemble(rows, DESCRIPTION_CHARS[0], startShown);
  const rows = COUNT_ROWS[COUNT_ROWS.length - 1];
  for (const d of DESCRIPTION_CHARS.slice(1)) if (!fits(result) && detailed) result = assemble(rows, d, startShown);
  for (let shown = startShown - 1; !fits(result) && shown >= 0 && !detailed; shown--) {
    result = assemble(rows, DESCRIPTION_CHARS[0], shown);
  }
  return result;
}
