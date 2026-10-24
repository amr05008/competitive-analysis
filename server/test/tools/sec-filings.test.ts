import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RESPONSE_CAP_CHARS } from "../../src/config";
import { secOutput, type SecInput, type SecResult } from "../../src/contract/tools";
import { callDeps, render, type ToolDeps } from "../../src/tools";
import { renderSec, secFilings } from "../../src/tools/sec-filings";
import { Subrequests } from "../../src/shared/subrequests";
import { fakeFetch, type FakeFetch, type Route } from "../helpers/fake-fetch";
import { meter } from "../helpers/meter";
import searchStripe from "../fixtures/edgar/search-stripe.json";
import searchEmpty from "../fixtures/edgar/search-hightouch-empty.json";
import subStripe from "../fixtures/edgar/submissions-stripe.json";
import subPerson from "../fixtures/edgar/submissions-person.json";
import formDStripe from "../fixtures/edgar/formd-stripe.xml?raw";

const NOW = Date.UTC(2026, 9, 24, 12);
const SEARCH = "https://efts.sec.gov/LATEST/search-index?keysTyped=";
const subUrl = (cik: string) => `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`;
const formDUrl = (cik: string, acc: string) => `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/primary_doc.xml`;
const STRIPE_D = formDUrl("1691342", "0001691342-24-000001");
const schema = z.object(secOutput);

const searchBody = (hits: [string, string][]) =>
  JSON.stringify({ hits: { hits: hits.map(([id, entity]) => ({ _id: id, _source: { entity } })) } });
const person = (cik: string) => JSON.stringify({ ...subPerson, cik });

/** Search hits for the Stripe fixture, with every other CIK an individual filer. */
function stripeRoutes(): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${SEARCH}Stripe`]: JSON.stringify(searchStripe),
    [subUrl("1691342")]: JSON.stringify(subStripe),
  };
  for (const acc of subStripe.filings.recent.accessionNumber.slice(0, 5)) routes[formDUrl("1691342", acc)] = formDStripe;
  for (const h of searchStripe.hits.hits) if (h._id !== "1691342") routes[subUrl(h._id)] = person(h._id);
  return routes;
}

function makeSub(name: string, cik: string, over: Record<string, unknown> = {}, forms: string[] = ["D"]) {
  return JSON.stringify({
    cik,
    name,
    insiderTransactionForOwnerExists: 0,
    insiderTransactionForIssuerExists: 0,
    stateOfIncorporation: "DE",
    addresses: { business: { stateOrCountry: "NY" } },
    formerNames: [],
    filings: {
      recent: {
        form: forms,
        filingDate: forms.map((_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`),
        accessionNumber: forms.map((_, i) => `${cik.padStart(10, "0")}-24-${String(i + 1).padStart(6, "0")}`),
        primaryDocument: forms.map(() => "xslFormDX01/primary_doc.xml"),
      },
    },
    ...over,
  });
}

async function deps(fetch: FakeFetch, now: () => number = () => NOW): Promise<ToolDeps> {
  return {
    fetch,
    archive: async () => {
      throw new Error("sec_filings must not use the archive");
    },
    cache: await caches.open(`sec-${crypto.randomUUID()}`),
    now,
    subrequests: new Subrequests(45),
  };
}

async function call(
  input: SecInput,
  routes: Record<string, Route>,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; maxFetches?: number } = {},
): Promise<{ result: SecResult; fetch: FakeFetch }> {
  const fetch = fakeFetch(routes);
  const result = await secFilings(input, await deps(fetch, opts.now), { sleep: opts.sleep ?? (async () => {}), maxFetches: opts.maxFetches });
  expect(() => schema.parse(result)).not.toThrow();
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_CAP_CHARS);
  return { result, fetch };
}

describe("sec_filings", () => {
  it("returns Stripe's Form D figures", async () => {
    const { result } = await call({ company_name: "Stripe" }, stripeRoutes());
    expect(result.status).toBe("ok");
    const e = result.entities?.[0];
    expect(result.entities).toHaveLength(1);
    expect(e).toMatchObject({ name: "Stripe, Inc.", cik: "1691342", state: "CA", exact_match: true });
    expect(e?.edgar_link).toBe("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1691342");
    expect(e?.form_d[0]).toMatchObject({
      date_filed: "2024-04-12",
      amendment: false,
      total_offering_amount: "694159778",
      total_amount_sold: "694159778",
      date_of_first_sale: "2024-04-08",
      industry_group: "Other",
      year_of_incorporation: "over five years",
      link: "https://www.sec.gov/Archives/edgar/data/1691342/000169134224000001/0001691342-24-000001-index.htm",
    });
    expect(e?.form_d[1]?.amendment).toBe(true);
    expect(e?.filings[0]).toEqual({
      form: "D",
      date: "2024-04-12",
      link: "https://www.sec.gov/Archives/edgar/data/1691342/000169134224000001/0001691342-24-000001-index.htm",
    });
    expect(result.statement).toBeNull();
  });

  it("never returns related persons, signers or sales-compensation names", async () => {
    const { result } = await call({ company_name: "Stripe" }, stripeRoutes());
    const text = JSON.stringify(result) + render("sec_filings", result);
    expect(text).not.toMatch(/Person|Berry|Oyster|298-5539/);
    expect(result.entities?.[0]).not.toHaveProperty("ein");
  });

  it("drops individual filers", async () => {
    const routes: Record<string, Route> = {
      [`${SEARCH}Zed`]: searchBody([["9999999", "Person A"], ["1691342", "Zed Inc"]]),
      [subUrl("9999999")]: JSON.stringify(subPerson),
      [subUrl("1691342")]: JSON.stringify(subStripe),
      [STRIPE_D]: formDStripe,
    };
    const { result } = await call({ company_name: "Zed" }, routes);
    expect(result.entities?.map((e) => e.cik)).toEqual(["1691342"]);
    expect(JSON.stringify(result)).not.toContain("Person A");
  });

  it("says plainly when nothing is filed", async () => {
    const { result } = await call({ company_name: "Hightouch" }, { [`${SEARCH}Hightouch`]: JSON.stringify(searchEmpty) });
    expect(result.status).toBe("ok");
    expect(result.entities).toEqual([]);
    expect(result.statement).toBe("no filings found under these names: Hightouch");
  });

  it("says plainly when every hit is an individual", async () => {
    const { result } = await call(
      { company_name: "Hightouch" },
      { [`${SEARCH}Hightouch`]: searchBody([["9999999", "Person A"]]), [subUrl("9999999")]: JSON.stringify(subPerson) },
    );
    expect(result.entities).toEqual([]);
    expect(result.statement).toBe("no filings found under these names: Hightouch");
  });

  it("cleans legal suffixes before searching", async () => {
    const { result, fetch } = await call({ company_name: "Carry Technologies, Inc." }, { [`${SEARCH}Carry%20Technologies`]: JSON.stringify(searchEmpty) });
    expect(fetch.calls).toEqual([`${SEARCH}Carry%20Technologies`]);
    expect(result.names_tried).toEqual(["Carry Technologies"]);
  });

  it("tries the domain's first label as a second name when it differs", async () => {
    const empty = JSON.stringify(searchEmpty);
    const { result, fetch } = await call(
      { company_name: "Hightouch", domain: "https://www.carry.tech/about" },
      { [`${SEARCH}Hightouch`]: empty, [`${SEARCH}carry`]: empty },
    );
    expect(result.names_tried).toEqual(["Hightouch", "carry"]);
    expect(fetch.calls).toEqual([`${SEARCH}Hightouch`, `${SEARCH}carry`]);
    expect(result.statement).toBe("no filings found under these names: Hightouch, carry");
  });

  it("skips the domain label when it matches the name", async () => {
    const { result } = await call({ company_name: "Hightouch", domain: "hightouch.com" }, { [`${SEARCH}Hightouch`]: JSON.stringify(searchEmpty) });
    expect(result.names_tried).toEqual(["Hightouch"]);
  });

  it("refuses an unusable domain before any fetch", async () => {
    const { result, fetch } = await call({ company_name: "Example", domain: "127.0.0.1" }, {});
    expect(result.status).toBe("error");
    expect(result.error?.reason).toBe("bad_input");
    expect(fetch.calls).toEqual([]);
  });

  it("refuses a bad state before any fetch", async () => {
    const { result, fetch } = await call({ company_name: "Example", state: "9!" }, {});
    expect(result.error?.reason).toBe("bad_input");
    expect(fetch.calls).toEqual([]);
  });

  it("close matches are labeled", async () => {
    const routes: Record<string, Route> = {
      [`${SEARCH}Acme`]: searchBody([["11", "Acme Holdings Group"], ["12", "Acme Partners"]]),
      [subUrl("11")]: makeSub("Acme Holdings Group", "11"),
      [subUrl("12")]: makeSub("Acme Partners", "12"),
      [formDUrl("11", "0000000011-24-000001")]: formDStripe,
      [formDUrl("12", "0000000012-24-000001")]: formDStripe,
    };
    const { result } = await call({ company_name: "Acme" }, routes);
    expect(result.entities?.map((e) => e.exact_match)).toEqual([false, false]);
    expect(result.notes).toContain("no exact name match; these are close matches");
  });

  it("an exact match gets no close-match note", async () => {
    const { result } = await call({ company_name: "Stripe" }, stripeRoutes());
    expect(result.notes.join(" ")).not.toContain("close matches");
  });

  it("state ranks matching entities first", async () => {
    const routes: Record<string, Route> = {
      [`${SEARCH}Acme`]: searchBody([["11", "Acme East"], ["12", "Acme West"]]),
      [subUrl("11")]: makeSub("Acme East", "11"),
      [subUrl("12")]: makeSub("Acme West", "12", { addresses: { business: { stateOrCountry: "CA" } } }),
    };
    const base = (cik: string) => formDUrl(cik, `00000000${cik}-24-000001`);
    routes[base("11")] = formDStripe;
    routes[base("12")] = formDStripe;
    const plain = await call({ company_name: "Acme" }, routes);
    expect(plain.result.entities?.map((e) => e.cik)).toEqual(["11", "12"]);
    const ranked = await call({ company_name: "Acme", state: "ca" }, routes);
    expect(ranked.result.entities?.map((e) => e.cik)).toEqual(["12", "11"]);
  });

  it("keeps at most 5 entities, 20 filings and 5 Form Ds each", async () => {
    const many = Array.from({ length: 7 }, (_, i) => [String(100 + i), `Big ${i}`] as [string, string]);
    const routes: Record<string, Route> = { [`${SEARCH}Big`]: searchBody(many) };
    const forms = Array.from({ length: 30 }, (_, i) => (i < 8 ? "D" : "8-K"));
    for (const [cik, name] of many) {
      routes[subUrl(cik)] = makeSub(name, cik, {}, forms);
      for (let i = 0; i < 8; i++) routes[formDUrl(cik, `${cik.padStart(10, "0")}-24-${String(i + 1).padStart(6, "0")}`)] = formDStripe;
    }
    const { result } = await call({ company_name: "Big" }, routes, { maxFetches: 100 });
    expect(result.entities).toHaveLength(5);
  });

  it("lists 20 filings and reads 5 Form Ds for a company", async () => {
    const routes: Record<string, Route> = { [`${SEARCH}Big`]: searchBody([["100", "Big 0"]]) };
    const forms = Array.from({ length: 30 }, (_, i) => (i < 8 ? "D" : "8-K"));
    routes[subUrl("100")] = makeSub("Big 0", "100", {}, forms);
    for (let i = 0; i < 8; i++) routes[formDUrl("100", `0000000100-24-${String(i + 1).padStart(6, "0")}`)] = formDStripe;
    const { result, fetch } = await call({ company_name: "Big" }, routes);
    expect(result.entities?.[0].filings).toHaveLength(20);
    expect(result.entities?.[0].form_d).toHaveLength(5);
    expect(fetch.calls).toHaveLength(2 + 5);
  });

  it("an EDGAR failure after the search returns the search as partial", async () => {
    const routes: Record<string, Route> = {
      [`${SEARCH}Acme`]: searchBody([["11", "Acme Inc"], ["12", "Acme Two"]]),
      [subUrl("11")]: { status: 503 },
      [subUrl("12")]: { status: 503 },
    };
    const { result } = await call({ company_name: "Acme" }, routes);
    expect(result.status).toBe("partial");
    expect(result.names_tried).toEqual(["Acme"]);
    expect(result.statement).toBeNull();
    expect(result.notes.join(" ")).toMatch(/could not be read.*source_unavailable/);
  });

  it("a rate limit stops further requests and keeps what was read", async () => {
    const routes: Record<string, Route> = {
      [`${SEARCH}Acme`]: searchBody([["11", "Acme Inc"], ["12", "Acme Two"], ["13", "Acme Three"]]),
      [subUrl("11")]: makeSub("Acme Inc", "11"),
      [subUrl("12")]: { status: 429 },
      [formDUrl("11", "0000000011-24-000001")]: formDStripe,
    };
    const { result, fetch } = await call({ company_name: "Acme" }, routes);
    expect(result.status).toBe("partial");
    expect(result.entities?.map((e) => e.cik)).toEqual(["11"]);
    expect(fetch.calls[fetch.calls.length - 1]).toBe(subUrl("12")); // nothing follows the 429, not even a Form D
    expect(fetch.calls).not.toContain(formDUrl("11", "0000000011-24-000001"));
    expect(result.notes.join(" ")).toContain("wait a few minutes before calling again");
  });

  it("returns an error when the search itself fails", async () => {
    const { result } = await call({ company_name: "Acme" }, { [`${SEARCH}Acme`]: { status: 503 } });
    expect(result.status).toBe("error");
    expect(result.error?.reason).toBe("source_unavailable");
    expect(result.error?.tried).toEqual([`${SEARCH}Acme`]);
  });

  it("a 429 on the only search is an error that says to wait", async () => {
    const { result } = await call({ company_name: "Acme" }, { [`${SEARCH}Acme`]: { status: 429 } });
    expect(result.status).toBe("error");
    expect(result.error?.reason).toBe("source_rate_limited");
    expect(result.error?.detail).toContain("wait a few minutes before calling again");
  });

  it("a failed Form D read keeps the entity and says so", async () => {
    const routes = stripeRoutes();
    routes[STRIPE_D] = { status: 503 };
    const { result } = await call({ company_name: "Stripe" }, routes);
    expect(result.status).toBe("partial");
    expect(result.entities?.[0].form_d).toHaveLength(4); // 4 read of the 5 attempted; the failed one is left out
    expect(result.notes.join(" ")).toMatch(/Form D/);
  });

  it("stops reading Form Ds at the fetch budget and names how many were not read", async () => {
    const routes = stripeRoutes();
    // 4 fetches in all: the search, then Stripe's submissions and two more candidates; no Form D is read.
    const { result, fetch } = await call({ company_name: "Stripe" }, routes, { maxFetches: 4 });
    expect(fetch.calls.length).toBeLessThanOrEqual(4);
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toMatch(/fetch budget of 4 requests used up/);
    expect(result.notes.join(" ")).toContain("5 Form D notices were not read");
  });

  it("checks an exact second-name hit even when the first search fills the candidate slots", async () => {
    const first = Array.from({ length: 10 }, (_, i) => [String(500 + i), `Meta Thing ${i}`] as [string, string]);
    const routes: Record<string, Route> = {
      [`${SEARCH}Meta`]: searchBody(first),
      [`${SEARCH}facebook`]: searchBody([["1326801", "Facebook, Inc."]]),
      [subUrl("1326801")]: makeSub("Facebook, Inc.", "1326801"),
      [formDUrl("1326801", "1326801".padStart(10, "0") + "-24-000001")]: formDStripe,
    };
    for (const [cik, name] of first) routes[subUrl(cik)] = makeSub(name, cik, {}, ["4"]);
    const { result, fetch } = await call({ company_name: "Meta", domain: "facebook.com" }, routes, { maxFetches: 40 });
    expect(fetch.calls).toContain(subUrl("1326801"));
    expect(result.entities?.map((e) => e.name)).toEqual(["Facebook, Inc."]);
    expect(result.entities?.[0].exact_match).toBe(true);
  });

  it("an exact hit late in the second search's list is still checked first", async () => {
    const first = Array.from({ length: 10 }, (_, i) => [String(500 + i), `Meta Thing ${i}`] as [string, string]);
    const second: [string, string][] = Array.from({ length: 6 }, (_, i) => [String(700 + i), `Faceplate ${i}`]);
    second[5] = ["1326801", "Facebook, Inc."];
    const routes: Record<string, Route> = {
      [`${SEARCH}Meta`]: searchBody(first),
      [`${SEARCH}facebook`]: searchBody(second),
      [subUrl("1326801")]: makeSub("Facebook, Inc.", "1326801", {}, ["8-K"]),
    };
    for (const [cik, name] of [...first, ...second]) if (!routes[subUrl(cik)]) routes[subUrl(cik)] = makeSub(name, cik, {}, ["4"]);
    const { result, fetch } = await call({ company_name: "Meta", domain: "facebook.com" }, routes, { maxFetches: 40 });
    // interleaving alone would reach only index 3 of the second list within 8 candidates
    expect(fetch.calls.indexOf(subUrl("1326801"))).toBe(2); // the first submissions read, right after the two searches
    expect(result.entities?.map((e) => e.name)).toEqual(["Facebook, Inc."]);
  });

  it("unchecked hits suppress the no-filings statement", async () => {
    const hits = Array.from({ length: 10 }, (_, i) => [String(600 + i), `Zed ${i}`] as [string, string]);
    const routes: Record<string, Route> = { [`${SEARCH}Zed`]: searchBody(hits) };
    for (const [cik, name] of hits) routes[subUrl(cik)] = makeSub(name, cik, {}, ["4"]);
    const { result } = await call({ company_name: "Zed" }, routes, { maxFetches: 40 });
    expect(result.entities).toEqual([]);
    expect(result.statement).toBeNull();
    expect(result.notes.join(" ")).toContain("2 more matches were not checked");
  });

  it("names the number of unread Form Ds", async () => {
    const forms = ["D", "D", "D", "D", "D"];
    const routes: Record<string, Route> = {
      [`${SEARCH}Solo`]: searchBody([["21", "Solo Inc"]]),
      [subUrl("21")]: makeSub("Solo Inc", "21", {}, forms),
    };
    for (let i = 1; i <= 5; i++) routes[formDUrl("21", `0000000021-24-00000${i}`)] = formDStripe;
    // search + submissions + 2 Form Ds = 4 fetches; 3 Form Ds are left unread.
    const { result } = await call({ company_name: "Solo" }, routes, { maxFetches: 4 });
    expect(result.status).toBe("partial");
    expect(result.entities?.[0].form_d).toHaveLength(2);
    expect(result.notes.join(" ")).toContain("3 Form D notices were not read");
  });

  it("EDGAR requests are at least EDGAR_GAP_MS (150) apart", async () => {
    let clock = NOW;
    const starts: number[] = [];
    const fetch = fakeFetch(stripeRoutes());
    const timed = ((input: RequestInfo | URL, init?: RequestInit) => {
      starts.push(clock);
      clock += 10; // a request takes 10 ms
      return fetch(input, init);
    }) as FakeFetch;
    const slept: number[] = [];
    const d = await deps(timed, () => clock);
    const result = await secFilings({ company_name: "Stripe" }, d, {
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    expect(result.status).toBe("ok");
    expect(starts.length).toBeGreaterThan(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(150);
    expect(slept.length).toBe(starts.length - 1);
  });

  it("cached answers cost no fetch and no wait", async () => {
    const routes = stripeRoutes();
    const f1 = fakeFetch(routes);
    const d = await deps(f1);
    await secFilings({ company_name: "Stripe" }, d, { sleep: async () => {} });
    const first = f1.calls.length;
    const slept: number[] = [];
    await secFilings({ company_name: "Stripe" }, d, { sleep: async (ms) => void slept.push(ms) });
    expect(f1.calls.length).toBe(first);
    expect(slept).toEqual([]);
  });

  it("stops at the deadline", async () => {
    let clock = NOW;
    const fetch = fakeFetch(stripeRoutes());
    const d = await deps(fetch, () => clock);
    const result = await secFilings({ company_name: "Stripe" }, d, {
      sleep: async (ms) => void (clock += ms + 1000),
      deadlineMs: 500,
    });
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toMatch(/time limit/);
  });

  it("starts no request after 18 s, so one that hangs to its 10 s timeout still ends the call under 30 s", async () => {
    // Live, three Form D documents hung to the timeout; the last started at 24 s and the call took 34 s.
    let clock = NOW;
    const inner = fakeFetch(stripeRoutes());
    const slow = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        clock += 7_000; // every request takes seven seconds: they start at 0, 7 and 14 s
        return inner(url, init);
      },
      { calls: inner.calls },
    ) as FakeFetch;
    const result = await secFilings({ company_name: "Stripe" }, await deps(slow, () => clock), {
      sleep: async () => {},
    });
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toContain("time limit of 18 s");
    expect(inner.calls).toHaveLength(3);
  });

  it("shortens lists to fit the response size", async () => {
    const many = Array.from({ length: 5 }, (_, i) => [String(300 + i), `Long ${i} ${"x".repeat(100)}`] as [string, string]);
    const routes: Record<string, Route> = { [`${SEARCH}Long`]: searchBody(many) };
    const forms = [...Array.from({ length: 10 }, () => "D"), ...Array.from({ length: 30 }, () => "8-K")];
    for (const [cik, name] of many) {
      routes[subUrl(cik)] = makeSub(name, cik, {}, forms);
      for (let i = 1; i <= 5; i++) routes[formDUrl(cik, `${cik.padStart(10, "0")}-24-${String(i).padStart(6, "0")}`)] = formDStripe;
    }
    const { result } = await call({ company_name: "Long" }, routes);
    expect(result.entities).toHaveLength(5);
    expect(result.notes).toContain("lists are shortened to fit the response size");
  });
});

describe("renderSec", () => {
  it("renders a header, notes right after it, then each company", async () => {
    const { result } = await call({ company_name: "Stripe" }, { ...stripeRoutes() }, { maxFetches: 4 });
    const text = renderSec(result);
    const lines = text.split("\n");
    expect(lines[0]).toBe('SEC filings for "Stripe" (partial)');
    expect(lines[1]).toMatch(/^note: /);
    expect(text).toContain("Stripe, Inc.");
    expect(render("sec_filings", result)).toBe(text);
  });

  it("renders the statement and errors", async () => {
    const { result } = await call({ company_name: "Hightouch" }, { [`${SEARCH}Hightouch`]: JSON.stringify(searchEmpty) });
    expect(renderSec(result)).toContain("no filings found under these names: Hightouch");
    const bad = await call({ company_name: "Example", domain: "127.0.0.1" }, {});
    expect(renderSec(bad.result)).toMatch(/^sec_filings failed \(bad_input\)/);
  });
});

describe("sec_filings: subrequests on a cold cache", () => {
  /** Deps as makeDeps builds them (a 45-subrequest counter), over a meter that counts what reaches the network and cache. */
  async function metered(routes: Record<string, Route>) {
    const m = meter(fakeFetch(routes), await caches.open(`sec-${crypto.randomUUID()}`));
    const noArchive = async () => {
      throw new Error("sec_filings must not use the archive");
    };
    return { m, deps: callDeps({ fetch: m.fetch, cache: m.cache, archive: noArchive, now: () => NOW }, 45, "test") };
  }

  it("Stripe takes 42: the search, eight submissions and five Form Ds, each a read, a fetch and a write", async () => {
    const { m, deps } = await metered(stripeRoutes());
    const result = await secFilings({ company_name: "Stripe", domain: "stripe.com" }, deps, { sleep: async () => {} });
    expect(result.status).toBe("ok");
    expect(result.entities?.[0].form_d).toHaveLength(5);
    expect(m.total()).toBe(42);
  });

  it("two names and five companies with Form Ds stop at the limit of 45, and say to call again", async () => {
    const hits = (prefix: string, base: number) => Array.from({ length: 5 }, (_, i) => [String(base + i), `${prefix} ${i}`] as [string, string]);
    const first = hits("Big", 800);
    const second = hits("Bigco", 900);
    const routes: Record<string, Route> = { [`${SEARCH}Big`]: searchBody(first), [`${SEARCH}bigco`]: searchBody(second) };
    for (const [cik, name] of [...first, ...second]) {
      routes[subUrl(cik)] = makeSub(name, cik, {}, ["D", "D", "D", "D", "D"]);
      for (let i = 1; i <= 5; i++) routes[formDUrl(cik, `${cik.padStart(10, "0")}-24-${String(i).padStart(6, "0")}`)] = formDStripe;
    }
    const { m, deps } = await metered(routes);
    const result = await secFilings({ company_name: "Big", domain: "bigco.com" }, deps, { sleep: async () => {} });
    expect(m.total()).toBeLessThanOrEqual(45);
    expect(result.status).toBe("partial");
    expect(result.entities).toHaveLength(5);
    const note = result.notes.find((n) => n.includes("per-request limit of 45 subrequests"));
    expect(note).toMatch(/Form D notices were not read/);
    expect(note).toContain("call again with the same input to continue");
    expect(JSON.stringify(result)).not.toMatch(/HTTP 599|connection failed/);
  });
});
