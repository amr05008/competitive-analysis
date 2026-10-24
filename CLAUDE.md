# Competitive Analysis — repo notes for agents

A skills-only ChatGPT/Codex plugin: **Competitive Analysis**, plugin id
`competitive-analysis`, one skill with id `teardown`. It packages the method of Aaron's
private `competitive-analysis` skill. The two are separate skills, and the private one keeps
its name, so `/competitive-analysis` on Aaron's machines still opens the private version.
Claude is the fast follow: the same package with one added manifest, after the ChatGPT
submission. Start at § Pick up here in `plans/next-steps-2026-10-05.md`. Formerly "Worry Or
Not" (renamed 2026-10-11); plans and session logs keep the old name as history.

## Where things live

- This checkout is at `~/.codex/plugins/competitive-analysis` **on purpose**: the ChatGPT
  desktop app's personal marketplace (`~/.agents/plugins/marketplace.json`) resolves plugin
  paths relative to the home folder and will not follow symlinks.
  `~/repos/competitive-analysis` is a symlink here. Do not move the directory without
  updating `marketplace.json`.
- The method's source of truth is the `competitive-analysis` skill in the private
  `claude-channels` repo, mirrored publicly to `amr05008/agent-skills`.
  `skills/teardown/references/report-template.md` is **generated** by
  `scripts/build.sh` from the agent-skills checkout. Never edit it here.
- The store listing's source is `listing/competitive-analysis-listing.md`: version, name,
  subtitle, category and prompts in its frontmatter, the description and release notes in its
  body. `scripts/build.sh` (via `scripts/listing.py`) copies them into `plugin.json`, checks
  the directory's limits, the plugin id and vendor names in `skills/`, and zips the package
  into `dist/`. Never hand-edit `version`, `displayName`, `shortDescription`,
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

1. Edit `skills/teardown/SKILL.md`.
2. Quit the ChatGPT desktop app (Cmd+Q), reopen, Plugins → "Aaron's local plugins" →
   reinstall if offered.
3. New chat, no @-mention: `Should we worry about ZeroClick? zeroclick.ai`. Runs so far are
   Codex chats in the app (share links `chatgpt.com/s/cx_...`). Note whether Exa is on.
4. Score against `plans/next-steps-2026-10-05.md` § Scoring, which also covers the Claude
   Code reference teardown and how to read share links (Chrome; WebFetch gets 403).
