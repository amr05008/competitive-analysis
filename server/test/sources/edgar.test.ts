import { describe, expect, it } from "vitest";
import { getFormD, getSubmissions, isListableCompany, normalizeEntityName, searchEntities, type Submissions } from "../../src/sources/edgar";
import { fakeFetch } from "../helpers/fake-fetch";
import searchStripe from "../fixtures/edgar/search-stripe.json";
import searchEmpty from "../fixtures/edgar/search-hightouch-empty.json";
import subStripe from "../fixtures/edgar/submissions-stripe.json";
import subPerson from "../fixtures/edgar/submissions-person.json";
import formDStripe from "../fixtures/edgar/formd-stripe.xml?raw";

const SEARCH = "https://efts.sec.gov/LATEST/search-index?keysTyped=";
const SUB = "https://data.sec.gov/submissions/CIK0001691342.json";
const FORM_D = "https://www.sec.gov/Archives/edgar/data/1691342/000169134224000001/primary_doc.xml";
const CACHE_BASE = "https://cache.competitive-analysis.invalid/";
const seed = (cache: Cache, url: string, value: unknown) =>
  cache.put(new Request(CACHE_BASE + encodeURIComponent(`v2:${url}`)), new Response(JSON.stringify(value), { headers: { "cache-control": "max-age=600" } }));
const fresh = () => caches.open(`edgar-${crypto.randomUUID()}`);

const sub = (over: Partial<Submissions>): Submissions => ({
  cik: "1",
  name: "X",
  stateOfIncorporation: null,
  businessState: null,
  formerNames: [],
  filings: [{ form: "D", date: "2024-01-01", accession: "0000000001-24-000001" }],
  ...over,
});
const filings = (...forms: string[]) => forms.map((form) => ({ form, date: "2024-01-01", accession: "0000000001-24-000001" }));

describe("searchEntities", () => {
  it("reads cik and name from hits.hits", async () => {
    const f = fakeFetch({ [`${SEARCH}stripe`]: JSON.stringify(searchStripe) });
    const r = await searchEntities(f, await fresh(), "stripe");
    expect(r.ok && r.hits[0]).toEqual({ cik: "1691342", exact: true });
    expect(r.ok && r.hits[1]).toEqual({ cik: "1375453", exact: false });
    expect(f.calls).toEqual([`${SEARCH}stripe`]);
  });

  it("encodes the name and treats no hits as an empty list", async () => {
    const f = fakeFetch({ [`${SEARCH}Carry%20Technologies`]: JSON.stringify(searchEmpty) });
    const r = await searchEntities(f, await fresh(), "Carry Technologies");
    expect(r).toEqual({ ok: true, hits: [] });
  });

  it("caches the answer, and the cached entry holds no names", async () => {
    const f = fakeFetch({ [`${SEARCH}stripe`]: JSON.stringify(searchStripe) });
    const cache = await fresh();
    const first = await searchEntities(f, cache, "stripe");
    const second = await searchEntities(f, cache, "stripe");
    expect(f.calls).toHaveLength(1);
    expect(second).toEqual(first);
    const entry = await cache.match(new Request(CACHE_BASE + encodeURIComponent(`v2:${SEARCH}stripe`)));
    expect(entry).toBeTruthy();
    expect(await (entry as Response).text()).not.toMatch(/Stripe|LLC|LP/);
  });

  it("fails on an unreadable body and on HTTP errors", async () => {
    const bad = await searchEntities(fakeFetch({ [`${SEARCH}x`]: "<html>" }), await fresh(), "x");
    expect(bad.ok).toBe(false);
    const down = await searchEntities(fakeFetch({ [`${SEARCH}x`]: { status: 503 } }), await fresh(), "x");
    expect(!down.ok && down.reason).toBe("source_unavailable");
  });
});

describe("getSubmissions", () => {
  it("keeps only the allow-listed fields", async () => {
    const r = await getSubmissions(fakeFetch({ [SUB]: JSON.stringify(subStripe) }), await fresh(), "1691342");
    expect(r.ok).toBe(true);
    if (!r.ok || !r.sub) throw new Error("expected a listable company");
    expect(r.sub).toMatchObject({ cik: "1691342", name: "Stripe, Inc.", stateOfIncorporation: "DE", businessState: "CA", formerNames: [] });
    expect(r.sub.filings[0]).toEqual({ form: "D", date: "2024-04-12", accession: "0001691342-24-000001" });
    expect(r.sub.filings[1].form).toBe("D/A");
    expect(Object.keys(r.sub).sort()).toEqual(["businessState", "cik", "filings", "formerNames", "name", "stateOfIncorporation"]);
    expect(JSON.stringify(r.sub)).not.toMatch(/BERRY|298-5539/);
    expect(r.sub).not.toHaveProperty("ein");
  });

  it("returns null for an individual filer and caches only a sentinel with no name", async () => {
    const url = "https://data.sec.gov/submissions/CIK0009999999.json";
    const f = fakeFetch({ [url]: JSON.stringify(subPerson) });
    const cache = await fresh();
    const r = await getSubmissions(f, cache, "9999999");
    expect(r).toEqual({ ok: true, sub: null });
    const entry = await cache.match(new Request(CACHE_BASE + encodeURIComponent(`v2:${url}`)));
    const raw = await (entry as Response).text();
    expect(raw).toBe('{"listable":false}');
    expect(raw).not.toMatch(/Person|"4"|0009999999/);
    // a cached sentinel is "not listable" without a fetch
    expect(await getSubmissions(f, cache, "9999999")).toEqual({ ok: true, sub: null });
    expect(f.calls).toHaveLength(1);
  });

  it("re-applies the rule to an old-shape full record of a person filer in the cache", async () => {
    const url = "https://data.sec.gov/submissions/CIK0009999999.json";
    const cache = await fresh();
    await seed(cache, url, { cik: "9999999", name: "Person A", stateOfIncorporation: null, businessState: null, formerNames: [], ownerOnly: true, filings: filings("4", "13F-HR") });
    const f = fakeFetch({});
    expect(await getSubmissions(f, cache, "9999999")).toEqual({ ok: true, sub: null });
    expect(f.calls).toHaveLength(0);
  });

  it("treats a malformed or loosely shaped cached value as not listable", async () => {
    const url = "https://data.sec.gov/submissions/CIK0009999999.json";
    for (const bad of [{ listable: false, name: "Person A" }, { listable: true }, "text", [], { cik: 1, name: "X", filings: [] }, { cik: "1", name: "X", stateOfIncorporation: null, businessState: null, formerNames: [], filings: [{ form: "D" }] }]) {
      const cache = await fresh();
      await seed(cache, url, bad);
      expect(await getSubmissions(fakeFetch({}), cache, "9999999"), JSON.stringify(bad)).toEqual({ ok: true, sub: null });
    }
  });

  it("returns a valid cached listable record as is", async () => {
    const url = "https://data.sec.gov/submissions/CIK0000000007.json";
    const cache = await fresh();
    const record = { cik: "7", name: "Seven Inc", stateOfIncorporation: "DE", businessState: "NY", formerNames: ["Six Inc"], filings: filings("8-K") };
    await seed(cache, url, record);
    const f = fakeFetch({});
    expect(await getSubmissions(f, cache, "7")).toEqual({ ok: true, sub: record });
    expect(f.calls).toHaveLength(0);
  });

  it("reads former names", async () => {
    const body = { ...subStripe, formerNames: [{ name: "Old Co", from: "2010", to: "2012" }] };
    const r = await getSubmissions(fakeFetch({ [SUB]: JSON.stringify(body) }), await fresh(), "1691342");
    expect(r.ok && r.sub?.formerNames).toEqual(["Old Co"]);
  });

  it("fails on a body that is not submissions", async () => {
    const r = await getSubmissions(fakeFetch({ [SUB]: "{}" }), await fresh(), "1691342");
    expect(r.ok).toBe(false);
  });
});

describe("getFormD", () => {
  it("returns Stripe's figures", async () => {
    const r = await getFormD(fakeFetch({ [FORM_D]: formDStripe }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.d).toEqual({
      totalOfferingAmount: "694159778",
      totalAmountSold: "694159778",
      dateOfFirstSale: "2024-04-08",
      firstSaleYetToOccur: false,
      industryGroup: "Other",
      yearOfInc: "over five years",
      isAmendment: false,
    });
  });

  it("never exposes people, even when the allow-listed elements surround them", async () => {
    const xml = `<edgarSubmission><relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>Person</firstName><lastName>Z</lastName></relatedPersonName></relatedPersonInfo></relatedPersonsList>
<offeringData><industryGroup><industryGroupType>Insurance</industryGroupType></industryGroup>
<salesCompensationList><recipient><recipientName>Person Q</recipientName><totalAmountSold>5</totalAmountSold></recipient></salesCompensationList>
<offeringSalesAmounts><totalOfferingAmount>Indefinite</totalOfferingAmount><totalAmountSold>12</totalAmountSold></offeringSalesAmounts>
<typeOfFiling><newOrAmendment><isAmendment>true</isAmendment></newOrAmendment><dateOfFirstSale><yetToOccur>true</yetToOccur></dateOfFirstSale></typeOfFiling>
<signatureBlock><signature><signatureName>Person S</signatureName><totalOfferingAmount>1</totalOfferingAmount></signature></signatureBlock></offeringData></edgarSubmission>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.d).toMatchObject({ totalOfferingAmount: "Indefinite", totalAmountSold: "12", dateOfFirstSale: null, firstSaleYetToOccur: true, industryGroup: "Insurance", isAmendment: true });
    expect(JSON.stringify(r.d)).not.toMatch(/Person/);
  });

  it("drops an unclosed people element through the end of the document", async () => {
    const xml = `<edgarSubmission><offeringData><offeringSalesAmounts><totalOfferingAmount>7</totalOfferingAmount></offeringSalesAmounts><signatureBlock><signatureName>Person S</signatureName><totalAmountSold>99</totalAmountSold>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok && r.d.totalAmountSold).toBeNull();
    expect(r.ok && r.d.totalOfferingAmount).toBe("7");
  });

  it("reads within five years, and nulls values outside the expected shapes", async () => {
    const xml = `<edgarSubmission><primaryIssuer><yearOfInc><withinFiveYears>true</withinFiveYears></yearOfInc></primaryIssuer><offeringData><offeringSalesAmounts><totalOfferingAmount>call me at 555</totalOfferingAmount></offeringSalesAmounts></offeringData></edgarSubmission>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok && r.d.yearOfInc).toBe("within five years");
    expect(r.ok && r.d.totalOfferingAmount).toBeNull();
  });

  it("reads a year of incorporation", async () => {
    const xml = `<edgarSubmission><primaryIssuer><yearOfInc><value>2019</value></yearOfInc></primaryIssuer></edgarSubmission>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok && r.d.yearOfInc).toBe("2019");
  });

  it("cuts namespace-prefixed people sections", async () => {
    const xml = `<ns1:edgarSubmission><ns1:relatedPersonsList><ns1:relatedPersonInfo><ns1:firstName>Person</ns1:firstName></ns1:relatedPersonInfo></ns1:relatedPersonsList><offeringData><offeringSalesAmounts><totalOfferingAmount>9</totalOfferingAmount></offeringSalesAmounts><ns1:signatureBlock><totalAmountSold>77</totalAmountSold></ns1:signatureBlock></offeringData></ns1:edgarSubmission>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml.replace("<ns1:edgarSubmission>", "<edgarSubmission>").replace("</ns1:edgarSubmission>", "</edgarSubmission>") }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok && r.d.totalOfferingAmount).toBe("9");
    expect(r.ok && r.d.totalAmountSold).toBeNull();
  });

  it("nulls an industry group outside the published list", async () => {
    const xml = `<edgarSubmission><offeringData><industryGroup><industryGroupType>Call Person Z at 555-1212</industryGroupType></industryGroup></offeringData></edgarSubmission>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok && r.d.industryGroup).toBeNull();
    const ok = `<edgarSubmission><offeringData><industryGroup><industryGroupType>Oil &amp; Gas</industryGroupType></industryGroup></offeringData></edgarSubmission>`;
    const r2 = await getFormD(fakeFetch({ [FORM_D]: ok.replace("&amp;", "and") }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r2.ok && r2.d.industryGroup).toBe("Oil and Gas");
  });

  it("fails on a document that is not a Form D", async () => {
    const r = await getFormD(fakeFetch({ [FORM_D]: "<html>no</html>" }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok).toBe(false);
  });
});

describe("isListableCompany", () => {
  it("is false with no filings", () => expect(isListableCompany(sub({ filings: [] }))).toBe(false));
  it("excludes an MA-I-only filer", () => expect(isListableCompany(sub({ filings: filings("MA-I") }))).toBe(false));
  it("excludes activist and ownership filers, matching forms exactly", () => {
    expect(isListableCompany(sub({ filings: filings("SC 13D", "DFAN14A") }))).toBe(false);
    expect(isListableCompany(sub({ filings: filings("DFAN14A", "PREC14A", "SC TO-T", "4", "144") }))).toBe(false);
  });
  it("excludes an individual manager who files 13F-HR among activist and ownership forms", () => {
    expect(isListableCompany(sub({ cik: "123456", name: "Person B", filings: filings("SC 13D/A", "4", "DFAN14A", "13F-HR", "13F-HR/A") }))).toBe(false);
  });
  it("includes an 8-K plus Form 4 issuer", () => expect(isListableCompany(sub({ filings: filings("8-K", "4") }))).toBe(true));
  it("includes Stripe (D and D/A)", async () => {
    const r = await getSubmissions(fakeFetch({ [SUB]: JSON.stringify(subStripe) }), await fresh(), "1691342");
    expect(r.ok && r.sub && isListableCompany(r.sub)).toBe(true);
  });
  it("includes the other company forms", () => {
    for (const f of ["D", "D/A", "S-1", "10-K", "10-Q", "C", "1-A", "DEF 14A", "424B4"]) {
      expect(isListableCompany(sub({ filings: filings(f) })), f).toBe(true);
    }
  });
});

describe("normalizeEntityName", () => {
  it("ignores case, punctuation and legal suffixes", () => {
    expect(normalizeEntityName("Stripe, Inc.")).toBe(normalizeEntityName("STRIPE"));
    expect(normalizeEntityName("Acme  Co., Ltd.")).toBe("acme");
    expect(normalizeEntityName("Stripes V, LP")).not.toBe("stripe");
    expect(normalizeEntityName("Stripe, Inc.")).not.toBe(normalizeEntityName("Strip"));
  });
  it("strips EDGAR's conformed-name decorations", () => {
    expect(normalizeEntityName("MATTEL INC /DE/")).toBe("mattel");
    expect(normalizeEntityName("ACME L.L.C.")).toBe("acme");
    expect(normalizeEntityName("ACME L.P.")).toBe("acme");
    expect(normalizeEntityName("Acme Inc. (DE)")).toBe("acme");
    expect(normalizeEntityName("ACME INC.")).toBe("acme");
  });
});
