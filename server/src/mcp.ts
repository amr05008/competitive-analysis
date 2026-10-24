import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_MAX_REQUEST_BODY_SIZE, readRequestBody, requestBodyTooLargeMessage } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { SERVER_NAME, SERVER_VERSION } from "./config";
import { errorResult, outputObject } from "./contract/envelope";
import { TOOLS, type ToolName, type ToolResult } from "./contract/tools";
import type { FetchOutcome } from "./shared/http";
import { limitsStub } from "./shared/limits";
import { parseSubrequestLimit } from "./shared/subrequests";
import { outcomeOf } from "./shared/usage-store";
import { callDeps, IMPLEMENTATIONS, render, type ToolDeps } from "./tools";

/** One tool call's deps, with its own subrequest counter (see callDeps). */
export function makeDeps(env: Env): ToolDeps {
  return callDeps(
    {
      // Wrapped, not passed bare: workerd throws "Illegal invocation" when fetch
      // is called as a method of another object, as in deps.fetch(url).
      fetch: (input, init) => fetch(input, init),
      // Every archive request goes through the one server-wide gate. Like
      // politeFetch, it never rejects: an unreachable gate is server_busy.
      archive: async (url, opts): Promise<FetchOutcome> => {
        try {
          return await limitsStub(env).archiveFetch(url, opts);
        } catch {
          return { ok: false, reason: "server_busy", url, detail: "the archive gate is unavailable" };
        }
      },
      cache: caches.default,
      now: () => Date.now(),
    },
    parseSubrequestLimit(env.SUBREQUEST_LIMIT),
    env.ENVIRONMENT,
  );
}

/**
 * Runs one tool call under the daily cap, then counts its outcome. The count
 * is written after the response, and a failure to write it never fails the
 * call. Tool inputs are never recorded.
 */
export async function runTool(
  name: ToolName,
  input: unknown,
  env: Env,
  ctx: ExecutionContext,
  opts: { selfCheck: boolean },
): Promise<ToolResult> {
  const limits = limitsStub(env);
  let allowed: boolean;
  try {
    ({ allowed } = await limits.admit(name, opts.selfCheck));
  } catch {
    // The Limits object can't be reached (say, a free-plan limit): fail closed.
    return errorResult("server_busy", "the server's limits are unavailable; try again later", []);
  }
  if (!allowed) return errorResult("server_busy", "daily limit reached; try again after 00:00 UTC", []);
  // Inputs arrive checked against the tool's input schema: by the SDK for MCP
  // calls, and written in code for the self-check.
  const implementation = IMPLEMENTATIONS[name] as (input: unknown, deps: ToolDeps) => Promise<ToolResult>;
  const deps = makeDeps(env);
  let result: ToolResult;
  try {
    result = await implementation(input, deps);
  } catch {
    // Tools return failures as values; a throw is a bug. Its message may hold
    // the input, so it stays out of the result.
    result = errorResult("source_unavailable", "the tool failed unexpectedly", [], deps.now());
  }
  const recording = (async () => limits.record(name, outcomeOf(result), opts.selfCheck))().catch(() => {});
  ctx.waitUntil(recording);
  return result;
}

export function buildServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: outputObject(tool.outputSchema),
        annotations: tool.annotations,
      },
      async (input) => {
        const result = await runTool(tool.name, input, env, ctx, { selfCheck: false });
        return {
          structuredContent: result,
          content: [{ type: "text", text: render(tool.name, result) }],
          isError: result.status === "error",
        };
      },
    );
  }
  return server;
}

const jsonRpcError = (status: number, code: number, message: string, headers?: HeadersInit): Response =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });

/** Stateless MCP over Streamable HTTP: a new server and transport per request. */
export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // A stateless server has no event stream to offer on GET and no session to
  // end on DELETE. 405 tells the client so; the transport would otherwise hold
  // a GET open as an idle event stream.
  if (req.method !== "POST") return jsonRpcError(405, -32000, "Method not allowed.", { allow: "POST" });
  // The body is read once, here, with the transport's own size limit and errors. A batch of more
  // than one message is refused: protocol 2025-06-18 dropped batching, and one POST could otherwise
  // run up to 100 tool calls. The transport gets the parsed body.
  let parsed: unknown;
  try {
    const body = await readRequestBody(req, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (body.tooLarge) return jsonRpcError(413, -32000, requestBodyTooLargeMessage(DEFAULT_MAX_REQUEST_BODY_SIZE));
    parsed = JSON.parse(body.text);
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
  }
  if (Array.isArray(parsed) && parsed.length > 1) {
    return jsonRpcError(400, -32600, "Invalid Request: batches are not supported; send one message per request");
  }
  const server = buildServer(env, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req, { parsedBody: parsed });
}
