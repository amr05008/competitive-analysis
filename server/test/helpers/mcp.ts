import { SELF } from "cloudflare:test";

let nextId = 1;

/**
 * Sends one JSON-RPC request to the Worker's /mcp endpoint and returns its
 * `result`. Throws on an HTTP failure or a JSON-RPC error, naming the method.
 */
export async function rpc(method: string, params?: object): Promise<any> {
  const res = await SELF.fetch("https://server.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}: ${text}`);
  const body = JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) throw new Error(`rpc ${method}: JSON-RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}
