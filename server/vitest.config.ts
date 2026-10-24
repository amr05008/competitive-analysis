import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const SDK_SOURCEMAP_WARNING = /^Sourcemap for ".*\/node_modules\/.*" points to missing source files$/;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // The pool's bundled workerd (1.20260815.1) supports compatibility dates
        // only up to 2026-08-22, older than wrangler.toml's 2026-10-01. Tests
        // run on the bundled runtime's own date until the pool catches up.
        compatibilityDate: "2026-08-15",
        bindings: { DAILY_TOOL_CALL_CAP: "3" },
      },
    }),
    {
      // The MCP SDK publishes sourcemaps whose sources aren't in its npm
      // package, and Vite warns once per SDK file. Drop only that warning.
      // (Vitest replaces `customLogger`, so this wraps the resolved logger.)
      name: "quiet-dependency-sourcemaps",
      configResolved(config) {
        const warnOnce = config.logger.warnOnce.bind(config.logger);
        config.logger.warnOnce = (msg, options) => {
          if (!SDK_SOURCEMAP_WARNING.test(msg)) warnOnce(msg, options);
        };
      },
    },
  ],
});
