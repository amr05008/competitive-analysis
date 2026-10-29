# Competitive Analysis — repo notes for agents

A ChatGPT/Codex and Claude plugin: **Competitive Analysis**, plugin id
`competitive-analysis`, one skill with id `teardown`. It packages the method of Aaron's
private `competitive-analysis` skill. The two are separate skills, and the private one keeps
its name, so `/competitive-analysis` on Aaron's machines still opens the private version.
Released so far as skills-only (0.1.0, never published). OpenAI stopped taking skills-only
submissions, so 0.2 adds the plugin's own MCP server in `server/`, in production since
2026-10-26 at `competitive-analysis.aaronmichaelroy.com`, with staging alongside. The ChatGPT and Claude versions ship together. Start at § Pick up here in
`plans/next-steps-2026-10-05.md`. Formerly "Worry Or Not" (renamed 2026-10-11); plans and
session logs keep the old name as history.

## Where things live

- This checkout is at `~/.codex/plugins/competitive-analysis` **on purpose**: the ChatGPT
  desktop app's personal marketplace (`~/.agents/plugins/marketplace.json`) resolves plugin
  paths relative to the home folder and will not follow symlinks.
  `~/repos/competitive-analysis` is a symlink here. Do not move the directory without
  updating `marketplace.json`, whose entry points at `dist/chatgpt-local`, the build's local
  ChatGPT folder.
- **`plugin/` is the plugin**: the folder Claude's directory lists (Decision 1, 2026-10-26),
  and all that people who install it get. It holds both hosts' files: `plugin.json` and
  `mcp.json` (ChatGPT), `.claude-plugin/plugin.json` and `.mcp.json` (Claude), `README.md`
  (the Claude listing's description), `LICENSE` (a copy of the root one, which the build
  checks), `skills/` and `assets/`. The server, relay, scripts and listing stay outside it,
  so the directory never scans or ships them.
- **Only the production URL is ever committed** in the two MCP files, under the server key
  `competitive-analysis`. `--server staging` swaps the URL in `dist/` only, and the build
  fails if `plugin/` carries any other URL.
- `scripts/package.py`, run by `build.sh`, writes each host's package from `plugin/` and
  checks it, and checks `plugin/` against the directory's file limits. Production writes the
  OpenAI upload zip and the Claude zip; both builds write `dist/chatgpt-local/` (what the
  ChatGPT app installs) and `dist/claude-local/` (for `claude --plugin-dir`, plus `evals/`
  when it exists). `local/` (git-ignored) holds Aaron's ChatGPT app mappings,
  `local/chatgpt-app-<server>.json`, which go into `dist/chatgpt-local/` and nowhere else.
- The method's source of truth is the `competitive-analysis` skill in the private
  `claude-channels` repo, mirrored publicly to `amr05008/agent-skills`.
  `plugin/skills/teardown/references/report-template.md` is **generated** by
  `scripts/build.sh` from the agent-skills checkout. Never edit it here.
- The store listing's source is `listing/competitive-analysis-listing.md`: version, name,
  subtitle, category and prompts in its frontmatter, the description and release notes in its
  body. `scripts/build.sh` (via `scripts/listing.py`) copies them into `plugin/plugin.json`
  (and `version` and `displayName` into `plugin/.claude-plugin/plugin.json`),
  checks the directory's limits, the plugin id and vendor names in `plugin/skills/`, and zips
  the package into `dist/`. Never hand-edit `version`, `displayName`, `shortDescription`,
  `longDescription`, `category`, `defaultPrompt` or `publication.release_notes` in
  `plugin.json`; the rest of `plugin.json` (URLs, icons, ids) is edited by hand. Aaron edits
  the listing in Obsidian: `listing/` is symlinked into his vault at
  `_areas/competitive-analysis/listing`, so only add frontmatter fields `listing.py` knows.
  His private status notes (dashboard links, review history, update checklist) are in
  `_areas/competitive-analysis/competitive-analysis-reference.md` in the vault, not here.
- `plans/` is a **git-ignored symlink** to Aaron's private vault
  (`~/repos/vault/_areas/competitive-analysis/plans/`): the plans, the server design and the
  run log. It exists only on Aaron's Macs, and the files are committed in the vault repo, not
  here. Moved out of this public repo on 2026-10-20, and the server design was removed from
  its history.
- `server/`: the plugin's MCP server (Cloudflare Worker). Public code, never in the zip. The
  tool contract in `server/src/contract/` changes additively only, and `npm test` enforces
  it. Never log tool inputs.
- `relay/`: a Vercel Function (Hobby) that makes the server's Wayback Machine requests,
  because the archive rate-limits Cloudflare's network. Token-gated, logs nothing, never in
  the zip.
- Each uploaded zip's commit is tagged `v<version>`. The build refuses to zip a tagged
  version from different files.
- This repo is Aaron's only public competitive-analysis plugin. The February 2026 Claude
  Code plugin `amr05008/clay-claude-competitor-analysis` was archived on 2026-10-18 with a
  README pointing here; don't revive it or send users to it.
- Background and decisions: `claude-channels/plans/worry-or-not-2026-10-05.md` and
  `claude-channels/plans/competitive-research-plugin-landscape-2026-10-05.md`.

## Rules

- No key, token, or credential of anyone's, ever: not in the package, the repo, a settings
  field, or a reply. Users connect their own Exa/Firecrawl/Monid.
- Teardowns are of companies, not people. No enrichment, no contact data.
- Write "the model", never a model name, in `SKILL.md`.
- Nothing in the public `claude-channels` skill's harness layer (house config, fan-out,
  Artifact, INTERNAL, Monid CLI) belongs here.
- Commit and push straight to `main` until a live version is listed in a directory. After
  that, feature branches and PRs.
- This repo is public. Plans, designs, run logs and anything about Aaron's accounts or limits
  go in `plans/` (the vault), never in git. Write new ones there as
  `plans/<topic>-<YYYY-MM-DD>.md`.

## Test loop

1. Edit `plugin/skills/teardown/SKILL.md`.
2. `sh scripts/build.sh --server staging`, then quit the ChatGPT desktop app (Cmd+Q),
   reopen, Plugins → "Aaron's local plugins" → reinstall if offered. The app installs
   `dist/chatgpt-local`, so an edit reaches it only through a build.
3. New chat, no @-mention: `Should we worry about ZeroClick? zeroclick.ai`. Runs so far are
   Codex chats in the app (share links `chatgpt.com/s/cx_...`). Note whether Exa is on.
4. Score against `plans/next-steps-2026-10-05.md` § Scoring, which also covers the Claude
   Code reference teardown and how to read share links (Chrome; WebFetch gets 403).

The Claude loop uses the same staging build:
- **claude.ai:** in **Customize > Plugins**, remove the old upload, upload
  `dist/competitive-analysis-<version>-claude-staging.zip`, connect it on the plugin's
  **Connectors** tab, then start a new chat.
- **Claude Code:** the claude.ai upload syncs into Claude Code (`competitive-analysis@synced`)
  when a new session starts, so test there; `--plugin-dir dist/claude-local` on top of it
  loads the plugin twice. A plain teardown prompt can load Aaron's private
  `competitive-analysis` skill instead, so check which skill fired.
- **Evals:** `evals/` holds three cases (Hightouch, ZeroClick, and server busy with a mocked
  server). After the staging build, run `claude plugin eval dist/claude-local --mocks record
  --allow-real-servers --allow-tools "mcp__plugin_competitive-analysis_competitive-analysis__*"
  WebFetch WebSearch --no-publish --judge-model sonnet --max-cost-usd 25 --trust-plugin`.
  Runs are isolated from Aaron's plugins and skills and go one at a time (staging's archive
  queue holds three); one pass of the three cases costs about $3, and `--runs 3 --ablation
  with-without` (each case three times, with and without the plugin) about $16 and an hour.
  Results land in `dist/claude-local/evals/results/`, with each run's final message but not
  its tool calls. The traces are written in each run's scaffold folder, which `--keep-temp`
  keeps.
