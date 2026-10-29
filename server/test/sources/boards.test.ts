import { describe, expect, it } from "vitest";
import { CAREERS_MAX_BYTES, ROLE_DESCRIPTION_MAX_CHARS } from "../../src/config";
import { fetchBoard, fetchRoleDetail, slugCandidates } from "../../src/sources/boards";
import { findBoardLink } from "../../src/sources/careers";
import { fakeFetch } from "../helpers/fake-fetch";
import ashby from "../fixtures/boards/ashby-hightouch.json";
import careersAshby from "../fixtures/boards/careers-ashby-link.html?raw";
import atDetail from "../fixtures/boards/greenhouse-airtable-job-detail.json";
import ghDepartments from "../fixtures/boards/greenhouse-stripe-departments.json";
import ghDetail from "../fixtures/boards/greenhouse-stripe-job-detail.json";
import ghJobs from "../fixtures/boards/greenhouse-stripe-jobs.json";
import lever from "../fixtures/boards/lever-palantir.json";

const GH_JOBS = "https://boards-api.greenhouse.io/v1/boards/stripe/jobs";
const GH_DEPS = "https://boards-api.greenhouse.io/v1/boards/stripe/departments";
const ASHBY = "https://api.ashbyhq.com/posting-api/job-board/hightouch?includeCompensation=true";
const LEVER = "https://api.lever.co/v0/postings/palantir?mode=json";

const freshCache = () => caches.open(`boards-${crypto.randomUUID()}`);
const json = (v: unknown) => JSON.stringify(v);

describe("Greenhouse", () => {
  const routes = () => ({ [GH_JOBS]: json(ghJobs), [GH_DEPS]: json(ghDepartments) });

  it("lists jobs and departments from the exact URLs", async () => {
    const f = fakeFetch(routes());
    const r = await fetchBoard(f, await freshCache(), "greenhouse", "stripe");
    expect(f.calls).toEqual([GH_JOBS, GH_DEPS]);
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.url).toBe("https://job-boards.greenhouse.io/stripe");
    expect(r.roles).toHaveLength(20);
  });

  it("maps fields: department from the departments map, date, link, pay", async () => {
    const r = await fetchBoard(fakeFetch(routes()), await freshCache(), "greenhouse", "stripe");
    if (r.kind !== "found") throw new Error("expected a board");
    const raw = ghJobs.jobs[0];
    const dep = ghDepartments.departments.find((d) => d.jobs.some((j) => j.id === raw.id));
    expect(r.roles[0]).toEqual({
      id: String(raw.id),
      title: raw.title,
      department: dep?.name,
      location: raw.location.name,
      date: raw.first_published.slice(0, 10),
      dateKind: "posted",
      pay: null,
      link: raw.absolute_url,
    });
  });

  it("falls back to updated_at when first_published is missing", async () => {
    const jobs = { jobs: [{ ...ghJobs.jobs[0], first_published: null, updated_at: "2026-10-22T09:16:14-04:00" }] };
    const r = await fetchBoard(
      fakeFetch({ [GH_JOBS]: json(jobs), [GH_DEPS]: json({ departments: [] }) }),
      await freshCache(),
      "greenhouse",
      "stripe",
    );
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.roles[0]).toMatchObject({ date: "2026-10-22", dateKind: "updated", department: null });
  });

  it("keeps the roles, with a note, when the departments lookup fails", async () => {
    const r = await fetchBoard(fakeFetch({ [GH_JOBS]: json(ghJobs) , [GH_DEPS]: { status: 500 } }), await freshCache(), "greenhouse", "stripe");
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.roles).toHaveLength(20);
    expect(r.roles[0].department).toBeNull();
    expect(r.departmentsError).toEqual({ reason: "source_unavailable", detail: "HTTP 500" });
  });
});

describe("a Greenhouse read that lost its departments", () => {
  it("is never cached, so the next call asks again", async () => {
    const cache = await freshCache();
    const bad = fakeFetch({ [GH_JOBS]: json(ghJobs), [GH_DEPS]: { status: 500 } });
    await fetchBoard(bad, cache, "greenhouse", "stripe");
    const good = fakeFetch({ [GH_JOBS]: json(ghJobs), [GH_DEPS]: json(ghDepartments) });
    const r = await fetchBoard(good, cache, "greenhouse", "stripe");
    expect(good.calls).toEqual([GH_JOBS, GH_DEPS]);
    expect(r.kind === "found" && r.departmentsError).toBeFalsy();
    expect(r.kind === "found" && r.roles[0].department).not.toBeNull();
  });
});

describe("Ashby", () => {
  it("requests the exact URL and maps fields", async () => {
    const f = fakeFetch({ [ASHBY]: json(ashby) });
    const r = await fetchBoard(f, await freshCache(), "ashby", "hightouch");
    expect(f.calls).toEqual([ASHBY]);
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.url).toBe("https://jobs.ashbyhq.com/hightouch");
    const raw = ashby.jobs[0];
    expect(r.roles[0]).toMatchObject({
      id: raw.id,
      title: raw.title,
      department: "Engineering",
      location: "San Francisco",
      date: "2021-03-16",
      dateKind: "posted",
      pay: null,
      link: raw.jobUrl,
    });
  });

  it("counts only listed jobs, falls back to team, and shows pay only when the board displays it", async () => {
    const base = ashby.jobs[0];
    const board = {
      jobs: [
        { ...base, id: "a", isListed: false },
        { ...base, id: "b", department: null, team: "Growth", compensation: { compensationTierSummary: "$100K – $120K" }, shouldDisplayCompensationOnJobPostings: true },
        { ...base, id: "c", compensation: { compensationTierSummary: "$1" }, shouldDisplayCompensationOnJobPostings: false },
      ],
    };
    const r = await fetchBoard(fakeFetch({ [ASHBY]: json(board) }), await freshCache(), "ashby", "hightouch");
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.roles.map((x) => x.id)).toEqual(["b", "c"]);
    expect(r.roles[0]).toMatchObject({ department: "Growth", pay: "$100K – $120K" });
    expect(r.roles[1].pay).toBeNull();
  });
});

describe("Lever", () => {
  it("requests the exact URL and maps fields", async () => {
    const f = fakeFetch({ [LEVER]: json(lever) });
    const r = await fetchBoard(f, await freshCache(), "lever", "palantir");
    expect(f.calls).toEqual([LEVER]);
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.url).toBe("https://jobs.lever.co/palantir");
    const raw = lever[0];
    expect(r.roles).toHaveLength(20);
    expect(r.roles[0]).toMatchObject({
      id: raw.id,
      title: raw.text,
      department: raw.categories.team,
      location: raw.categories.location,
      date: new Date(raw.createdAt).toISOString().slice(0, 10),
      dateKind: "posted",
      pay: null,
      link: raw.hostedUrl,
    });
  });

  it("prefers categories.department and formats salaryRange", async () => {
    const posting = {
      ...lever[0],
      categories: { ...lever[0].categories, department: "Ops" },
      salaryRange: { currency: "USD", interval: "per-year-salary", min: 150000, max: 200000 },
    };
    const r = await fetchBoard(fakeFetch({ [LEVER]: json([posting]) }), await freshCache(), "lever", "palantir");
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.roles[0]).toMatchObject({ department: "Ops", pay: "USD 150,000–200,000 per year" });
  });
});

describe("board absence", () => {
  const cases = [
    ["greenhouse", GH_JOBS, "stripe"],
    ["ashby", ASHBY, "hightouch"],
    ["lever", LEVER, "palantir"],
  ] as const;

  it.each(cases)("a 404 from %s is absent", async (ats, url, slug) => {
    const r = await fetchBoard(fakeFetch({ [url]: { status: 404 } }), await freshCache(), ats, slug);
    expect(r).toEqual({ kind: "absent", url });
  });

  it.each(cases)("a 403 from %s is an error, not absence", async (ats, url, slug) => {
    const r = await fetchBoard(fakeFetch({ [url]: { status: 403 } }), await freshCache(), ats, slug);
    expect(r).toMatchObject({ kind: "error", url, reason: "source_unavailable" });
    expect(r.kind === "error" && r.detail).toContain("403");
  });

  it("a body that is not the expected JSON is an error", async () => {
    const r = await fetchBoard(fakeFetch({ [ASHBY]: "<html>hi</html>" }), await freshCache(), "ashby", "hightouch");
    expect(r.kind).toBe("error");
  });

  it("answers a repeat call from the cache, absence included, but never caches an error", async () => {
    const cache = await freshCache();
    const f = fakeFetch({ [LEVER]: json(lever), [ASHBY]: { status: 404 }, [GH_JOBS]: { status: 403 } });
    await fetchBoard(f, cache, "lever", "palantir");
    await fetchBoard(f, cache, "lever", "palantir");
    await fetchBoard(f, cache, "ashby", "hightouch");
    await fetchBoard(f, cache, "ashby", "hightouch");
    await fetchBoard(f, cache, "greenhouse", "stripe");
    await fetchBoard(f, cache, "greenhouse", "stripe");
    expect(f.calls).toEqual([LEVER, ASHBY, GH_JOBS, GH_JOBS]);
  });
});

describe("board cache keys", () => {
  it("carry the adapter and its version", async () => {
    const cache = await freshCache();
    await fetchBoard(fakeFetch({ [LEVER]: json(lever) }), cache, "lever", "palantir");
    const key = `https://cache.competitive-analysis.invalid/${encodeURIComponent("boards:v2:lever:palantir")}`;
    expect(await cache.match(key)).toBeDefined();
  });
});

describe("fetchRoleDetail", () => {
  const DETAIL = `https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${ghDetail.id}?pay_transparency=true`;

  it("reads a Greenhouse job: escaped HTML becomes plain text, capped", async () => {
    const f = fakeFetch({ [DETAIL]: json(ghDetail) });
    const r = await fetchRoleDetail(f, "greenhouse", "stripe", String(ghDetail.id));
    expect(f.calls).toEqual([DETAIL]);
    if (!r.ok) throw new Error("expected a description");
    expect(r.description).toContain("Who we are");
    expect(r.description).not.toMatch(/[<>]|&lt;|&amp;|&quot;/);
    expect(r.description).not.toMatch(/\s{2}/);
    expect(r.pay).toBeNull();

    const long = { ...ghDetail, content: `&lt;p&gt;${"word &amp; more ".repeat(1000)}&lt;/p&gt;` };
    const capped = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(long) }), "greenhouse", "stripe", String(ghDetail.id));
    expect(capped.ok && capped.description.length).toBe(ROLE_DESCRIPTION_MAX_CHARS);
  });

  it("formats pay_input_ranges", async () => {
    const withPay = { ...ghDetail, pay_input_ranges: [{ min_cents: 18000000, max_cents: 24000000, currency_type: "USD", title: "US", blurb: "" }] };
    const r = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(withPay) }), "greenhouse", "stripe", String(ghDetail.id));
    expect(r.ok && r.pay).toBe("USD 180,000–240,000");
  });

  describe("pay stated only in the posting's text", () => {
    // Airtable leaves Greenhouse's pay field empty and states its ranges near the end of the
    // posting, past the description cap (Run 28, 2026-10-28).
    const AT_DETAIL = `https://boards-api.greenhouse.io/v1/boards/airtable/jobs/${atDetail.id}?pay_transparency=true`;
    const withContent = (text: string) => ({ ...ghDetail, content: `&lt;p&gt;${text}&lt;/p&gt;` });

    it("keeps the pay sentences when the pay field is empty, though the cap cuts them from the description", async () => {
      const r = await fetchRoleDetail(fakeFetch({ [AT_DETAIL]: json(atDetail) }), "greenhouse", "airtable", String(atDetail.id));
      if (!r.ok) throw new Error("expected a description");
      expect(r.pay).toBeNull();
      expect(r.description).toHaveLength(ROLE_DESCRIPTION_MAX_CHARS);
      expect(r.description).not.toContain("$272,000");
      expect(r.payText).toBe(
        "For work locations in the San Francisco Bay Area, Seattle, Los Angeles, and New York, the on-target earnings range for this role is $272,000 - $354,000 USD. " +
          "For all other work locations (including remote), the range is $245,000 – $319,000 USD.",
      );
    });

    it("ignores a figure with no pay word, such as a book of business", async () => {
      const r = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(withContent("You will own a $2M book of business. Salary is competitive.")) }), "greenhouse", "stripe", String(ghDetail.id));
      expect(r.ok && r.payText).toBeUndefined();
    });

    it("isn't given when the pay field has the range", async () => {
      const both = { ...withContent("The base salary range for this role is $180,000 to $240,000."), pay_input_ranges: [{ min_cents: 18000000, max_cents: 24000000, currency_type: "USD", title: "US", blurb: "" }] };
      const r = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(both) }), "greenhouse", "stripe", String(ghDetail.id));
      expect(r.ok && r.pay).toBe("USD 180,000–240,000");
      expect(r.ok && r.payText).toBeUndefined();
    });

    it("keeps the words around the figure when list items run together with no full stop", async () => {
      const text = `Benefits ${"generous perks and ".repeat(40)}Salary: $100,000 - $120,000 per year ${"plus more perks and ".repeat(40)}`;
      const r = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(withContent(text)) }), "greenhouse", "stripe", String(ghDetail.id));
      if (!r.ok || !r.payText) throw new Error("expected pay text");
      expect(r.payText).toContain("Salary: $100,000 - $120,000 per year");
      expect(r.payText.length).toBeLessThanOrEqual(300);
    });

    // From R73's fresh review (2026-10-28).
    const payOf = async (text: string) => {
      const r = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(withContent(text)) }), "greenhouse", "stripe", String(ghDetail.id));
      if (!r.ok) throw new Error("expected a description");
      return r.payText;
    };
    const perks = "Perks and benefits " + "comprehensive medical dental and vision coverage for you and your family ".repeat(4);

    it("doesn't take a stipend in a run-on list for the pay that follows it", async () => {
      const text = `${perks}home office stipend of $1,000 a $2,000 annual learning budget wellness allowance of $50 a month Compensation The base salary range for this role is $150,000 - $180,000 USD.`;
      const pay = await payOf(text);
      expect(pay).toContain("$150,000 - $180,000 USD");
      expect(pay).not.toMatch(/\$1,000|\$2,000|\$50\b/);
    });

    it("keeps every zone of a zone list whole", async () => {
      const zones =
        "Zone A (San Francisco Bay Area, New York City metro, Seattle metro): $175,000 - $219,000 " +
        "Zone B (Boston, Los Angeles, Washington D.C. metro, San Diego): $166,000 - $208,000 " +
        "Zone C (Austin, Chicago, Denver, Portland, Philadelphia, Miami): $157,000 - $196,000 " +
        "Zone D (all other US locations, including remote employees): $149,000 - $186,000";
      const pay = await payOf(`${perks}The salary range for this role is: ${zones} ${perks}`);
      for (const r of ["$175,000 - $219,000", "$166,000 - $208,000", "$157,000 - $196,000", "$149,000 - $186,000"]) expect(pay).toContain(r);
    });

    it("never cuts a figure in two", async () => {
      const tiers = Array.from({ length: 30 }, (_, i) => `Tier ${i + 1}: $${100 + i},000 - $${150 + i},000`).join(" ");
      const pay = await payOf(`${perks}The salary range for this role is ${tiers} ${perks}`);
      expect(pay).toContain("Tier 1: $100,000 - $150,000");
      for (const figure of pay!.match(/\$[\d,]+/g)!) expect(figure).toMatch(/^\$\d{3},000$/);
    });

    it("ignores stipends, budgets and quotas, even beside a pay word", async () => {
      expect(await payOf("You'll get a $1,500 learning stipend and a wide range of benefits.")).toBeUndefined();
      expect(await payOf("We offer a $500 stipend to pay for your home office setup.")).toBeUndefined();
      expect(await payOf("You'll carry a $2M quota on top of base pay.")).toBeUndefined();
    });

    it("keeps at most four sentences, in the posting's order", async () => {
      const cities = ["New York", "Seattle", "Austin", "Denver", "Chicago"];
      const pay = await payOf(cities.map((c, i) => `The base salary range in ${c} is $${200 - i * 10},000 - $${240 - i * 10},000.`).join(" "));
      expect(pay).toBe(cities.slice(0, 4).map((c, i) => `The base salary range in ${c} is $${200 - i * 10},000 - $${240 - i * 10},000.`).join(" "));
    });

    it("removes email addresses and phone numbers from the pay it keeps", async () => {
      const pay = await payOf("The salary range is $100,000 - $120,000, and questions go to jobs@example.com or 415-555-0100.");
      expect(pay).toContain("$100,000 - $120,000");
      expect(pay).toContain("[email removed]");
      expect(pay).toContain("[phone removed]");
    });

    it("reads euros, pounds and a currency written after the figure", async () => {
      expect(await payOf("The salary range for this role is €60,000 – €75,000.")).toContain("€60,000 – €75,000");
      expect(await payOf("Salary: GBP 50,000 to GBP 60,000 per year.")).toContain("GBP 50,000 to GBP 60,000");
      expect(await payOf("The annual salary is 65.000 € to 80.000 € depending on experience.")).toContain("65.000 € to 80.000 €");
    });

    it("reads an hourly rate and a starting base", async () => {
      expect(await payOf("The hourly rate for this role ranges from $25.00 to $35.00.")).toContain("$25.00 to $35.00");
      expect(await payOf("The starting base for this role is $140,000.")).toContain("$140,000");
    });

    it("reads a long run of text with no spaces in under 200 ms", async () => {
      const start = performance.now();
      await payOf(`${"a".repeat(160_000)} The salary range is $100,000 - $120,000.`);
      expect(performance.now() - start).toBeLessThan(200);
    });
  });

  describe("pay stated only in the text, on Ashby and Lever", () => {
    it("Lever: a role with no salaryRange gets the pay its text states", async () => {
      const r = await fetchBoard(fakeFetch({ [LEVER]: json(lever) }), await freshCache(), "lever", "palantir");
      if (r.kind !== "found") throw new Error("expected a board");
      const role = r.roles.find((x) => x.id === "a237973c-cb29-41fe-9c80-416e6f42e087")!;
      expect(role.pay).toBeNull();
      const d = await fetchRoleDetail(fakeFetch({}), "lever", "palantir", role.id, role);
      expect(d.ok && d.payText).toContain("$60,000 - $97,000/year");
    });

    it("Ashby: pay past the description cap, with compensation hidden, still reaches payText", async () => {
      const job = { ...ashby.jobs[0], shouldDisplayCompensationOnJobPostings: false, descriptionPlain: `${"About the role and the team. ".repeat(120)}The base salary range for this role is $150,000 - $180,000.` };
      const r = await fetchBoard(fakeFetch({ [ASHBY]: json({ jobs: [job] }) }), await freshCache(), "ashby", "hightouch");
      if (r.kind !== "found") throw new Error("expected a board");
      expect(r.roles[0].description).not.toContain("$150,000");
      const d = await fetchRoleDetail(fakeFetch({}), "ashby", "hightouch", r.roles[0].id, r.roles[0]);
      expect(d.ok && d.payText).toContain("$150,000 - $180,000");
    });
  });

  it("removes email addresses and phone numbers from descriptions, in every ATS", async () => {
    const text = "Write to jane.doe+jobs@example.com or call (555) 123-4567, +44 20 7946 0958 or 415-555-0100. Posted 2026-10-24, pay 150,000-200,000.";
    const gh = { ...ghDetail, content: `&lt;p&gt;${text}&lt;/p&gt;` };
    const g = await fetchRoleDetail(fakeFetch({ [DETAIL]: json(gh) }), "greenhouse", "stripe", String(ghDetail.id));
    const want = "Write to [email removed] or call [phone removed], [phone removed] or [phone removed]. Posted 2026-10-24, pay 150,000-200,000.";
    expect(g.ok && g.description).toBe(want);
    const a = await fetchBoard(fakeFetch({ [ASHBY]: json({ jobs: [{ ...ashby.jobs[0], descriptionPlain: text }] }) }), await freshCache(), "ashby", "hightouch");
    expect(a.kind === "found" && a.roles[0].description).toBe(want);
    const l = await fetchBoard(fakeFetch({ [LEVER]: json([{ ...lever[0], descriptionPlain: text }]) }), await freshCache(), "lever", "palantir");
    expect(l.kind === "found" && l.roles[0].description).toContain(want);
  });

  it("passes a failure through", async () => {
    const r = await fetchRoleDetail(fakeFetch({ [DETAIL]: { status: 404 } }), "greenhouse", "stripe", String(ghDetail.id));
    expect(r).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("uses the listed description for Ashby and Lever without fetching", async () => {
    const f = fakeFetch({});
    const listed = { id: "x", title: "T", department: null, location: null, date: null, dateKind: "posted" as const, pay: "USD 1–2", link: "l", description: "Plain text." };
    expect(await fetchRoleDetail(f, "ashby", "hightouch", "x", listed)).toEqual({ ok: true, description: "Plain text.", pay: "USD 1–2" });
    expect(f.calls).toEqual([]);
    expect(await fetchRoleDetail(f, "lever", "palantir", "x")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("Ashby and Lever listings carry capped plain-text descriptions", async () => {
    const r = await fetchBoard(fakeFetch({ [LEVER]: json(lever) }), await freshCache(), "lever", "palantir");
    if (r.kind !== "found") throw new Error("expected a board");
    expect(r.roles[0].description?.length).toBeGreaterThan(0);
    expect(r.roles[0].description?.length).toBeLessThanOrEqual(ROLE_DESCRIPTION_MAX_CHARS);
  });
});

describe("slugCandidates", () => {
  it.each([
    [["zeroclick.ai", "ZeroClick"], ["zeroclick"]],
    [["hightouch.com", "Hightouch"], ["hightouch"]],
    [["acme.io", "Acme Labs, Inc."], ["acmelabs", "acme", "acme-labs"]],
    [["www.zero-click.com"], ["zero-click"]],
    [["acme.co.uk"], ["acme"]],
  ] as const)("%j", ([domain, name], expected) => {
    expect(slugCandidates(domain, name)).toEqual(expected);
  });
});

describe("findBoardLink", () => {
  const PAGES = ["careers", "jobs", "company/careers", "about/careers"].map((p) => `https://acme.io/${p}`);

  it("tries the four careers paths in order, then gives up", async () => {
    const f = fakeFetch({});
    expect(await findBoardLink(f, "acme.io")).toEqual({ found: null, tried: PAGES, failures: [] });
    expect(f.calls).toEqual(PAGES);
  });

  it("reads an Ashby link from the page and stops there", async () => {
    const f = fakeFetch({ [PAGES[1]]: careersAshby });
    expect(await findBoardLink(f, "acme.io")).toEqual({
      found: { ats: "ashby", slug: "acme-labs" },
      tried: PAGES.slice(0, 2),
      failures: [],
    });
  });

  it("asks for at most CAREERS_MAX_BYTES", async () => {
    const big = `<a href="https://jobs.lever.co/acme">x</a>${" ".repeat(CAREERS_MAX_BYTES + 5000)}`;
    // Past the cap the page is cut, but a link before the cut is still read.
    const r = await findBoardLink(fakeFetch({ [PAGES[0]]: big }), "acme.io");
    expect(r.found).toEqual({ ats: "lever", slug: "acme" });
    const late = `${" ".repeat(CAREERS_MAX_BYTES + 5000)}<a href="https://jobs.lever.co/late">x</a>`;
    expect((await findBoardLink(fakeFetch({ [PAGES[0]]: late }), "acme.io")).found).toBeNull();
  });

  it("ignores a page that redirects off the company's domain", async () => {
    const f = fakeFetch({
      [PAGES[0]]: { status: 302, headers: { location: "https://other.example/careers" } },
      "https://other.example/careers": careersAshby,
    });
    const r = await findBoardLink(f, "acme.io");
    expect(r.found).toBeNull();
    expect(r.tried).toEqual(PAGES);
  });

  it("treats a redirect that ends on a known board page as a link to that board", async () => {
    const f = fakeFetch({
      [PAGES[0]]: { status: 302, headers: { location: "https://jobs.lever.co/acme-inc" } },
      "https://jobs.lever.co/acme-inc": "<html>no links here</html>",
    });
    expect(await findBoardLink(f, "acme.io")).toEqual({ found: { ats: "lever", slug: "acme-inc" }, tried: [PAGES[0]], failures: [] });
  });

  it("ignores a look-alike host", async () => {
    const f = fakeFetch({
      [PAGES[0]]: { status: 302, headers: { location: "https://evilacme.io/careers" } },
      "https://evilacme.io/careers": careersAshby,
    });
    expect((await findBoardLink(f, "acme.io")).found).toBeNull();
  });

  it("accepts a redirect to a subdomain of the company", async () => {
    const f = fakeFetch({
      [PAGES[0]]: { status: 301, headers: { location: "https://www.acme.io/careers" } },
      "https://www.acme.io/careers": careersAshby,
    });
    expect((await findBoardLink(f, "acme.io")).found).toEqual({ ats: "ashby", slug: "acme-labs" });
  });

  it.each([
    ['<a href="https://boards.greenhouse.io/acme">', { ats: "greenhouse", slug: "acme" }],
    ['<a href="https://job-boards.greenhouse.io/acme">', { ats: "greenhouse", slug: "acme" }],
    ['<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>', { ats: "greenhouse", slug: "acme" }],
    ['<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>', { ats: "greenhouse", slug: "acme" }],
    ['<a href="https://jobs.lever.co/acme-co">', { ats: "lever", slug: "acme-co" }],
    ['<a href="https://job-boards.eu.greenhouse.io/acme">', { ats: "greenhouse", slug: "acme", region: "eu" }],
    ['<a href="https://boards.eu.greenhouse.io/acme">', { ats: "greenhouse", slug: "acme", region: "eu" }],
    ['<iframe src="https://boards.eu.greenhouse.io/embed/job_board?for=acme"></iframe>', { ats: "greenhouse", slug: "acme", region: "eu" }],
    ['<a href="https://jobs.eu.lever.co/acme-co">', { ats: "lever", slug: "acme-co", region: "eu" }],
    ['<iframe src="https://boards.greenhouse.io/embed/job_board?x=a.eu.b&for=acme"></iframe>', { ats: "greenhouse", slug: "acme" }],
  ])("recognizes %s", async (html, expected) => {
    expect((await findBoardLink(fakeFetch({ [PAGES[0]]: html }), "acme.io")).found).toEqual(expected);
  });

  it("reads a crafted 512 KB careers page in under 100 ms", async () => {
    const junk = `boards.greenhouse.io/embed/job_board?${"a&".repeat(200)}`;
    const link = '<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>';
    const page = junk.repeat(Math.floor((CAREERS_MAX_BYTES - link.length) / junk.length)) + link;
    expect(page.length).toBeGreaterThan(500_000);
    const start = performance.now();
    const r = await findBoardLink(fakeFetch({ [PAGES[0]]: page }), "acme.io");
    expect(performance.now() - start).toBeLessThan(100);
    expect(r.found).toEqual({ ats: "greenhouse", slug: "acme" });
  });

  it("reports a refused careers page as a failure, not absence", async () => {
    const r = await findBoardLink(fakeFetch({ [PAGES[0]]: { status: 403 } }), "acme.io");
    expect(r.found).toBeNull();
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ url: PAGES[0], reason: "source_unavailable", status: 403 });
    expect(r.failures[0].detail).toContain("403");
  });

  describe("role pages", () => {
    const id = "24dba985-1d50-4853-a33d-47ef56552735";
    const role = `https://acme.io/careers/${id}`;
    // Hightouch's careers page lists its roles on its own site and names no board; each role page's apply link does.
    const listing = `<h1>88 open positions</h1><a class="group" href="/careers/${id}">Account Executive</a>`;
    const apply = `<script>{"applyLink":"https://jobs.ashbyhq.com/acme-inc/${id}"}</script>`;

    it("reads one role page a careers page links to, when the page names no board", async () => {
      const f = fakeFetch({ [PAGES[0]]: listing, [role]: apply });
      expect(await findBoardLink(f, "acme.io")).toEqual({ found: { ats: "ashby", slug: "acme-inc" }, tried: [PAGES[0], role], failures: [] });
      expect(f.calls).toEqual([PAGES[0], role]);
    });

    it.each([
      ["a numeric id", "/careers/4567890", "https://acme.io/careers/4567890"],
      ["an id after the title", "/careers/senior-engineer-4567890", "https://acme.io/careers/senior-engineer-4567890"],
      ["an absolute link on a subdomain", `https://www.acme.io/careers/${id}`, `https://www.acme.io/careers/${id}`],
    ])("takes %s as a role page", async (_kind, href, url) => {
      const f = fakeFetch({ [PAGES[0]]: `<a href="${href}">Engineer</a>`, [url]: '<a href="https://jobs.lever.co/acme-co/x">Apply</a>' });
      expect((await findBoardLink(f, "acme.io")).found).toEqual({ ats: "lever", slug: "acme-co" });
    });

    it("follows only a role page on the company's site, under the careers page", async () => {
      const html = [
        '<a href="/blog/launch-1234567">Blog</a>',
        `<a href="https://other.example/careers/${id}">Elsewhere</a>`,
        `<a href="https://acme.io.evil.example/careers/${id}">Look-alike</a>`,
        '<a href="/careers/benefits">Benefits</a>',
        `<a href="javascript:void(0)/careers/${id}">Script</a>`,
        `<a href="http://acme.io/careers/${id}">Plain HTTP</a>`,
        `<a href="https://acme.io:8443/careers/${id}">Other port</a>`,
      ].join("");
      const f = fakeFetch({ [PAGES[0]]: html });
      expect(await findBoardLink(f, "acme.io")).toEqual({ found: null, tried: PAGES, failures: [] });
    });

    it("reads one role page at most", async () => {
      const f = fakeFetch({ [PAGES[0]]: '<a href="/careers/1111111">A</a>', [PAGES[1]]: '<a href="/jobs/2222222">B</a>' });
      const r = await findBoardLink(f, "acme.io");
      expect(r.found).toBeNull();
      expect(f.calls).toEqual([PAGES[0], "https://acme.io/careers/1111111", ...PAGES.slice(1)]);
      expect(r.tried).toEqual(f.calls);
    });

    it("reports a refused role page as a failure, not absence", async () => {
      const r = await findBoardLink(fakeFetch({ [PAGES[0]]: listing, [role]: { status: 403 } }), "acme.io");
      expect(r.found).toBeNull();
      expect(r.failures).toEqual([expect.objectContaining({ url: role, status: 403 })]);
    });

    it("ignores a role page that redirects off the company's domain", async () => {
      const f = fakeFetch({
        [PAGES[0]]: listing,
        [role]: { status: 302, headers: { location: "https://other.example/job" } },
        "https://other.example/job": apply,
      });
      expect((await findBoardLink(f, "acme.io")).found).toBeNull();
    });

    it("reads a crafted 512 KB page of role-like links in under 100 ms", async () => {
      const junk = `<a href="https://other.example/careers/${id}">x</a>`;
      const page = junk.repeat(Math.floor(CAREERS_MAX_BYTES / junk.length));
      expect(page.length).toBeGreaterThan(500_000);
      const start = performance.now();
      const r = await findBoardLink(fakeFetch({ [PAGES[0]]: page }), "acme.io");
      expect(performance.now() - start).toBeLessThan(100);
      expect(r.found).toBeNull();
    });
  });
});
