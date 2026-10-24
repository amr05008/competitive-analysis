import { createExecutionContext, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { errorResult } from "../src/contract/envelope";
import type { JobOpeningsResult } from "../src/contract/tools";
import { runTool } from "../src/mcp";
import { IMPLEMENTATIONS } from "../src/tools";
import { rpc } from "./helpers/mcp";

// Durable Object storage is fresh for each test file but shared by the tests
// in it (pool-workers 0.22), so each test starts with a clean daily count.
beforeEach(async () => {
  await reset();
});

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

  // One call per test, under the test cap of 3 calls a day. A built tool gets
  // input it refuses as bad_input before any fetch: tests never reach live sources.
  it.each([
    ["page_history", { url: "http://127.0.0.1/" }],
    ["job_openings", { domain: "127.0.0.1" }],
    ["hacker_news_mentions", { query: "Example", domain: "127.0.0.1" }],
    ["sec_filings", { company_name: "Example", domain: "127.0.0.1" }],
  ])("calling %s returns an error envelope with the fallback line", async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.error.fallback).toBe("fall back to browsing for this check.");
    expect(result.structuredContent.error.reason).not.toBe("server_busy");
  });
});

describe("daily cap", () => {
  it("refuses the call after the cap with server_busy (the test cap is 3)", async () => {
    // A private host: once page_history is built, this is bad_input without a fetch.
    const call = () => rpc("tools/call", { name: "page_history", arguments: { url: "http://127.0.0.1/" } });
    for (let i = 0; i < 3; i++) expect((await call()).structuredContent.error.reason).not.toBe("server_busy");
    const fourth = await call();
    expect(fourth.isError).toBe(true);
    expect(fourth.structuredContent.status).toBe("error");
    expect(fourth.structuredContent.error.reason).toBe("server_busy");
    expect(fourth.structuredContent.error.detail).toContain("daily limit");
    expect(fourth.structuredContent.error.fallback).toBe("fall back to browsing for this check.");
  });
});

describe("runTool", () => {
  type Calls = { admit: unknown[][]; record: unknown[][] };

  /** The real env with a stand-in Limits object, so each test sets what admit and record do. */
  function withLimits(limits: { admit?: () => Promise<{ allowed: boolean }>; record?: () => Promise<void> }) {
    const calls: Calls = { admit: [], record: [] };
    const stub = {
      admit: (...a: unknown[]) => {
        calls.admit.push(a);
        return limits.admit ? limits.admit() : Promise.resolve({ allowed: true });
      },
      record: (...a: unknown[]) => {
        calls.record.push(a);
        return limits.record ? limits.record() : Promise.resolve();
      },
    };
    const LIMITS = { idFromName: () => ({}), get: () => stub } as unknown as Env["LIMITS"];
    return { env: { ...env, LIMITS }, calls };
  }

  const INPUT = { domain: "example.com" };
  const PARTIAL: JobOpeningsResult = { status: "partial", notes: ["descriptions missing"], retrieved_at: "2026-10-24" };

  // A stand-in tool, so these tests never reach a real job board.
  let tool: MockInstance;
  beforeEach(() => {
    tool = vi.spyOn(IMPLEMENTATIONS, "job_openings").mockResolvedValue(PARTIAL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])("admits, runs the tool, then records its outcome (selfCheck %s)", async (selfCheck) => {
    const { env: e, calls } = withLimits({});
    const ctx = createExecutionContext();
    const result = await runTool("job_openings", INPUT, e, ctx, { selfCheck });
    await waitOnExecutionContext(ctx);
    expect(result).toBe(PARTIAL);
    expect(tool).toHaveBeenCalledWith(INPUT, expect.objectContaining({ archive: expect.any(Function) }));
    expect(calls.admit).toEqual([["job_openings", selfCheck]]);
    expect(calls.record).toEqual([["job_openings", "partial", selfCheck]]);
  });

  it("records a failed call under its error reason", async () => {
    tool.mockResolvedValue(errorResult("source_rate_limited", "HTTP 429", []));
    const { env: e, calls } = withLimits({});
    const ctx = createExecutionContext();
    await runTool("job_openings", INPUT, e, ctx, { selfCheck: false });
    await waitOnExecutionContext(ctx);
    expect(calls.record).toEqual([["job_openings", "source_rate_limited", false]]);
  });

  it("a tool that throws returns source_unavailable, with nothing from the error, and is recorded", async () => {
    tool.mockRejectedValue(new Error("parse failed on https://example.com/secret"));
    const { env: e, calls } = withLimits({});
    const ctx = createExecutionContext();
    const result = await runTool("job_openings", INPUT, e, ctx, { selfCheck: false });
    await waitOnExecutionContext(ctx);
    expect(result).toEqual(errorResult("source_unavailable", "the tool failed unexpectedly", [], Date.now()));
    expect(JSON.stringify(result)).not.toContain("example.com");
    expect(calls.record).toEqual([["job_openings", "source_unavailable", false]]);
  });

  it("returns without waiting for record", async () => {
    const { env: e, calls } = withLimits({ record: () => new Promise<void>(() => {}) });
    expect(await runTool("job_openings", INPUT, e, createExecutionContext(), { selfCheck: false })).toBe(PARTIAL);
    expect(calls.record).toHaveLength(1);
  });

  it("a failing record doesn't fail the call", async () => {
    const { env: e } = withLimits({ record: () => Promise.reject(new Error("storage down")) });
    const ctx = createExecutionContext();
    expect(await runTool("job_openings", INPUT, e, ctx, { selfCheck: false })).toBe(PARTIAL);
    await waitOnExecutionContext(ctx);
  });

  it("a refusal returns server_busy without running the tool or recording again", async () => {
    const { env: e, calls } = withLimits({ admit: async () => ({ allowed: false }) });
    const ctx = createExecutionContext();
    const result = await runTool("job_openings", INPUT, e, ctx, { selfCheck: false });
    await waitOnExecutionContext(ctx);
    expect(result).toMatchObject({
      status: "error",
      error: { reason: "server_busy", detail: "daily limit reached; try again after 00:00 UTC", tried: [] },
    });
    expect(tool).not.toHaveBeenCalled();
    expect(calls.record).toEqual([]);
  });

  it("an unreachable Limits object fails closed with server_busy", async () => {
    const { env: e } = withLimits({ admit: () => Promise.reject(new Error("Durable Object exceeded its limit")) });
    const result = await runTool("job_openings", INPUT, e, createExecutionContext(), { selfCheck: false });
    expect(result.error?.reason).toBe("server_busy");
    expect(result.error?.detail).not.toContain("exceeded");
    expect(tool).not.toHaveBeenCalled();
  });
});
