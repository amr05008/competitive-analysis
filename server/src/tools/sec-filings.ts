import { EDGAR_GAP_MS, MAX_ENTITIES, MAX_FILINGS, MAX_FORM_D, RESPONSE_CAP_CHARS, SEC_DEADLINE_MS, SEC_MAX_FETCHES } from "../config";
import { errorResult, utcDay } from "../contract/envelope";
import type { SecInput, SecResult } from "../contract/tools";
import { Budget } from "../shared/budget";
import type { FailedOutcome, Fetcher } from "../shared/http";
import { cleanCompanyName, normalizeDomain } from "../shared/inputs";
import {
  filingFolder,
  getFormD,
  getSubmissions,
  isListableCompany,
  normalizeEntityName,
  searchEntities,
  type Submissions,
} from "../sources/edgar";
import type { ToolDeps } from ".";

type Entity = NonNullable<SecResult["entities"]>[number];
type FormDEntry = Entity["form_d"][number];

/** How many search hits have their submissions read. */
const MAX_CANDIDATES = 8;
const MAX_DETAIL_CHARS = 200;
/** What the gate answers with once the budget or clock has run out: a status no EDGAR page sends. */
const REFUSED_STATUS = 599;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function secFilings(
  input: SecInput,
  deps: ToolDeps,
  opts: { sleep?: (ms: number) => Promise<void>; maxFetches?: number; deadlineMs?: number } = {},
): Promise<SecResult> {
  const maxFetches = opts.maxFetches ?? SEC_MAX_FETCHES;
  const deadlineMs = opts.deadlineMs ?? SEC_DEADLINE_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let label: string | null = null;
  if (input.domain !== undefined && input.domain.trim() !== "") {
    const d = normalizeDomain(input.domain);
    if (!d.ok) return errorResult("bad_input", d.detail, [], deps.now());
    label = d.domain.split(".")[0];
  }
  const name = cleanCompanyName(input.company_name);
  if (name.length < 2) return errorResult("bad_input", "the company name needs at least 2 characters", [], deps.now());
  let state: string | null = null;
  if (input.state !== undefined && input.state.trim() !== "") {
    state = input.state.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return errorResult("bad_input", "state must be two letters", [], deps.now());
  }

  const namesTried = [name];
  if (label && label.length >= 2 && label.replace(/[^a-z0-9]/g, "") !== normalizeEntityName(name).replace(/ /g, "")) namesTried.push(label);
  const wanted = new Set(namesTried.map(normalizeEntityName));

  const budget = new Budget(maxFetches, deadlineMs, deps.now);
  const tried: string[] = [];
  let lastStart: number | null = null;
  let rateLimited = false;
  // Every request passes through here: it counts against the budget and starts at least EDGAR_GAP_MS after the last.
  const gate: Fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (rateLimited || !budget.take()) {
      return new Response(null, { status: REFUSED_STATUS });
    }
    if (lastStart !== null) {
      const wait = lastStart + EDGAR_GAP_MS - deps.now();
      if (wait > 0) await sleep(wait);
    }
    lastStart = deps.now();
    tried.push(String(url));
    const res = await deps.fetch(url, init);
    if (res.status === 429) rateLimited = true; // after any 429 no further EDGAR request is made in this call
    return res;
  }) as Fetcher;
  const halted = () => rateLimited || budget.exhausted;
  const stopReason = (): string =>
    rateLimited
      ? "EDGAR rate-limited the request"
      : budget.used >= maxFetches
      ? `fetch budget of ${maxFetches} requests used up`
      : `time limit of ${Math.round(deadlineMs / 1000)} s reached`;
  const advice = () =>
    rateLimited
      ? "wait a few minutes before calling again"
      : "call again with the same input to continue, since answers already read are cached";
  const failText = (f: FailedOutcome) => `${f.reason}: ${clip(f.detail, MAX_DETAIL_CHARS)}`;

  const notes: string[] = [];
  let partial = false;

  // 1. Search each name.
  const lists: { cik: string; exact: boolean }[][] = [];
  let searchesOk = 0;
  let firstSearchFailure: FailedOutcome | null = null;
  for (const n of namesTried) {
    if (halted()) {
      partial = true;
      notes.push(`${stopReason()}, so the name "${n}" was not searched; ${advice()}`);
      continue;
    }
    const r = await searchEntities(gate, deps.cache, n);
    if (!r.ok) {
      if (r.status !== REFUSED_STATUS) {
        firstSearchFailure ??= r;
        partial = true;
        notes.push(`the search for "${n}" failed (${failText(r)})`);
      }
      continue;
    }
    searchesOk++;
    lists.push(r.hits);
  }
  if (searchesOk === 0) {
    if (firstSearchFailure) return errorResult(firstSearchFailure.reason, firstSearchFailure.detail, tried, deps.now());
    return errorResult("source_unavailable", `${stopReason()} before any search`, tried, deps.now());
  }

  // 2. Read each candidate's submissions; individuals are dropped here.
  // Exact name matches first, then the searches' other hits taken in turn, then cut to the candidate limit.
  const ordered: string[] = [];
  const add = (cik: string) => void (ordered.includes(cik) || ordered.push(cik));
  for (const l of lists) for (const h of l) if (h.exact) add(h.cik);
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) add(l[i].cik);
  const candidates = ordered.slice(0, MAX_CANDIDATES).map((cik) => ({ cik }));
  const beyondLimit = ordered.length - candidates.length;
  if (beyondLimit > 0) {
    notes.push(`${plural(beyondLimit, "more match was", "more matches were")} not checked, because only the first ${MAX_CANDIDATES} are`);
  }
  const found: { sub: Submissions; exact: boolean; stateMatch: boolean; order: number }[] = [];
  const failures: FailedOutcome[] = [];
  let unchecked = 0;
  let stopped = false;
  for (let i = 0; i < candidates.length; i++) {
    if (halted()) {
      stopped = true;
      unchecked = candidates.length - i;
      break;
    }
    const r = await getSubmissions(gate, deps.cache, candidates[i].cik);
    if (!r.ok) {
      if (r.status === REFUSED_STATUS) {
        stopped = true;
        unchecked = candidates.length - i;
        break;
      }
      failures.push(r);
      if (r.reason === "source_rate_limited") {
        stopped = true;
        unchecked = candidates.length - i - 1;
        break;
      }
      continue;
    }
    if (!isListableCompany(r.sub)) continue;
    found.push({
      sub: r.sub,
      exact: wanted.has(normalizeEntityName(r.sub.name)),
      stateMatch: state !== null && (r.sub.businessState === state || r.sub.stateOfIncorporation === state),
      order: i,
    });
  }
  if (failures.length) {
    partial = true;
    notes.push(
      `${plural(failures.length, "match", "matches")} could not be read (${failText(failures[0])}), so ${failures.length === 1 ? "it is" : "they are"} left out`,
    );
  }
  if (stopped) {
    partial = true;
    const why = stopReason();
    if (unchecked > 0) notes.push(`${why}, so ${plural(unchecked, "match was", "matches were")} not checked; ${advice()}`);
  }

  found.sort((a, b) => Number(b.stateMatch) - Number(a.stateMatch) || Number(b.exact) - Number(a.exact) || a.order - b.order);
  const kept = found.slice(0, MAX_ENTITIES);
  if (kept.length > 0 && !kept.some((k) => k.exact)) notes.push("no exact name match; these are close matches");

  // 3. Form D notices, newest first, within what is left of the budget.
  let skipped = 0;
  let formDFailure: FailedOutcome | null = null;
  let formDFailed = 0;
  const entities: Entity[] = [];
  for (const k of kept) {
    const { sub } = k;
    const folder = (acc: string) => `${filingFolder(sub.cik, acc)}/${acc}-index.htm`;
    const formDs: FormDEntry[] = [];
    for (const f of sub.filings.filter((x) => x.form === "D" || x.form === "D/A").slice(0, MAX_FORM_D)) {
      if (halted()) {
        skipped++;
        continue;
      }
      const r = await getFormD(gate, deps.cache, sub.cik, f.accession);
      if (!r.ok) {
        if (r.status === REFUSED_STATUS) skipped++;
        else {
          formDFailed++;
          formDFailure ??= r;
        }
        continue;
      }
      formDs.push({
        date_filed: f.date,
        link: folder(f.accession),
        amendment: r.d.isAmendment || f.form === "D/A",
        total_offering_amount: r.d.totalOfferingAmount,
        total_amount_sold: r.d.totalAmountSold,
        date_of_first_sale: r.d.dateOfFirstSale,
        industry_group: r.d.industryGroup,
        year_of_incorporation: r.d.yearOfInc,
      });
      if (r.d.firstSaleYetToOccur) notes.push(`the Form D filed ${f.date} for ${sub.name} says the first sale has yet to occur`);
    }
    entities.push({
      name: sub.name,
      cik: sub.cik,
      state: sub.businessState ?? sub.stateOfIncorporation,
      former_names: sub.formerNames,
      exact_match: k.exact,
      edgar_link: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${sub.cik}`,
      filings: sub.filings.slice(0, MAX_FILINGS).map((f) => ({ form: f.form, date: f.date, link: folder(f.accession) })),
      form_d: formDs,
    });
  }
  if (skipped > 0) {
    partial = true;
    notes.push(`${plural(skipped, "Form D notice was", "Form D notices were")} not read: ${stopReason()}; ${advice()}`);
  }
  if (formDFailed > 0) {
    partial = true;
    notes.push(`${plural(formDFailed, "Form D notice", "Form D notices")} could not be read (${failText(formDFailure as FailedOutcome)})`);
  }

  if (rateLimited && !notes.some((n) => n.includes("wait a few minutes"))) {
    partial = true;
    notes.push("EDGAR rate-limited the request, so no further requests were made; wait a few minutes before calling again");
  }

  const nothing = entities.length === 0 && !partial && beyondLimit === 0;
  const assemble = (filingCount: number, formDCount: number, entityCount: number): SecResult => {
    const shortened = filingCount < MAX_FILINGS || formDCount < MAX_FORM_D || entityCount < entities.length;
    return {
      status: partial ? "partial" : "ok",
      notes: shortened ? [...notes, "lists are shortened to fit the response size"] : notes,
      retrieved_at: utcDay(deps.now()),
      names_tried: namesTried,
      entities: entities
        .slice(0, entityCount)
        .map((e) => ({ ...e, filings: e.filings.slice(0, filingCount), form_d: e.form_d.slice(0, formDCount) })),
      statement: nothing ? `no filings found under these names: ${namesTried.join(", ")}` : null,
    };
  };
  const fits = (r: SecResult) => JSON.stringify(r).length <= RESPONSE_CAP_CHARS;
  let result = assemble(MAX_FILINGS, MAX_FORM_D, entities.length);
  for (let n = MAX_FILINGS - 1; !fits(result) && n >= 0; n--) result = assemble(n, MAX_FORM_D, entities.length);
  for (let n = MAX_FORM_D - 1; !fits(result) && n >= 0; n--) result = assemble(0, n, entities.length);
  for (let n = entities.length - 1; !fits(result) && n >= 0; n--) result = assemble(0, 0, n);
  return result;
}

// --------------------------------------------------------------- rendering

const money = (v: string | null): string => (v === null ? "n/a" : /^\d+$/.test(v) ? `$${Number(v).toLocaleString("en-US")}` : v);

/** The short text that goes with a sec_filings result: a header, the notes, then each company. */
export function renderSec(r: SecResult): string {
  if (r.status === "error") {
    const e = r.error;
    return e
      ? `sec_filings failed (${e.reason}): ${e.detail}. ${e.fallback}`
      : "sec_filings failed. fall back to browsing for this check.";
  }
  const lines = [`SEC filings for "${(r.names_tried ?? []).join('", "')}" (${r.status})`, ...r.notes.map((n) => `note: ${n}`)];
  if (r.statement) lines.push(r.statement);
  for (const e of r.entities ?? []) {
    lines.push(`${e.name} (CIK ${e.cik}${e.state ? `, ${e.state}` : ""}${e.exact_match ? "" : ", close match"}) ${e.edgar_link}`);
    if (e.former_names.length) lines.push(`  formerly ${e.former_names.join("; ")}`);
    for (const d of e.form_d) {
      const parts = [
        `offering ${money(d.total_offering_amount)}`,
        `sold ${money(d.total_amount_sold)}`,
        `first sale ${d.date_of_first_sale ?? "n/a"}`,
        ...(d.industry_group ? [d.industry_group] : []),
        ...(d.year_of_incorporation ? [`incorporated ${d.year_of_incorporation}`] : []),
      ];
      lines.push(`  Form D${d.amendment ? "/A" : ""} filed ${d.date_filed}: ${parts.join(", ")} ${d.link}`);
    }
    if (e.filings.length) lines.push(`  Recent filings: ${e.filings.slice(0, 8).map((f) => `${f.form} ${f.date}`).join("; ")}`);
  }
  return lines.join("\n");
}
