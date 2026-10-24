import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_ROLES, RESPONSE_CAP_CHARS, ROLE_DESCRIPTION_MAX_CHARS } from "../../src/config";
import { FALLBACK_LINE } from "../../src/contract/envelope";
import { jobOpeningsOutput, type JobOpeningsInput, type JobOpeningsResult } from "../../src/contract/tools";
import { callDeps, render, type ToolDeps } from "../../src/tools";
import { jobOpenings, renderJobOpenings } from "../../src/tools/job-openings";
import { Subrequests } from "../../src/shared/subrequests";
import { fakeFetch, hangingOn, type FakeFetch, type Route } from "../helpers/fake-fetch";
import { meter } from "../helpers/meter";
import careersAshby from "../fixtures/boards/careers-ashby-link.html?raw";
import ghDepartments from "../fixtures/boards/greenhouse-stripe-departments.json";
import ghDetail from "../fixtures/boards/greenhouse-stripe-job-detail.json";
import ghJobs from "../fixtures/boards/greenhouse-stripe-jobs.json";

const NOW = Date.UTC(2026, 9, 20, 12); // 2026-10-20

const gh = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const ghDeps = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/departments`;
const ashbyApi = (slug: string) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
const leverApi = (slug: string) => `https://api.lever.co/v0/postings/${slug}?mode=json`;
const careers = (domain: string) => ["careers", "jobs", "company/careers", "about/careers"].map((p) => `https://${domain}/${p}`);

/** An Ashby board of `n` listed jobs, job i posted i days after 2026-01-01. */
function ashbyBoard(n: number, opts: { description?: string } = {}) {
  return {
    jobs: Array.from({ length: n }, (_, i) => ({
      id: `role-${i}`,
      title: `Engineer ${i}`,
      department: `Dept ${i % 3}`,
      team: null,
      location: i % 2 ? "Remote" : null,
      publishedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      isListed: true,
      shouldDisplayCompensationOnJobPostings: false,
      jobUrl: `https://jobs.ashbyhq.com/acme/role-${i}`,
      descriptionPlain: opts.description ?? `About role ${i}.`,
    })),
  };
}

function depsFor(fetch: FakeFetch, opts: { now?: () => number; cache?: Cache } = {}): Promise<ToolDeps> {
  return (async () => ({
    fetch,
    archive: async () => {
      throw new Error("job_openings must not use the archive");
    },
    // A fresh cache per test, so no test reads another's boards.
    cache: opts.cache ?? (await caches.open(`jobs-${crypto.randomUUID()}`)),
    now: opts.now ?? (() => NOW),
    subrequests: new Subrequests(45),
  }))();
}

const schema = z.object(jobOpeningsOutput);

/** Runs the tool and checks the result against the published output schema. */
async function call(
  input: JobOpeningsInput,
  routes: Record<string, Route>,
  opts: { now?: () => number; cache?: Cache; maxFetches?: number; deadlineMs?: number } = {},
): Promise<{ result: JobOpeningsResult; fetch: FakeFetch }> {
  const fetch = fakeFetch(routes);
  const { maxFetches, deadlineMs, ...rest } = opts;
  const result = await jobOpenings(input, await depsFor(fetch, rest), { maxFetches, deadlineMs });
  expect(schema.safeParse(result).error).toBeUndefined();
  return { result, fetch };
}

describe("job_openings: finding the board", () => {
  it("tries Greenhouse, then Ashby, then Lever, per slug, and stops at the first board", async () => {
    const { result, fetch } = await call(
      { domain: "acme.io", company_name: "Acme Labs, Inc." },
      { [leverApi("acme")]: JSON.stringify([{ id: "l1", text: "Designer", hostedUrl: "https://jobs.lever.co/acme/l1", createdAt: NOW, categories: {} }]) },
    );
    expect(fetch.calls).toEqual([
      gh("acmelabs"), ashbyApi("acmelabs"), leverApi("acmelabs"),
      gh("acme"), ashbyApi("acme"), leverApi("acme"),
    ]);
    expect(result.status).toBe("ok");
    expect(result.board).toEqual({ ats: "lever", slug: "acme", url: "https://jobs.lever.co/acme" });
    expect(result.no_public_board_found).toBe(false);
    expect(result.tried).toEqual(fetch.calls);
  });

  it("reports the Greenhouse board's public address", async () => {
    const { result } = await call(
      { domain: "stripe.com" },
      { [gh("stripe")]: JSON.stringify(ghJobs), [ghDeps("stripe")]: JSON.stringify(ghDepartments) },
    );
    expect(result.board).toEqual({ ats: "greenhouse", slug: "stripe", url: "https://job-boards.greenhouse.io/stripe" });
    expect(result.counts?.total).toBe(20);
    expect(result.counts?.by_department.length).toBeGreaterThan(1);
  });

  it("reports no public board found with everything tried", async () => {
    const { result, fetch } = await call({ domain: "acme.io" }, {});
    expect(result.status).toBe("ok");
    expect(result.no_public_board_found).toBe(true);
    expect(result.board).toBeNull();
    expect(result.tried).toEqual([gh("acme"), ashbyApi("acme"), leverApi("acme"), ...careers("acme.io")]);
    expect(fetch.calls).toEqual(result.tried);
    expect(result.roles).toBeUndefined();
  });

  it("a refused board is not absence", async () => {
    const { result } = await call({ domain: "acme.io" }, { [ashbyApi("acme")]: { status: 403 } });
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    expect(result.board).toBeNull();
    const note = result.notes.find((n) => n.includes("ashby") && n.includes("403"));
    expect(note).toBeDefined();
  });

  it("a refused careers page is not absence either", async () => {
    const { result } = await call({ domain: "acme.io" }, { [careers("acme.io")[1]]: { status: 403 } });
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    expect(result.notes.join(" ")).toContain("403");
  });

  it("when nothing could be checked, it is an error", async () => {
    const routes: Record<string, Route> = Object.fromEntries(
      [gh("acme"), ashbyApi("acme"), leverApi("acme"), ...careers("acme.io")].map((u) => [u, { status: 503 }]),
    );
    const { result } = await call({ domain: "acme.io" }, routes);
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ reason: "source_unavailable", fallback: FALLBACK_LINE });
    expect(result.error?.tried).toHaveLength(7);
  });

  it("finds the board through the careers page", async () => {
    const { result, fetch } = await call(
      { domain: "acme.io" },
      { [careers("acme.io")[1]]: careersAshby, [ashbyApi("acme-labs")]: JSON.stringify(ashbyBoard(3)) },
    );
    expect(result.status).toBe("ok");
    expect(result.board).toEqual({ ats: "ashby", slug: "acme-labs", url: "https://jobs.ashbyhq.com/acme-labs" });
    expect(result.tried).toEqual([gh("acme"), ashbyApi("acme"), leverApi("acme"), ...careers("acme.io").slice(0, 2), ashbyApi("acme-labs")]);
    expect(fetch.calls).toEqual(result.tried);
  });

  it("company names with suffixes find the board", async () => {
    const { result } = await call(
      { domain: "acme.io", company_name: "Acme Labs, Inc." },
      { [ashbyApi("acmelabs")]: JSON.stringify(ashbyBoard(2)) },
    );
    expect(result.board).toMatchObject({ ats: "ashby", slug: "acmelabs" });
  });

  it("an IP literal domain is bad_input, with no fetch", async () => {
    const { result, fetch } = await call({ domain: "127.0.0.1" }, {});
    expect(result.status).toBe("error");
    expect(result.error?.reason).toBe("bad_input");
    expect(fetch.calls).toEqual([]);
  });

  it("a name that gives no usable board name falls back to the domain", async () => {
    const { fetch } = await call({ domain: "acme.io", company_name: "日本" }, {});
    expect(fetch.calls[0]).toBe(gh("acme"));
  });
});

describe("job_openings: degraded and refused reads", () => {
  const stripe = () => ({ [gh("stripe")]: JSON.stringify(ghJobs), [ghDeps("stripe")]: JSON.stringify(ghDepartments) });
  const ids = ghJobs.jobs.slice(0, 5).map((j) => String(j.id));

  it("a failed departments lookup is partial, with a note, and is not cached", async () => {
    const cache = await caches.open(`jobs-${crypto.randomUUID()}`);
    const first = await call({ domain: "stripe.com" }, { ...stripe(), [ghDeps("stripe")]: { status: 500 } }, { cache });
    expect(first.result.status).toBe("partial");
    expect(first.result.notes.join(" ")).toMatch(/departments lookup failed.*500/);
    expect(first.result.counts?.by_department).toEqual([{ name: "Unspecified", count: 20 }]);
    const second = await call({ domain: "stripe.com" }, stripe(), { cache });
    expect(second.fetch.calls).toEqual([gh("stripe"), ghDeps("stripe")]);
    expect(second.result.status).toBe("ok");
  });

  it("a budget refusal partway through a board gives partial with the stop note, never a fake status", async () => {
    const cache = await caches.open(`jobs-${crypto.randomUUID()}`);
    const { result } = await call({ domain: "stripe.com" }, stripe(), { cache, maxFetches: 1 });
    expect(result.status).toBe("partial");
    expect(result.board?.slug).toBe("stripe");
    expect(result.notes.join(" ")).toContain("fetch budget of 1");
    expect(JSON.stringify(result)).not.toContain("599");
    expect(result.notes.join(" ")).not.toContain("departments lookup failed");
    const again = await call({ domain: "stripe.com" }, stripe(), { cache });
    expect(again.fetch.calls).toEqual([gh("stripe"), ghDeps("stripe")]);
    expect(again.result.status).toBe("ok");
  });

  it("valid JSON of the wrong shape is partial, never absence", async () => {
    const { result } = await call({ domain: "acme.io" }, { [ashbyApi("acme")]: '{"unexpected":true}' });
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    expect(result.notes.join(" ")).toMatch(/ashby.*unexpected response shape/);
  });

  it("the stop note appears once when the budget runs out during role details", async () => {
    const { result } = await call({ domain: "stripe.com", role_ids: ids }, stripe(), { maxFetches: 2 });
    expect(result.status).toBe("partial");
    expect(result.roles).toHaveLength(5);
    expect(result.notes.filter((n) => n.includes("fetch budget"))).toHaveLength(1);
    expect(result.notes.filter((n) => n.includes("description not fetched"))).toHaveLength(5);
  });
});

describe("job_openings: tried", () => {
  it("lists departments, detail and careers requests in order, and cached boards", async () => {
    const id = String(ghDetail.id);
    const detail = `https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${id}?pay_transparency=true`;
    const routes = { [gh("stripe")]: JSON.stringify(ghJobs), [ghDeps("stripe")]: JSON.stringify(ghDepartments), [detail]: JSON.stringify(ghDetail) };
    const cache = await caches.open(`jobs-${crypto.randomUUID()}`);
    const first = await call({ domain: "stripe.com", role_ids: [id] }, routes, { cache });
    expect(first.result.tried).toEqual([gh("stripe"), ghDeps("stripe"), detail]);
    const second = await call({ domain: "stripe.com" }, routes, { cache });
    expect(second.fetch.calls).toEqual([]);
    expect(second.result.tried).toEqual([gh("stripe")]);
  });

  it("a careers path that redirects to a board page finds that board", async () => {
    const { result } = await call(
      { domain: "acme.io" },
      {
        [careers("acme.io")[0]]: { status: 302, headers: { location: "https://jobs.lever.co/acme-inc" } },
        "https://jobs.lever.co/acme-inc": "<html></html>",
        [leverApi("acme-inc")]: JSON.stringify([{ id: "l1", text: "Designer", hostedUrl: "https://jobs.lever.co/acme-inc/l1", createdAt: NOW, categories: {} }]),
      },
    );
    expect(result.board).toEqual({ ats: "lever", slug: "acme-inc", url: "https://jobs.lever.co/acme-inc" });
  });
});

describe("job_openings: budget", () => {
  it("returns what is done as partial when the fetch budget runs out", async () => {
    const { result, fetch } = await call({ domain: "acme.io", company_name: "Acme Labs, Inc." }, {}, { maxFetches: 2 });
    expect(fetch.calls).toHaveLength(2);
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    expect(result.notes.join(" ")).toMatch(/fetch budget of 2/);
  });

  it("returns partial when the time limit passes", async () => {
    let t = NOW;
    const { result } = await call({ domain: "acme.io" }, {}, { now: () => (t += 10), deadlineMs: 15 });
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    expect(result.notes.join(" ")).toMatch(/time limit/);
  });
});

describe("job_openings: hard deadline", () => {
  it("cuts a board read still running at the hard deadline: partial, and never absence", async () => {
    const fetch = hangingOn(fakeFetch({}), ashbyApi("acme"));
    const result = await jobOpenings({ domain: "acme.io" }, await depsFor(fetch), { hardDeadlineMs: 50 });
    expect(schema.safeParse(result).error).toBeUndefined();
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    expect(result.notes.join(" ")).toMatch(/time limit of \d+ s reached/);
    expect(result.notes.join(" ")).not.toMatch(/connection failed|could not be checked/);
    expect(fetch.calls).toEqual([gh("acme"), ashbyApi("acme")]);
  });
});

describe("job_openings: roles", () => {
  const routes60 = () => ({ [ashbyApi("acme")]: JSON.stringify(ashbyBoard(60)) });

  it("counts cover every role and the list is capped, newest first", async () => {
    const { result } = await call({ domain: "acme.io" }, routes60());
    expect(result.counts?.total).toBe(60);
    expect(result.counts?.by_department).toEqual([
      { name: "Dept 0", count: 20 },
      { name: "Dept 1", count: 20 },
      { name: "Dept 2", count: 20 },
    ]);
    expect(result.counts?.by_location).toEqual([
      { name: "Remote", count: 30 },
      { name: "Unspecified", count: 30 },
    ]);
    expect(result.roles).toHaveLength(MAX_ROLES);
    const dates = result.roles!.map((r) => r.date!);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(result.roles![0].id).toBe("role-59");
    expect(result.roles![0]).not.toHaveProperty("description");
    expect(result.notes.join(" ")).toContain("40 of 60");
  });

  it("role_ids returns only those roles, with descriptions", async () => {
    const { result } = await call({ domain: "acme.io", role_ids: ["role-3", "role-9", "nope"] }, routes60());
    expect(result.roles?.map((r) => r.id)).toEqual(["role-9", "role-3"]);
    expect(result.roles?.map((r) => r.description)).toEqual(["About role 9.", "About role 3."]);
    expect(result.counts?.total).toBe(60);
    expect(result.notes.join(" ")).toContain("nope");
    expect(result.status).toBe("ok");
  });

  it("role_ids on a Greenhouse board fetches each description", async () => {
    const id = String(ghDetail.id);
    const detail = `https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${id}?pay_transparency=true`;
    const { result, fetch } = await call(
      { domain: "stripe.com", role_ids: [id] },
      { [gh("stripe")]: JSON.stringify(ghJobs), [ghDeps("stripe")]: JSON.stringify(ghDepartments), [detail]: JSON.stringify(ghDetail) },
    );
    expect(fetch.calls).toContain(detail);
    expect(result.roles).toHaveLength(1);
    expect(result.roles![0].description).toContain("Who we are");
    expect(result.status).toBe("ok");
  });

  it("a description that can't be fetched leaves a note and the role without it", async () => {
    const id = String(ghDetail.id);
    const { result } = await call(
      { domain: "stripe.com", role_ids: [id] },
      { [gh("stripe")]: JSON.stringify(ghJobs), [ghDeps("stripe")]: JSON.stringify(ghDepartments), [`https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${id}?pay_transparency=true`]: { status: 403 } },
    );
    expect(result.status).toBe("partial");
    expect(result.roles).toHaveLength(1);
    expect(result.roles![0]).not.toHaveProperty("description");
    expect(result.notes.join(" ")).toContain("403");
  });

  it("uses only the first five role_ids", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `role-${i}`);
    const { result } = await call({ domain: "acme.io", role_ids: ids }, routes60());
    expect(result.roles).toHaveLength(5);
    expect(result.notes.join(" ")).toContain("first 5");
  });

  it("answers a repeat call from the cache", async () => {
    const fetch = fakeFetch(routes60());
    const cache = await caches.open(`jobs-${crypto.randomUUID()}`);
    const deps = await depsFor(fetch, { cache });
    await jobOpenings({ domain: "acme.io" }, deps);
    await jobOpenings({ domain: "acme.io" }, deps);
    expect(fetch.calls.filter((u) => u === ashbyApi("acme"))).toHaveLength(1);
  });
});

describe("job_openings: size", () => {
  it("five 5,000-character role ids keep the result under the cap", async () => {
    const ids = [0, 1, 2, 3, 4].map((i) => String(i).repeat(5000));
    const { result } = await call({ domain: "acme.io", role_ids: ids }, { [ashbyApi("acme")]: JSON.stringify(ashbyBoard(60)) });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_CAP_CHARS);
    expect(result.notes.join(" ")).toContain("not on the board");
  });

  const long = (n: number) => "x".repeat(n);
  const fat = (n: number, description: string) => {
    const board = ashbyBoard(n, { description });
    board.jobs.forEach((j, i) => {
      j.title = `${long(150)} ${i}`;
      j.department = `${long(90)} ${i}`;
      j.location = `${long(90)} ${i}`;
    });
    return board;
  };

  it("the largest result stays under the cap: 40 roles", async () => {
    const { result } = await call({ domain: "acme.io" }, { [ashbyApi("acme")]: JSON.stringify(fat(300, long(ROLE_DESCRIPTION_MAX_CHARS))) });
    expect(result.roles!.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_CAP_CHARS);
  });

  it("the largest result stays under the cap: 5 roles with descriptions", async () => {
    const ids = [0, 1, 2, 3, 4].map((i) => `role-${i}`);
    const { result } = await call({ domain: "acme.io", role_ids: ids }, { [ashbyApi("acme")]: JSON.stringify(fat(300, long(ROLE_DESCRIPTION_MAX_CHARS))) });
    expect(result.roles).toHaveLength(5);
    expect(result.roles!.every((r) => (r.description ?? "").length > 0)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_CAP_CHARS);
    expect(result.counts?.total).toBe(300);
  });
});

describe("job_openings: rendering", () => {
  it("puts notes right after the header, then counts and roles", async () => {
    const { result } = await call({ domain: "acme.io" }, { [ashbyApi("acme")]: JSON.stringify(ashbyBoard(60)) });
    const lines = renderJobOpenings(result).split("\n");
    expect(lines[0]).toBe("Job openings: ashby board acme, https://jobs.ashbyhq.com/acme (ok)");
    expect(lines[1]).toMatch(/^note: showing 40 of 60/);
    expect(lines.join("\n")).toContain("60 open roles");
    expect(lines.join("\n")).toContain("Dept 0 (20)");
    expect(lines.some((l) => l.startsWith("- Engineer 59"))).toBe(true);
  });

  it("says plainly when no public board was found, and when a check failed", async () => {
    const none = await call({ domain: "acme.io" }, {});
    expect(renderJobOpenings(none.result)).toContain("no public board found");
    const refused = await call({ domain: "acme.io" }, { [ashbyApi("acme")]: { status: 403 } });
    const text = renderJobOpenings(refused.result);
    expect(text).toContain("could not be checked");
    expect(text).not.toContain("no public board found");
  });

  it("renders an error with its fallback line, and stays within the cap", async () => {
    const bad = await call({ domain: "127.0.0.1" }, {});
    expect(render("job_openings", bad.result)).toContain(FALLBACK_LINE);
    const ids = [0, 1, 2, 3, 4].map((i) => `role-${i}`);
    const big = await call({ domain: "acme.io", role_ids: ids }, { [ashbyApi("acme")]: JSON.stringify(ashbyBoard(5, { description: "y".repeat(3000) })) });
    expect(render("job_openings", big.result).length).toBeLessThanOrEqual(4000);
  });
});

describe("job_openings: subrequests on a cold cache", () => {
  const ids = ghJobs.jobs.slice(0, 5).map((j) => String(j.id));
  const detailUrl = (slug: string, id: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}?pay_transparency=true`;

  /** Deps as makeDeps builds them (`limit` subrequests), over a meter that counts what reaches the network and cache. */
  async function metered(routes: Record<string, Route>, limit = 45) {
    const m = meter(fakeFetch(routes), await caches.open(`jobs-${crypto.randomUUID()}`));
    const noArchive = async () => {
      throw new Error("job_openings must not use the archive");
    };
    return { m, deps: callDeps({ fetch: m.fetch, cache: m.cache, archive: noArchive, now: () => NOW }, limit, "test") };
  }

  /** Nine absent boards, three empty careers pages, a fourth linking a Greenhouse board, and five role details. */
  function worstPath(): Record<string, Route> {
    const routes: Record<string, Route> = {
      [careers("acme.io")[3]]: '<a href="https://boards.greenhouse.io/acmehq">Jobs</a>',
      [gh("acmehq")]: JSON.stringify(ghJobs),
      [ghDeps("acmehq")]: JSON.stringify(ghDepartments),
    };
    for (const id of ids) routes[detailUrl("acmehq", id)] = JSON.stringify({ ...ghDetail, id: Number(id) });
    return routes;
  }

  it("a big Greenhouse board with five role descriptions takes 9", async () => {
    const routes: Record<string, Route> = { [gh("stripe")]: JSON.stringify(ghJobs), [ghDeps("stripe")]: JSON.stringify(ghDepartments) };
    for (const id of ids) routes[detailUrl("stripe", id)] = JSON.stringify({ ...ghDetail, id: Number(id) });
    const { m, deps } = await metered(routes);
    const result = await jobOpenings({ domain: "stripe.com", company_name: "Stripe", role_ids: ids }, deps);
    expect(result.status).toBe("ok");
    expect(result.roles).toHaveLength(5);
    expect(m.total()).toBe(9);
  });

  it("the longest path, every board tried and found through the careers page, takes 40", async () => {
    const { m, deps } = await metered(worstPath());
    const result = await jobOpenings({ domain: "acme.io", company_name: "Acme Labs", role_ids: ids }, deps);
    expect(result.status).toBe("ok");
    expect(result.board?.slug).toBe("acmehq");
    expect(result.roles?.every((r) => r.description)).toBe(true);
    expect(m.counts).toEqual({ fetch: 20, cache: 20 });
  });

  it("at a lower limit it stops before the limit with partial, and says to call again", async () => {
    const { m, deps } = await metered(worstPath(), 12);
    const result = await jobOpenings({ domain: "acme.io", company_name: "Acme Labs", role_ids: ids }, deps);
    expect(m.total()).toBeLessThanOrEqual(12);
    expect(result.status).toBe("partial");
    expect(result.no_public_board_found).toBe(false);
    const note = result.notes.find((n) => n.includes("per-request limit of 12 subrequests"));
    expect(note).toContain("call again with the same input to continue");
    expect(JSON.stringify(result)).not.toMatch(/HTTP 599|connection failed/);
  });
});
