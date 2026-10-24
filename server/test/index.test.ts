import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rpc } from "./helpers/mcp";

describe("about page and routing", () => {
  it("GET / returns the about page", async () => {
    const res = await SELF.fetch("https://server.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("https://aaronroy.com/competitive-analysis/");
  });

  it("HEAD / returns 200 with no body", async () => {
    const res = await SELF.fetch("https://server.test/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toBe("");
  });

  it("GET /nope returns 404", async () => {
    const res = await SELF.fetch("https://server.test/nope");
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("GET /mcp returns 405, since a stateless server offers no event stream", async () => {
    const res = await SELF.fetch("https://server.test/mcp", { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    await res.body?.cancel();
  });
});

describe("MCP endpoint", () => {
  it("initialize names the server and its version", async () => {
    const result = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result.serverInfo.name).toBe("competitive-analysis");
    expect(result.serverInfo.version).toBe("0.2.0");
  });

  // One call per test: a later task adds a daily cap of 3 calls in tests.
  it.each([
    ["page_history", { url: "https://example.com/pricing" }],
    ["job_openings", { domain: "example.com" }],
    ["hacker_news_mentions", { query: "Example" }],
    ["sec_filings", { company_name: "Example" }],
  ])("calling %s with valid input returns the stub error", async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.error.fallback).toBe("fall back to browsing for this check.");
  });
});
