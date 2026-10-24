import { aboutPage } from "./about";
import { handleMcp } from "./mcp";

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) return aboutPage(req);
    if (pathname === "/mcp") return handleMcp(req, env, ctx);
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
} satisfies ExportedHandler<Env>;
