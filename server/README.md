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
npm run typecheck
npm run dev         # a local server at http://localhost:8787
```

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
- The compatibility date (2026-08-15) is the newest the test pool's bundled workerd supports,
  so tests and production run the same runtime flags. Raise it when the pool catches up.
- Output values from sets that may grow (error reasons, job board services) are plain strings
  in the schema, with today's values listed in the description. The TypeScript types stay
  closed, so the code only emits known values.
