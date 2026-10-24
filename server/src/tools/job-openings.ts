import { JOBS_DEADLINE_MS, JOBS_MAX_FETCHES, MAX_ROLES, MAX_ROLE_IDS, RESPONSE_CAP_CHARS } from "../config";
import { errorResult, utcDay } from "../contract/envelope";
import type { ErrorReason } from "../contract/envelope";
import type { Ats, JobOpeningsInput, JobOpeningsResult } from "../contract/tools";
import { Budget } from "../shared/budget";
import type { Fetcher } from "../shared/http";
import { cleanCompanyName, normalizeDomain } from "../shared/inputs";
import { fetchBoard, fetchRoleDetail, slugCandidates, type RawRole } from "../sources/boards";
import { findBoardLink } from "../sources/careers";
import type { ToolDeps } from ".";

type Role = NonNullable<JobOpeningsResult["roles"]>[number];
type Counts = NonNullable<JobOpeningsResult["counts"]>;

const ATS_ORDER: readonly Ats[] = ["greenhouse", "ashby", "lever"];
const MAX_NAME_CHARS = 100;
const MAX_TITLE_CHARS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_DETAIL_CHARS = 200;
/** What the budget's gate answers with once it is out of fetches or time; never a real status. */
const REFUSED_STATUS = 599;

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

/** Newest first; roles with no date last, in the board's order. */
const newestFirst = (roles: RawRole[]): RawRole[] =>
  roles
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.date ?? "").localeCompare(a.r.date ?? "") || a.i - b.i)
    .map((x) => x.r);

export async function jobOpenings(
  input: JobOpeningsInput,
  deps: ToolDeps,
  opts: { maxFetches?: number; deadlineMs?: number } = {},
): Promise<JobOpeningsResult> {
  const maxFetches = opts.maxFetches ?? JOBS_MAX_FETCHES;
  const deadlineMs = opts.deadlineMs ?? JOBS_DEADLINE_MS;

  const site = normalizeDomain(input.domain);
  if (!site.ok) return errorResult("bad_input", site.detail, [], deps.now());
  const name = input.company_name ? cleanCompanyName(input.company_name).slice(0, MAX_NAME_CHARS) : undefined;
  const wanted = [...new Set((input.role_ids ?? []).map((id) => id.trim()).filter(Boolean))];
  const roleIds = wanted.slice(0, MAX_ROLE_IDS);

  // The deadline counts from here. Every request goes through the gate.
  const budget = new Budget(maxFetches, deadlineMs, deps.now);
  const requested = new Set<string>();
  let refused = false;
  const gate: Fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (budget.take()) {
      requested.add(String(url));
      return deps.fetch(url, init);
    }
    refused = true;
    return new Response(null, { status: REFUSED_STATUS });
  }) as Fetcher;
  const stopNote = (): string =>
    budget.used >= maxFetches
      ? `fetch budget of ${maxFetches} requests used up, so some boards and pages were not checked; call again with the same input to continue, since boards already read are cached`
      : `time limit of ${Math.round(deadlineMs / 1000)} s reached, so some boards and pages were not checked; call again with the same input to continue, since boards already read are cached`;

  const notes: string[] = [];
  if (wanted.length > MAX_ROLE_IDS) notes.push(`only the first ${MAX_ROLE_IDS} role_ids were used`);
  const tried: string[] = [];
  const failures: string[] = [];
  const errors: { reason: ErrorReason }[] = [];
  let absent = 0;
  let stopped = false;
  const attempted = new Set<string>();
  const failureText = (reason: string, detail: string) => `${reason}: ${clip(detail, MAX_DETAIL_CHARS)}`;

  type Found = Extract<Awaited<ReturnType<typeof fetchBoard>>, { kind: "found" }>;
  let board: Found | null = null;

  /** One board lookup; false when the budget or the clock ran out first. */
  const tryBoard = async (ats: Ats, slug: string): Promise<boolean> => {
    if (budget.exhausted) return false;
    attempted.add(`${ats}:${slug}`);
    const r = await fetchBoard(gate, deps.cache, ats, slug);
    if (r.kind === "error" && refused && r.detail.includes(String(REFUSED_STATUS))) return false;
    tried.push(r.kind === "found" ? r.apiUrl : r.url);
    if (r.kind === "found") board = r;
    else if (r.kind === "absent") absent++;
    else {
      failures.push(`${ats} board "${slug}" could not be checked (${failureText(r.reason, r.detail)})`);
      errors.push({ reason: r.reason });
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

  if (!board && !stopped) {
    if (budget.exhausted) stopped = true;
    else {
      const link = await findBoardLink(gate, site.domain);
      const asked = link.tried.filter((u) => requested.has(u));
      const careersFailures = link.failures.filter((f) => !f.endsWith(`HTTP ${REFUSED_STATUS}`));
      tried.push(...asked);
      for (const f of careersFailures) {
        failures.push(`careers page could not be checked (${f})`);
        errors.push({ reason: "source_unavailable" });
      }
      absent += asked.length - careersFailures.length;
      if (refused) stopped = true;
      if (link.found && !attempted.has(`${link.found.ats}:${link.found.slug}`)) {
        if (!(await tryBoard(link.found.ats, link.found.slug))) stopped = true;
      }
    }
  }

  const found = board as Found | null;
  if (!found) {
    if (stopped) notes.push(stopNote());
    notes.push(...failures);
    if (!stopped && failures.length && absent === 0) {
      const first = errors[0].reason;
      return errorResult(first, failures[0], tried, deps.now());
    }
    const complete = !stopped && failures.length === 0;
    return {
      status: complete ? "ok" : "partial",
      notes,
      retrieved_at: utcDay(deps.now()),
      board: null,
      no_public_board_found: complete,
      tried,
    };
  }

  notes.push(...(found.notes ?? []));
  if (failures.length) notes.push(...failures.map((f) => `${f}; the board found above was used`));
  let partial = false;

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
    if (missing.length) notes.push(`role ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on the board`);
    detailed = [];
    for (const r of all.filter((x) => roleIds.includes(x.id))) {
      if (budget.exhausted) {
        notes.push(`${stopNote()}; role ${r.id} has no description`);
        partial = true;
        detailed.push(toRole(r));
        continue;
      }
      const d = await fetchRoleDetail(gate, found.ats, found.slug, r.id, r);
      if (d.ok) detailed.push(toRole(r, { description: d.description, pay: d.pay ?? r.pay }));
      else {
        notes.push(`role ${r.id}: the description could not be fetched (${failureText(d.reason, d.detail)})`);
        partial = true;
        detailed.push(toRole(r));
      }
    }
  }

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

// --------------------------------------------------------------- rendering

const SNIPPET_CHARS = 300;
const TOP_NAMES = 5;

function roleLine(r: Role): string {
  const bits = [r.department, r.location, r.date ? `${r.date_kind} ${r.date}` : null, r.pay].filter(Boolean);
  const head = `- ${r.title}${bits.length ? ` (${bits.join(", ")})` : ""} ${r.link}`;
  return r.description ? `${head}\n  ${clip(r.description, SNIPPET_CHARS)}` : head;
}

const top = (rows: { name: string; count: number }[]) =>
  rows.slice(0, TOP_NAMES).map((x) => `${x.name} (${x.count})`).join(", ");

/** The short text that goes with a job_openings result: a header, the notes, then counts and one line per role. */
export function renderJobOpenings(r: JobOpeningsResult): string {
  if (r.status === "error") {
    const e = r.error;
    return e
      ? `job_openings failed (${e.reason}): ${e.detail}. ${e.fallback}`
      : "job_openings failed. fall back to browsing for this check.";
  }
  const b = r.board;
  const header = b
    ? `Job openings: ${b.ats} board ${b.slug}, ${b.url} (${r.status})`
    : r.no_public_board_found
      ? `Job openings: no public board found on Greenhouse, Ashby or Lever (${r.status})`
      : `Job openings: no board found, but a board or page could not be checked, so absence is not shown (${r.status})`;
  const lines = [header, ...r.notes.map((n) => `note: ${n}`)];
  if (!b) lines.push(`checked: ${(r.tried ?? []).join(", ")}`);
  const c = r.counts;
  if (c) {
    lines.push(`${plural(c.total, "open role")}. By department: ${top(c.by_department) || "none"}. By location: ${top(c.by_location) || "none"}.`);
  }
  lines.push(...(r.roles ?? []).map(roleLine));
  return lines.join("\n");
}
