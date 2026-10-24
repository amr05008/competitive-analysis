import { describe, expect, it } from "vitest";
import { searchHn } from "../../src/sources/hn";
import { fakeFetch } from "../helpers/fake-fetch";
import fixture from "../fixtures/hn/search-hightouch.json";

const fresh = () => caches.open(`hn-${crypto.randomUUID()}`);

describe("searchHn", () => {
  it("builds the search address", async () => {
    const url =
      "https://hn.algolia.com/api/v1/search?query=%22Hightouch%22&tags=story&hitsPerPage=3&numericFilters=created_at_i%3E%3D1704067200%2Ccreated_at_i%3C1735689600";
    const fetch = fakeFetch({ [url]: JSON.stringify(fixture) });
    const r = await searchHn(fetch, await fresh(), {
      query: "Hightouch",
      tags: "story",
      hitsPerPage: 3,
      fromTs: 1704067200,
      toTs: 1735689600,
    });
    expect(fetch.calls).toEqual([url]);
    expect(r.ok).toBe(true);
  });

  it("restricts a domain search to the url field", async () => {
    const fetch = fakeFetch({});
    await searchHn(fetch, await fresh(), { query: "hightouch.com", tags: "story", hitsPerPage: 0, urlOnly: true });
    expect(fetch.calls).toEqual([
      "https://hn.algolia.com/api/v1/search?query=%22hightouch.com%22&tags=story&hitsPerPage=0&restrictSearchableAttributes=url",
    ]);
  });

  it("reads the count and the hits, without authors", async () => {
    const fetch = fakeFetch({
      "https://hn.algolia.com/api/v1/search?query=%22Hightouch%22&tags=story&hitsPerPage=5": JSON.stringify(fixture),
    });
    const r = await searchHn(fetch, await fresh(), { query: "Hightouch", tags: "story", hitsPerPage: 5 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.count).toBe(42);
    expect(r.hits).toHaveLength(5);
    expect(r.hits[0]).toEqual({
      title: "Launch HN: Hightouch (YC S19) – Sync data from data warehouses to SaaS tools",
      points: 132,
      numComments: 47,
      createdAt: "2021-11-11T15:02:50Z",
      id: "29188544",
      url: null,
    });
    expect(JSON.stringify(r)).not.toContain("author");
  });

  it("serves a repeat from the cache", async () => {
    const cache = await fresh();
    const fetch = fakeFetch({
      "https://hn.algolia.com/api/v1/search?query=%22Hightouch%22&tags=story&hitsPerPage=5": JSON.stringify(fixture),
    });
    const p = { query: "Hightouch", tags: "story", hitsPerPage: 5 } as const;
    await searchHn(fetch, cache, p);
    await searchHn(fetch, cache, p);
    expect(fetch.calls).toHaveLength(1);
  });

  it("returns a failure as a value", async () => {
    const fetch = fakeFetch({
      "https://hn.algolia.com/api/v1/search?query=%22X%22&tags=story&hitsPerPage=5": { status: 429 },
    });
    const r = await searchHn(fetch, await fresh(), { query: "X", tags: "story", hitsPerPage: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("source_rate_limited");
  });

  it("treats a body without a count as unavailable", async () => {
    const fetch = fakeFetch({
      "https://hn.algolia.com/api/v1/search?query=%22X%22&tags=story&hitsPerPage=5": "{}",
    });
    const r = await searchHn(fetch, await fresh(), { query: "X", tags: "story", hitsPerPage: 5 });
    expect(r.ok).toBe(false);
  });
});
