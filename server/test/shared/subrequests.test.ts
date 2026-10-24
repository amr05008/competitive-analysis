import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUBREQUEST_LIMIT } from "../../src/config";
import { REFUSED_STATUS } from "../../src/shared/http";
import { countedFetch, parseSubrequestLimit, Subrequests } from "../../src/shared/subrequests";
import { fakeFetch } from "../helpers/fake-fetch";

describe("parseSubrequestLimit", () => {
  it("reads a whole number of at least 1", () => {
    expect(parseSubrequestLimit("45")).toBe(45);
    expect(parseSubrequestLimit("900")).toBe(900);
  });

  it.each([undefined, "", " ", "abc", "0", "-5", "4.5", "Infinity", "NaN"])("falls back to 45 for %j, never unlimited", (raw) => {
    expect(DEFAULT_SUBREQUEST_LIMIT).toBe(45);
    expect(parseSubrequestLimit(raw)).toBe(45);
  });

  it("wrangler.toml sets 45", () => {
    expect(env.SUBREQUEST_LIMIT).toBe("45");
  });
});

describe("Subrequests", () => {
  it("counts up to the limit, then refuses", () => {
    const s = new Subrequests(2);
    expect([s.take(), s.take(), s.take()]).toEqual([true, true, false]);
    expect(s.used).toBe(2);
    expect(s.left).toBe(0);
  });
});

describe("countedFetch", () => {
  it("passes requests through until the limit, then answers REFUSED_STATUS without a request", async () => {
    const inner = fakeFetch({ "https://a.test/": "ok" });
    const s = new Subrequests(1);
    const f = countedFetch(inner, s);
    expect((await f("https://a.test/")).status).toBe(200);
    const refused = await f("https://a.test/");
    expect(refused.status).toBe(REFUSED_STATUS);
    expect(inner.calls).toHaveLength(1);
  });
});
