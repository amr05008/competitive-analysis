// Live checks: calls a running server's tools against real Hightouch and
// ZeroClick data, prints one block per call, and optionally writes the full
// results as JSON. It's a client only.
//
//   npm run live -- --url http://localhost:8787/mcp [--out ../plans/live-YYYY-MM-DD-local.json]
//
// A page_history call that comes back partial is made a second time with the
// same input: captures already read are cached, so the second call continues.
// Each call's structured result is checked against the tool's output schema.
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

type Call = { tool: string; input: Record<string, unknown> };

const CALLS: Call[] = [
  // Hightouch
  { tool: "page_history", input: { url: "https://hightouch.com/", from: "2020-01", max_changes: 15 } },
  { tool: "page_history", input: { url: "https://hightouch.com/pricing", from: "2024-06" } },
  { tool: "job_openings", input: { domain: "hightouch.com", company_name: "Hightouch" } },
  { tool: "hacker_news_mentions", input: { query: "Hightouch", domain: "hightouch.com" } },
  { tool: "sec_filings", input: { company_name: "Hightouch", domain: "hightouch.com" } },
  { tool: "sec_filings", input: { company_name: "Carry Technologies" } },
  // ZeroClick
  { tool: "page_history", input: { url: "https://zeroclick.ai/", from: "2025-01" } },
  { tool: "job_openings", input: { domain: "zeroclick.ai", company_name: "ZeroClick" } },
  { tool: "hacker_news_mentions", input: { query: "ZeroClick" } },
  { tool: "sec_filings", input: { company_name: "ZeroClick" } },
  // A load probe: a large board. No pass bar; its time and fetches are recorded.
  { tool: "job_openings", input: { domain: "stripe.com", company_name: "Stripe" } },
];

/** Long enough to measure a slow call instead of cutting it off; the target is under 30 s. */
const CALL_TIMEOUT_MS = 120_000;
const TARGET_SECONDS = 30;

function args(argv: string[]): { url: string; out: string | null } {
  let url: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") url = argv[++i] ?? null;
    else if (argv[i] === "--out") out = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!url) throw new Error("usage: npm run live -- --url <mcp url> [--out <file>]");
  return { url, out };
}

const clip = (s: unknown, max = 90): string => {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ------------------------------------------------------------- key facts

type Any = Record<string, any>;

function pageHistoryFacts(r: Any): string[] {
  const lines = [
    `range ${r.range?.from} to ${r.range?.to}; first capture ${r.first_capture?.date ?? "unknown"}; ${r.captures_in_range ?? 0} captures in range`,
  ];
  for (const c of r.changes ?? []) {
    const prices = (s: Any) => (s.prices.length ? `${s.prices.length} prices` : "no prices");
    lines.push(
      `${c.before.date} → ${c.after.date} (${c.days_between} d${c.resolved ? "" : ", wide"}): ` +
        `"${clip(c.before.headline, 70)}" → "${clip(c.after.headline, 70)}" [${prices(c.before)} → ${prices(c.after)}]`,
    );
    if (c.before.title !== c.after.title) lines.push(`    title "${clip(c.before.title, 70)}" → "${clip(c.after.title, 70)}"`);
  }
  return lines;
}

function jobFacts(r: Any): string[] {
  const lines: string[] = [];
  if (r.board) lines.push(`board ${r.board.ats}/${r.board.slug} ${r.board.url}`);
  else lines.push(`board none; no_public_board_found ${r.no_public_board_found}`);
  if (r.counts) {
    const top = (rows: Any[]) => rows.slice(0, 5).map((d) => `${d.name} ${d.count}`).join(", ");
    lines.push(`${r.counts.total} roles; departments: ${top(r.counts.by_department)}`);
    lines.push(`locations: ${top(r.counts.by_location)}`);
  }
  for (const role of (r.roles ?? []).slice(0, 3)) {
    lines.push(`role "${clip(role.title, 60)}" ${role.date ?? "no date"} (${role.date_kind}) pay ${role.pay ?? "none"}`);
  }
  lines.push(`tried ${(r.tried ?? []).length}: ${(r.tried ?? []).map((u: string) => clip(u, 70)).join(" | ")}`);
  return lines;
}

function hnFacts(r: Any): string[] {
  const lines = (r.years ?? []).map(
    (y: Any) =>
      `${y.year}: ${y.stories} stories, ${y.comments} comments` +
      (y.stories_linking_domain === undefined ? "" : `, ${y.stories_linking_domain} linking the domain`) +
      `; ${y.sample_titles.length} sample titles${y.sample_titles.length ? `, e.g. "${clip(y.sample_titles[0], 60)}"` : ""}`,
  );
  for (const t of (r.top_threads ?? []).slice(0, 3)) {
    lines.push(`top: "${clip(t.title, 60)}" ${t.points} points, ${t.comments} comments, ${t.date}`);
  }
  return lines;
}

function secFacts(r: Any): string[] {
  const lines = [`names tried: ${(r.names_tried ?? []).join(", ")}`];
  if (r.statement) lines.push(`statement: ${r.statement}`);
  for (const e of r.entities ?? []) {
    lines.push(
      `${e.name} (CIK ${e.cik}, ${e.state ?? "no state"}, exact ${e.exact_match}): ${e.filings.length} filings, ${e.form_d.length} Form D`,
    );
    for (const d of e.form_d) {
      lines.push(
        `    Form D ${d.date_filed}${d.amendment ? " (amendment)" : ""}: offering ${d.total_offering_amount}, sold ${d.total_amount_sold}, industry ${d.industry_group}`,
      );
    }
  }
  return lines;
}

const FACTS: Record<string, (r: Any) => string[]> = {
  page_history: pageHistoryFacts,
  job_openings: jobFacts,
  hacker_news_mentions: hnFacts,
  sec_filings: secFacts,
};

/** page_history reports its archive requests; job_openings lists every address it checked. */
function fetchesOf(tool: string, r: Any | undefined): number | null {
  if (!r) return null;
  if (typeof r.fetches_used === "number") return r.fetches_used;
  if (tool === "job_openings" && Array.isArray(r.tried)) return r.tried.length;
  return null;
}

// ------------------------------------------------------------------- run

type Outcome = {
  label: string;
  tool: string;
  input: Record<string, unknown>;
  seconds: number;
  status: string;
  fetches: number | null;
  schema_ok: boolean | null;
  schema_error?: string;
  failure?: string;
  structured?: Any;
  text?: string;
};

async function main(): Promise<void> {
  const { url, out } = args(process.argv.slice(2));
  const client = new Client({ name: "competitive-analysis-live-check", version: "0.2.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const validators = new Map<string, (v: unknown) => { valid: boolean; errorMessage?: string }>();
  const provider = new CfWorkerJsonSchemaValidator();
  for (const t of (await client.listTools()).tools) {
    if (t.outputSchema) validators.set(t.name, provider.getValidator(t.outputSchema as any));
  }

  const outcomes: Outcome[] = [];
  const run = async (call: Call, label: string): Promise<Outcome> => {
    const started = performance.now();
    let o: Outcome;
    try {
      const res = await client.request(
        { method: "tools/call", params: { name: call.tool, arguments: call.input } },
        CallToolResultSchema,
        { timeout: CALL_TIMEOUT_MS },
      );
      const seconds = (performance.now() - started) / 1000;
      const structured = res.structuredContent as Any | undefined;
      const check = validators.get(call.tool)?.(structured);
      const text = res.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      o = {
        label,
        tool: call.tool,
        input: call.input,
        seconds,
        status: structured?.status ?? (res.isError ? "error" : "no structured content"),
        fetches: fetchesOf(call.tool, structured),
        schema_ok: check ? check.valid : null,
        ...(check && !check.valid ? { schema_error: check.errorMessage } : {}),
        structured,
        text,
      };
    } catch (e) {
      o = {
        label,
        tool: call.tool,
        input: call.input,
        seconds: (performance.now() - started) / 1000,
        status: "call failed",
        fetches: null,
        schema_ok: null,
        failure: e instanceof Error ? e.message : String(e),
      };
    }
    print(o);
    outcomes.push(o);
    return o;
  };

  for (const [k, call] of CALLS.entries()) {
    const first = await run(call, `${k + 1}`);
    if (call.tool === "page_history" && first.status === "partial") await run(call, `${k + 1} (again)`);
  }
  await client.close();

  const slow = outcomes.filter((o) => o.seconds >= TARGET_SECONDS);
  const failed = outcomes.filter((o) => o.status === "call failed" || o.schema_ok === false);
  console.log("\n== Summary");
  for (const o of outcomes) {
    console.log(
      `${o.label.padEnd(10)} ${o.tool.padEnd(21)} ${o.status.padEnd(8)} ${o.seconds.toFixed(1).padStart(5)} s  fetches ${o.fetches ?? "-"}`,
    );
  }
  console.log(`slowest: ${Math.max(...outcomes.map((o) => o.seconds)).toFixed(1)} s; ${slow.length} at or over ${TARGET_SECONDS} s; ${failed.length} failed calls or schema mismatches`);

  if (out) {
    writeFileSync(out, `${JSON.stringify({ server: url, run_at: new Date().toISOString(), calls: outcomes }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

function print(o: Outcome): void {
  console.log(`\n== ${o.label}. ${o.tool} ${JSON.stringify(o.input)}`);
  console.log(
    `status ${o.status}; ${o.seconds.toFixed(1)} s; fetches_used ${o.fetches ?? "-"}; schema ${o.schema_ok === null ? "-" : o.schema_ok ? "ok" : `MISMATCH (${o.schema_error})`}`,
  );
  if (o.failure) {
    console.log(`failed: ${o.failure}`);
    return;
  }
  const r = o.structured;
  if (!r) return;
  if (r.error) console.log(`error ${r.error.reason}: ${r.error.detail}`);
  for (const n of r.notes ?? []) console.log(`note: ${n}`);
  for (const line of FACTS[o.tool]?.(r) ?? []) console.log(line);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
