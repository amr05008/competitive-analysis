import { TTL_EDGAR } from "../config";
import { cached } from "../shared/cache";
import { politeFetch, type FailedOutcome, type Fetcher } from "../shared/http";
import { cleanCompanyName } from "../shared/inputs";

/** Filing forms that individuals file about themselves; an entity with only these is a person, not a company. */
export const OWNERSHIP_FORMS = new Set([
  "3", "4", "5", "3/A", "4/A", "5/A", "144", "144/A",
  "SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A",
  "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A",
]);
const ISSUER_FORMS = new Set(["D", "D/A", "S-1", "10-K", "10-Q"]);

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
  ownerOnly: boolean;
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

/** EDGAR's company typeahead. Its hits are suggestions, so they include funds, SPVs and individuals. */
export async function searchEntities(
  fetcher: Fetcher,
  cache: Cache,
  name: string,
): Promise<{ ok: true; hits: { cik: string; name: string }[] } | FailedOutcome> {
  const url = `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(name)}`;
  const r = await fetchParsed(fetcher, cache, url, 500_000, (text) => {
    const hits = obj(obj(parseJson(text)?.hits))?.hits;
    if (!Array.isArray(hits)) return null;
    const out: { cik: string; name: string }[] = [];
    for (const h of hits) {
      const id = str(obj(h)?._id);
      const entity = str(obj(obj(h)?._source)?.entity);
      if (id && /^\d+$/.test(id) && entity) out.push({ cik: id, name: entity.slice(0, MAX_NAME_CHARS) });
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

function parseSubmissions(text: string): Submissions | null {
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
  return {
    cik: cik.replace(/^0+(?=\d)/, ""),
    name: name.slice(0, MAX_NAME_CHARS),
    stateOfIncorporation: stateOf(body.stateOfIncorporation),
    businessState: stateOf(obj(obj(body.addresses)?.business)?.stateOrCountry),
    formerNames: former,
    ownerOnly: body.insiderTransactionForOwnerExists === 1,
    filings,
  };
}

/** One company's submissions record, reduced to the allow-listed fields. */
export async function getSubmissions(
  fetcher: Fetcher,
  cache: Cache,
  cik: string,
): Promise<{ ok: true; sub: Submissions } | FailedOutcome> {
  const url = `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`;
  const r = await fetchParsed(fetcher, cache, url, 3_000_000, parseSubmissions, "submissions");
  return r.ok ? { ok: true, sub: r.value } : r;
}

// ------------------------------------------------------------------- Form D

/** Elements that name people. They are cut out whole, to the end of the document when unclosed, before anything is read. */
const PEOPLE_ELEMENTS = ["relatedPersonsList", "signatureBlock", "salesCompensationList"];

function stripPeople(xml: string): string {
  let out = xml;
  for (const tag of PEOPLE_ELEMENTS) {
    for (;;) {
      const open = out.search(new RegExp(`<${tag}(?=[\\s/>])`));
      if (open < 0) break;
      const selfClosed = new RegExp(`^<${tag}[^>]*/>`).exec(out.slice(open));
      if (selfClosed) {
        out = out.slice(0, open) + out.slice(open + selfClosed[0].length);
        continue;
      }
      const close = out.indexOf(`</${tag}>`, open);
      out = close < 0 ? out.slice(0, open) : out.slice(0, open) + out.slice(close + tag.length + 3);
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
    industryGroup: industry && /^[\w ,&/().'-]{1,100}$/.test(industry) ? industry : null,
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

/** True when the record belongs to an individual or has nothing to show a company by. */
export function isPersonFiler(sub: Submissions): boolean {
  if (sub.filings.length === 0) return true;
  if (sub.filings.every((f) => OWNERSHIP_FORMS.has(f.form.toUpperCase()))) return true;
  return sub.ownerOnly && !sub.filings.some((f) => ISSUER_FORMS.has(f.form.toUpperCase()));
}

/** A name for comparing: no case, punctuation or trailing legal-form words. */
export function normalizeEntityName(s: string): string {
  return cleanCompanyName(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
