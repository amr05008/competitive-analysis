import { aboutPage } from "./about";
import { handleMcp, runTool } from "./mcp";
import { runScheduled } from "./selfcheck";

export { Limits } from "./shared/limits";

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) return aboutPage(req);
    if (pathname === "/mcp") return handleMcp(req, env, ctx);
    if (
      pathname === "/.well-known/openai-apps-challenge" &&
      (req.method === "GET" || req.method === "HEAD") &&
      env.OPENAI_APPS_CHALLENGE
    ) {
      const body = req.method === "HEAD" ? null : env.OPENAI_APPS_CHALLENGE;
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
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
