import { describe, expect, it } from "vitest";
import { getFormD, getSubmissions, isPersonFiler, normalizeEntityName, searchEntities, type Submissions } from "../../src/sources/edgar";
import { fakeFetch } from "../helpers/fake-fetch";
import searchStripe from "../fixtures/edgar/search-stripe.json";
import searchEmpty from "../fixtures/edgar/search-hightouch-empty.json";
import subStripe from "../fixtures/edgar/submissions-stripe.json";
import subPerson from "../fixtures/edgar/submissions-person.json";
import formDStripe from "../fixtures/edgar/formd-stripe.xml?raw";

const SEARCH = "https://efts.sec.gov/LATEST/search-index?keysTyped=";
const SUB = "https://data.sec.gov/submissions/CIK0001691342.json";
const FORM_D = "https://www.sec.gov/Archives/edgar/data/1691342/000169134224000001/primary_doc.xml";
const fresh = () => caches.open(`edgar-${crypto.randomUUID()}`);

const sub = (over: Partial<Submissions>): Submissions => ({
  cik: "1",
  name: "X",
  stateOfIncorporation: null,
  businessState: null,
  formerNames: [],
  ownerOnly: false,
  filings: [{ form: "D", date: "2024-01-01", accession: "0000000001-24-000001" }],
  ...over,
});
const filings = (...forms: string[]) => forms.map((form) => ({ form, date: "2024-01-01", accession: "0000000001-24-000001" }));

describe("searchEntities", () => {
  it("reads cik and name from hits.hits", async () => {
    const f = fakeFetch({ [`${SEARCH}stripe`]: JSON.stringify(searchStripe) });
    const r = await searchEntities(f, await fresh(), "stripe");
    expect(r.ok && r.hits[0]).toEqual({ cik: "1691342", name: "Stripe, Inc." });
    expect(f.calls).toEqual([`${SEARCH}stripe`]);
  });

  it("encodes the name and treats no hits as an empty list", async () => {
    const f = fakeFetch({ [`${SEARCH}Carry%20Technologies`]: JSON.stringify(searchEmpty) });
    const r = await searchEntities(f, await fresh(), "Carry Technologies");
    expect(r).toEqual({ ok: true, hits: [] });
  });

  it("caches the answer", async () => {
    const f = fakeFetch({ [`${SEARCH}stripe`]: JSON.stringify(searchStripe) });
    const cache = await fresh();
    await searchEntities(f, cache, "stripe");
    await searchEntities(f, cache, "stripe");
    expect(f.calls).toHaveLength(1);
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
    if (!r.ok) return;
    expect(r.sub).toMatchObject({ cik: "1691342", name: "Stripe, Inc.", stateOfIncorporation: "DE", businessState: "CA", formerNames: [], ownerOnly: false });
    expect(r.sub.filings[0]).toEqual({ form: "D", date: "2024-04-12", accession: "0001691342-24-000001" });
    expect(r.sub.filings[1].form).toBe("D/A");
    expect(Object.keys(r.sub).sort()).toEqual(["businessState", "cik", "filings", "formerNames", "name", "ownerOnly", "stateOfIncorporation"]);
    expect(JSON.stringify(r.sub)).not.toMatch(/BERRY|298-5539|270465600/);
  });

  it("maps an empty incorporation state to null and flags owner-only filers", async () => {
    const r = await getSubmissions(fakeFetch({ "https://data.sec.gov/submissions/CIK0009999999.json": JSON.stringify(subPerson) }), await fresh(), "9999999");
    expect(r.ok && r.sub.stateOfIncorporation).toBeNull();
    expect(r.ok && r.sub.ownerOnly).toBe(true);
    expect(r.ok && r.sub.filings.map((x) => x.form)).toEqual(["4", "4", "4"]);
  });

  it("reads former names", async () => {
    const body = { ...subStripe, formerNames: [{ name: "Old Co", from: "2010", to: "2012" }] };
    const r = await getSubmissions(fakeFetch({ [SUB]: JSON.stringify(body) }), await fresh(), "1691342");
    expect(r.ok && r.sub.formerNames).toEqual(["Old Co"]);
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
<offeringData><industryGroup><industryGroupType>Banking</industryGroupType></industryGroup>
<salesCompensationList><recipient><recipientName>Person Q</recipientName><totalAmountSold>5</totalAmountSold></recipient></salesCompensationList>
<offeringSalesAmounts><totalOfferingAmount>Indefinite</totalOfferingAmount><totalAmountSold>12</totalAmountSold></offeringSalesAmounts>
<typeOfFiling><newOrAmendment><isAmendment>true</isAmendment></newOrAmendment><dateOfFirstSale><yetToOccur>true</yetToOccur></dateOfFirstSale></typeOfFiling>
<signatureBlock><signature><signatureName>Person S</signatureName><totalOfferingAmount>1</totalOfferingAmount></signature></signatureBlock></offeringData></edgarSubmission>`;
    const r = await getFormD(fakeFetch({ [FORM_D]: xml }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.d).toMatchObject({ totalOfferingAmount: "Indefinite", totalAmountSold: "12", dateOfFirstSale: null, firstSaleYetToOccur: true, industryGroup: "Banking", isAmendment: true });
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

  it("fails on a document that is not a Form D", async () => {
    const r = await getFormD(fakeFetch({ [FORM_D]: "<html>no</html>" }), await fresh(), "1691342", "0001691342-24-000001");
    expect(r.ok).toBe(false);
  });
});

describe("isPersonFiler", () => {
  it("is true with no filings", () => expect(isPersonFiler(sub({ filings: [] }))).toBe(true));
  it("is true when every form is an ownership form", () => {
    expect(isPersonFiler(sub({ filings: filings("4", "4/A", "SC 13G", "SCHEDULE 13D/A", "144") }))).toBe(true);
  });
  it("is false for an issuer with a Form D", () => {
    expect(isPersonFiler(sub({ filings: filings("4", "D") }))).toBe(false);
  });
  it("is true when owner-only with other forms but none of D, S-1, 10-K, 10-Q", () => {
    expect(isPersonFiler(sub({ ownerOnly: true, filings: filings("8-K", "4") }))).toBe(true);
    expect(isPersonFiler(sub({ ownerOnly: true, filings: filings("10-K", "4") }))).toBe(false);
    expect(isPersonFiler(sub({ ownerOnly: false, filings: filings("8-K", "4") }))).toBe(false);
  });
});

describe("normalizeEntityName", () => {
  it("ignores case, punctuation and legal suffixes", () => {
    expect(normalizeEntityName("Stripe, Inc.")).toBe(normalizeEntityName("STRIPE"));
    expect(normalizeEntityName("Acme  Co., Ltd.")).toBe("acme");
    expect(normalizeEntityName("Stripes V, LP")).not.toBe("stripe");
  });
});
