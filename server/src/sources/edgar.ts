import { TTL_EDGAR } from "../config";
import { cached } from "../shared/cache";
import { politeFetch, type FailedOutcome, type Fetcher } from "../shared/http";
import { cleanCompanyName } from "../shared/inputs";

/**
 * Forms a company files. An entity is listed only if it has filed at least one of these, matched exactly
 * (never by prefix): individuals file ownership, activist and broker forms, which are not in this set.
 */
export const COMPANY_FORMS = new Set([
  "D", "D/A", "S-1", "S-1/A", "F-1", "10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A", "20-F", "40-F", "6-K",
  "10-12B", "10-12G", "C", "C/A", "C-U", "C-AR", "1-A", "1-A/A", "1-K", "1-SA", "1-U",
  "N-CSR", "N-PORT-P", "DEF 14A", "424B4",
]);

/** The industry groups a Form D can name. Any other value is treated as absent. */
const INDUSTRY_GROUPS = [
  "Agriculture", "Banking and Financial Services", "Commercial Banking", "Insurance", "Investing", "Investment Banking",
  "Pooled Investment Fund", "Other Banking and Financial Services", "Business Services", "Energy", "Coal Mining",
  "Electric Utilities", "Energy Conservation", "Environmental Services", "Oil and Gas", "Other Energy", "Health Care",
  "Biotechnology", "Health Insurance", "Hospitals and Physicians", "Pharmaceuticals", "Other Health Care",
  "Manufacturing", "Real Estate", "Commercial", "Construction", "REITS and Finance", "Residential", "Other Real Estate",
  "Retailing", "Restaurants", "Technology", "Computers", "Telecommunications", "Other Technology", "Travel",
  "Airlines and Airports", "Lodging and Conventions", "Tourism and Travel Services", "Other Travel", "Other",
];
const industryKey = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
const INDUSTRY_BY_KEY = new Map(INDUSTRY_GROUPS.map((g) => [industryKey(g), g]));

/** The most recent filings kept per company, besides every Form D. */
const KEEP_FILINGS = 100;
const MAX_HITS = 10;
const MAX_NAME_CHARS = 200;

export type Filing = { form: string; date: string; accession: string };

/** A company's EDGAR record, cut to the fields the tool may show: no address, phone, EIN or website. */
export type Submissions = {
  cik: string;
  name: string;
  stateOfIncorporation: string | null;
  businessState: string | null;
  formerNames: string[];
  filings: Filing[];
};

/** The only Form D fields ever read. People and addresses are never parsed. */
export type FormDFields = {
  totalOfferingAmount: string | null;
  totalAmountSold: string | null;
  dateOfFirstSale: string | null;
  firstSaleYetToOccur: boolean;
  industryGroup: string | null;
  yearOfInc: string | null;
  isAmendment: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

const unreadable = (f: FailedOutcome["url"], what: string): FailedOutcome => ({
  ok: false,
  reason: "source_unavailable",
  url: f,
  detail: `unexpected ${what} format`,
});

/** Runs one cached fetch and parse; a parse failure is reported and nothing is cached. */
async function fetchParsed<T>(
  fetcher: Fetcher,
  cache: Cache,
  url: string,
  maxBytes: number,
  parse: (text: string) => T | null,
  what: string,
): Promise<({ ok: true; value: T }) | FailedOutcome> {
  let failure: FailedOutcome | null = null;
  const { value } = await cached<T>(cache, url, TTL_EDGAR, async () => {
    const r = await politeFetch(fetcher, url, { maxBytes });
    if (!r.ok) {
      failure = r;
      return null;
    }
    const parsed = parse(r.text);
    if (parsed === null) failure = unreadable(url, what);
    return parsed;
  });
  if (value !== null) return { ok: true, value };
  return failure ?? unreadable(url, what);
}

/**
 * EDGAR's company typeahead. Its hits are suggestions, so they include funds, SPVs and individuals. Only the
 * CIKs, their order and whether each name equals the name searched are cached or returned; names come from
 * submissions, so an individual's name never reaches the cache.
 */
export async function searchEntities(
  fetcher: Fetcher,
  cache: Cache,
  name: string,
): Promise<{ ok: true; hits: { cik: string; exact: boolean }[] } | FailedOutcome> {
  const url = `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(name)}`;
  const wanted = normalizeEntityName(name);
  const r = await fetchParsed(fetcher, cache, url, 500_000, (text) => {
    const hits = obj(obj(parseJson(text)?.hits))?.hits;
    if (!Array.isArray(hits)) return null;
    const out: { cik: string; exact: boolean }[] = [];
    for (const h of hits) {
      const id = str(obj(h)?._id);
      const entity = str(obj(obj(h)?._source)?.entity);
      if (id && /^\d+$/.test(id) && entity) out.push({ cik: id, exact: normalizeEntityName(entity) === wanted });
      if (out.length >= MAX_HITS) break;
    }
    return out;
  }, "search");
  return r.ok ? { ok: true, hits: r.value } : r;
}

const stateOf = (v: unknown): string | null => {
  const s = str(v)?.trim();
  return s ? s : null;
};

/** What is cached for an entity that is not a listable company: no name, no forms. */
type NotListable = { listable: false };

function parseSubmissions(text: string): Submissions | NotListable | null {
  const body = parseJson(text);
  if (!body) return null;
  const cik = str(body.cik);
  const name = str(body.name);
  const recent = obj(obj(body.filings)?.recent);
  if (!cik || name === null || !recent) return null;
  const forms = recent.form;
  const dates = recent.filingDate;
  const accs = recent.accessionNumber;
  if (!Array.isArray(forms) || !Array.isArray(dates) || !Array.isArray(accs)) return null;
  const filings: Filing[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = str(forms[i]);
    const date = str(dates[i]);
    const accession = str(accs[i]);
    if (!form || !date || !accession) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    if (i < KEEP_FILINGS || form === "D" || form === "D/A") filings.push({ form, date, accession });
  }
  const former = Array.isArray(body.formerNames)
    ? body.formerNames.map((f) => str(obj(f)?.name)).filter((n): n is string => !!n).map((n) => n.slice(0, MAX_NAME_CHARS))
    : [];
  const sub: Submissions = {
    cik: cik.replace(/^0+(?=\d)/, ""),
    name: name.slice(0, MAX_NAME_CHARS),
    stateOfIncorporation: stateOf(body.stateOfIncorporation),
    businessState: stateOf(obj(obj(body.addresses)?.business)?.stateOrCountry),
    formerNames: former,
    filings,
  };
  // Decided before anything is cached: an individual's record is stored as a bare sentinel.
  return isListableCompany(sub) ? sub : { listable: false };
}

/** One company's submissions record, reduced to the allow-listed fields; sub is null when the entity is not a listable company, and only a bare sentinel is cached for it. */
export async function getSubmissions(
  fetcher: Fetcher,
  cache: Cache,
  cik: string,
): Promise<{ ok: true; sub: Submissions | null } | FailedOutcome> {
  const url = `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`;
  const r = await fetchParsed(fetcher, cache, url, 3_000_000, parseSubmissions, "submissions");
  return r.ok ? { ok: true, sub: "listable" in r.value ? null : r.value } : r;
}

// ------------------------------------------------------------------- Form D

/** Elements that name people. They are cut out whole, to the end of the document when unclosed, before anything is read. */
const PEOPLE_ELEMENTS = ["relatedPersonsList", "signatureBlock", "salesCompensationList"];

function stripPeople(xml: string): string {
  let out = xml;
  for (const tag of PEOPLE_ELEMENTS) {
    const open = new RegExp(`<(?:\\w+:)?${tag}(?=[\\s/>])`);
    const selfClosed = new RegExp(`^<(?:\\w+:)?${tag}[^>]*/>`);
    const close = new RegExp(`</(?:\\w+:)?${tag}\\s*>`);
    for (;;) {
      const at = out.search(open);
      if (at < 0) break;
      const self = selfClosed.exec(out.slice(at));
      if (self) {
        out = out.slice(0, at) + out.slice(at + self[0].length);
        continue;
      }
      const rest = out.slice(at);
      const end = close.exec(rest);
      out = end ? out.slice(0, at) + rest.slice(end.index + end[0].length) : out.slice(0, at);
    }
  }
  return out;
}

const block = (xml: string, tag: string): string | null => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
const text = (xml: string, tag: string): string | null => {
  const t = block(xml, tag)?.trim();
  return t ? t : null;
};

export function parseFormD(raw: string): FormDFields | null {
  if (!/<edgarSubmission[\s>]/.test(raw)) return null;
  const xml = stripPeople(raw);
  const amount = (tag: string) => {
    const v = text(xml, tag);
    return v && /^(\d{1,15}|Indefinite)$/i.test(v) ? v : null;
  };
  const firstSale = block(xml, "dateOfFirstSale");
  const saleDate = firstSale ? text(firstSale, "value") : null;
  const year = block(xml, "yearOfInc");
  let yearOfInc: string | null = null;
  if (year) {
    const y = text(year, "value");
    if (y && /^\d{4}$/.test(y)) yearOfInc = y;
    else if (text(year, "overFiveYears") === "true") yearOfInc = "over five years";
    else if (text(year, "withinFiveYears") === "true") yearOfInc = "within five years";
  }
  const industry = text(xml, "industryGroupType");
  return {
    totalOfferingAmount: amount("totalOfferingAmount"),
    totalAmountSold: amount("totalAmountSold"),
    dateOfFirstSale: saleDate && /^\d{4}-\d{2}-\d{2}$/.test(saleDate) ? saleDate : null,
    firstSaleYetToOccur: !!firstSale && /<yetToOccur>\s*true\s*</.test(firstSale),
    industryGroup: (industry && INDUSTRY_BY_KEY.get(industryKey(industry))) || null,
    yearOfInc,
    isAmendment: text(xml, "isAmendment") === "true",
  };
}

/** The directory of a filing: `/Archives/edgar/data/<cik>/<accession without dashes>`. */
export const filingFolder = (cik: string, accession: string): string =>
  `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accession.replace(/-/g, "")}`;

/** One Form D's raw XML, read through the allow-list above. */
export async function getFormD(
  fetcher: Fetcher,
  cache: Cache,
  cik: string,
  accession: string,
): Promise<{ ok: true; d: FormDFields } | FailedOutcome> {
  const url = `${filingFolder(cik, accession)}/primary_doc.xml`;
  const r = await fetchParsed(fetcher, cache, url, 500_000, parseFormD, "Form D");
  return r.ok ? { ok: true, d: r.value } : r;
}

// ----------------------------------------------------------------- helpers

/** True when the entity has filed at least one form that only companies file (exact match, no prefixes). */
export function isListableCompany(sub: Submissions): boolean {
  return sub.filings.some((f) => COMPANY_FORMS.has(f.form.toUpperCase()));
}

/** A name for comparing: no case, punctuation, EDGAR state tags such as /DE/ or (DE), or trailing legal-form words. */
export function normalizeEntityName(s: string): string {
  const undecorated = s
    .replace(/\s*\/[A-Za-z]{2,3}\/\s*$/, "")
    .replace(/\s*\(\s*[A-Za-z]{2}\s*\)\s*$/, "")
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ""));
  return cleanCompanyName(undecorated)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/ (?:lp|llp|lllp)$/, "");
}
