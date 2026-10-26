# Competitive Analysis

A ChatGPT/Codex and Claude plugin that produces an evidence-graded teardown of one
company. The method comes from the `competitive-analysis` skill in
[amr05008/agent-skills](https://github.com/amr05008/agent-skills); this repo packages
it for the plugin directories. The ChatGPT and Claude versions ship together.

Version 0.2.0 adds the plugin's own MCP server, with tools for page history, job boards,
Hacker News discussion and SEC filings. The server in `server/` has been live at
`competitive-analysis.aaronmichaelroy.com` since 2026-10-26; the skill starts using it in
0.2.0.

## Layout

- `listing/competitive-analysis-listing.md`: the store listing (name, subtitle, prompts,
  description, release notes). The one place to edit them.
- `plugin.json`: the portable manifest. Its listing fields are **generated** from the
  listing file; the rest is edited by hand.
- `skills/teardown/SKILL.md`: the method, written for a model with a browser and
  whatever plugins the user connected.
- `skills/teardown/references/report-template.md`: **generated** by
  `scripts/build.sh` from agent-skills; the report contract has one source.
- `scripts/build.sh`: regenerates both, checks the listing limits and vendor names, and
  writes `dist/competitive-analysis-<version>.zip`.
- `assets/`: icon and logo.
- `server/`: the MCP server, a Cloudflare Worker. Public code, and it never goes in the
  zip. See [`server/README.md`](server/README.md).
- `relay/`: a Vercel Function that makes the server's Wayback Machine requests, because the
  archive rate-limits Cloudflare's network. Never in the zip. See
  [`relay/README.md`](relay/README.md).
- `LICENSE`: MIT. Ships in the zip.

Planning notes and the test log are kept outside this repo.

## 0.1.0 checklist (skills-only, parked)

0.1.0 was uploaded to OpenAI as a draft but never submitted, because OpenAI stopped taking
skills-only submissions. The checklist for 0.2.0, the version with the server, is kept with
the private plans.

- [x] Fetch test passed in ChatGPT (CDX, raw `id_` capture, Greenhouse and Ashby JSON). 2026-10-05
- [ ] `developerName` matches the verified identity exactly.
- [ ] Privacy and terms pages live at the URLs in `plugin.json`.
- [x] `assets/icon-small.svg` and `assets/logo.png` exist.
- [x] Installed from a local marketplace; "should we worry about ZeroClick" triggers
      the skill without a mention; labels present; pivot dated. Run 2, 2026-10-05.
- [x] Wayback rerun dates the ZeroClick pivot from captures (Exa off). Runs 6–7,
      2026-10-11: dated, but bracket wide (archive refused connections mid-run).
- [x] `sh scripts/build.sh` run against a fresh `agent-skills` pull. 2026-10-11, agent-skills@2f3a16a,
      no change. Rerun if agent-skills moves before upload.
- [x] Listing copy: `longDescription` reworded (no "worry"), Clay added. 2026-10-17.
- [x] Clay run in the app: ZeroClick with Clay connected. Headcount labeled ESTIMATE with
      Clay named, Clay in the Run row, no Clay contact tools called. Run 10, 2026-10-17.
- [x] `sh scripts/build.sh` passes and writes `dist/competitive-analysis-0.1.0.zip`
      (`plugin.json`, `LICENSE`, `skills/`, `assets/`). 2026-10-18.
- [x] Support section live at `supportURL` (aaronroy.com/competitive-analysis/#support). 2026-10-18.
- [ ] Tag the uploaded commit `v0.1.0`.
