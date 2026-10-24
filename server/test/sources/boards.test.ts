import { describe, expect, it } from "vitest";
import { CAREERS_MAX_BYTES, ROLE_DESCRIPTION_MAX_CHARS } from "../../src/config";
import { fetchBoard, fetchRoleDetail, slugCandidates } from "../../src/sources/boards";
import { findBoardLink } from "../../src/sources/careers";
import { fakeFetch } from "../helpers/fake-fetch";
import ashby from "../fixtures/boards/ashby-hightouch.json";
import careersAshby from "../fixtures/boards/careers-ashby-link.html?raw";
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
    const key = `https://cache.competitive-analysis.invalid/${encodeURIComponent("boards:v1:lever:palantir")}`;
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
});
