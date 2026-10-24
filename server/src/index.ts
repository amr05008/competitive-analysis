import { aboutPage } from "./about";
import { handleMcp, runTool } from "./mcp";
import { runScheduled } from "./selfcheck";

export { Limits } from "./shared/limits";

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) return aboutPage(req);
    if (pathname === "/mcp") return handleMcp(req, env, ctx);
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runScheduled(env, ctx, controller.cron, controller.scheduledTime, {
        run: runTool,
        fetcher: (input, init) => fetch(input, init),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
