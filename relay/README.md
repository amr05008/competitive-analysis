# Competitive Analysis archive relay

A small Vercel Function that makes Wayback Machine requests for the Competitive Analysis
server (`../server`). The archive rate-limits Cloudflare's whole network as one client, so
the server's `page_history` tool sends its archive requests here instead. Nothing else goes
through it, and it never goes in the plugin zip.

## What it does

`POST /api/archive` with `{ "url": "https://web.archive.org/..." }` and
`authorization: Bearer <ARCHIVE_RELAY_TOKEN>`. It makes one GET with the caller's user agent,
follows no redirects, and returns the archive's status, `location`, `content-type`,
`memento-datetime` and body, with `x-archive-relay: archive`. `memento-datetime` marks a
replayed capture, so the server can tell a capture of a page that failed when it was
archived from the archive refusing a request.

- Without the token, or for anything but a POST, it answers a plain 404.
- It fetches only the CDX index (`/cdx/search/cdx`) and raw captures (`/web/<timestamp>id_/...`).
  Any other address gets 400 with `x-archive-relay: refused`.
- If it can't reach the archive, it answers 502 with `unreachable`. If the archive is too slow,
  it answers 504 with `timeout`.
- Bodies are cut at 4 MB, above the server's own caps.

The address travels in the body, never the path, because the address names the company a user
asked about and Vercel's request log records paths. The relay logs nothing.

## Commands

```bash
npm install
npm test            # every test
npm run typecheck
```

## Setup

- Vercel project `competitive-analysis-relay`, Hobby, with this folder as its root. Region
  iad1 (`vercel.json`).
- `ARCHIVE_RELAY_TOKEN`: at least 32 characters (`openssl rand -hex 32`), set as a Vercel
  environment variable and, with the same value, as a Worker secret
  (`wrangler secret put ARCHIVE_RELAY_TOKEN --env <env>`). Under 32 characters or unset, the
  relay refuses everyone. Never in git. A changed token takes effect only after a redeploy:
  `npx vercel@65.2.0 deploy --prod` in this folder.
- The server uses the relay where its environment sets `ARCHIVE_RELAY_URL`; elsewhere it goes
  to the archive directly.
