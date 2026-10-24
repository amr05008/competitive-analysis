# Competitive Analysis server

The MCP server behind the Competitive Analysis plugin. It's a Cloudflare Worker with four
read-only tools over free, public sources:

- `page_history`: when a company page's copy changed, from Wayback Machine captures
- `job_openings`: open roles from a company's public Greenhouse, Lever or Ashby board
- `hacker_news_mentions`: Hacker News stories and comments that mention a company, by year
- `sec_filings`: a company's filings on SEC EDGAR, including Form D fundraising notices

It speaks MCP over Streamable HTTP at `/mcp`, stateless, with no sign-in. `GET /` is a short
about page. This folder is public code, and it never goes in the plugin zip.

## Layout

- `src/contract/`: the four tools as a directory reviews them (names, descriptions, schemas,
  annotations), the result envelope, and the additive-only check
- `src/tools/`: one function per tool
- `src/shared/`: plumbing the tools share
- `src/mcp.ts`: the MCP server and endpoint. `src/index.ts` routes requests.
- `test/`: tests, which run inside the Workers runtime

## Commands

```bash
npm install
npm test            # every test, inside workerd
npm run typecheck   # the Worker, then scripts/ with Node's types
npm run dev         # a local server at http://localhost:8787
npm run live -- --url http://localhost:8787/mcp --out ../plans/live-YYYY-MM-DD-local.json
                    # live checks against real Hightouch and ZeroClick data
```

`npm run live` is a client only: it calls a running server's tools with real inputs, prints
each call's status, wall time, fetches and key facts, and with `--out` writes the full results
as JSON. A `page_history` call that comes back partial is made once more with the same input,
since captures already read are cached. It exits non-zero when a call fails, a result doesn't
match its output schema, or a call takes 30 s or more. It reaches the Wayback Machine, EDGAR,
Hacker News search and the job boards, so run it sparingly. Its results name real companies,
so `--out` refuses any path in the repo outside the ignored `plans/` folder.

## The contract only grows

Once a directory approves the tools, they can gain optional inputs, output fields, notes and
error reasons, and nothing else. `test/__snapshots__/tools-list.json` holds the `tools/list`
response. A contract change fails `npm test` twice over: the snapshot no longer matches, and
`assertAdditive` checks the committed snapshot against the new list.

For an additive change, run `npx vitest run -u` and commit the new snapshot with the change.
A breaking change still fails on that run. Don't run it again to make it pass; add a new tool
instead.

## Rules

- Never log tool inputs. Observability is off in `wrangler.toml`.
- No keys or tokens in this folder. Secrets go in with `wrangler secret put`.
- Tools take companies, never people, and their output never names a person.

## Notes

- After editing `wrangler.toml`, run `npx wrangler types` and commit
  `worker-configuration.d.ts`.
- `SUBREQUEST_LIMIT` (45) caps each tool call's fetches plus Cache API calls. The free plan
  counts both against one limit of 50 per request, and a tool that reaches 45 returns what it
  has as partial, with a note to call again. On the paid plan, raise it to about 900.
- The daily self-check runs one tool per Cron Trigger, at 13:00, 13:05, 13:10 and 13:15 UTC
  (`SCHEDULE` in `src/selfcheck.ts`), so each invocation stays within its subrequest and CPU
  limits. The Monday usage summary goes with 13:00. The crons belong to production only; any
  other cron does nothing.
- Cache keys start with the environment's name and a version per source, since staging and
  production share one zone's cache. Bump a source's version when its cached shape changes.
- The compatibility date (2026-08-15) is the newest the test pool's bundled workerd supports,
  so tests and production run the same runtime flags. Raise it when the pool catches up.
- Output values from sets that may grow (error reasons, job board services) are plain strings
  in the schema, with today's values listed in the description. The TypeScript types stay
  closed, so the code only emits known values.
