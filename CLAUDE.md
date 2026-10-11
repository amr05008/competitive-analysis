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

## Test loop

1. Edit `skills/teardown/SKILL.md`.
2. Quit the ChatGPT desktop app (Cmd+Q), reopen, Plugins → "Aaron's local plugins" →
   reinstall if offered.
3. New chat, no @-mention: `Should we worry about ZeroClick? zeroclick.ai`. Runs so far are
   Codex chats in the app (share links `chatgpt.com/s/cx_...`). Note whether Exa is on.
4. Score against `plans/next-steps-2026-10-05.md` § Scoring, which also covers the Claude
   Code reference teardown and how to read share links (Chrome; WebFetch gets 403).
