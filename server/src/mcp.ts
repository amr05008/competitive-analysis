import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { SERVER_NAME, SERVER_VERSION } from "./config";
import { outputObject } from "./contract/envelope";
import { TOOLS, type ToolResult } from "./contract/tools";
import { politeFetch } from "./shared/http";
import { IMPLEMENTATIONS, render, type ToolDeps } from "./tools";

export function makeDeps(_env: Env): ToolDeps {
  return {
    // Wrapped, not passed bare: workerd throws "Illegal invocation" when fetch
    // is called as a method of another object, as in deps.fetch(url).
    fetch: (input, init) => fetch(input, init),
    archive: (url, opts) => politeFetch((input, init) => fetch(input, init), url, opts),
    cache: caches.default,
    now: () => Date.now(),
  };
}

export function buildServer(env: Env, _ctx: ExecutionContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  for (const tool of TOOLS) {
    // The SDK has already checked the input against the tool's input schema.
    const implementation = IMPLEMENTATIONS[tool.name] as (input: unknown, deps: ToolDeps) => Promise<ToolResult>;
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
        const result = await implementation(input, makeDeps(env));
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

/** Stateless MCP over Streamable HTTP: a new server and transport per request. */
export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // A stateless server has no event stream to offer on GET and no session to
  // end on DELETE. 405 tells the client so; the transport would otherwise hold
  // a GET open as an idle event stream.
  if (req.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  const server = buildServer(env, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
