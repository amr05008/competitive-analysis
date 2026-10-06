# Worry Or Not (working name) — repo notes for agents

A skills-only ChatGPT/Codex plugin that packages the `competitive-analysis` method.
The name is provisional; see `plans/next-steps-2026-10-05.md` before changing anything
named "worry-or-not".

## Where things live

- This checkout is at `~/.codex/plugins/worry-or-not` **on purpose**: the ChatGPT desktop
  app's personal marketplace (`~/.agents/plugins/marketplace.json`) resolves plugin paths
  relative to the home folder and will not follow symlinks. `~/repos/worry-or-not` is a
  symlink here. Do not move the directory without updating `marketplace.json`.
- The method's source of truth is the `competitive-analysis` skill in the private
  `claude-channels` repo, mirrored publicly to `amr05008/agent-skills`.
  `skills/worry-or-not/references/report-template.md` is **generated** by
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

## Test loop

1. Edit `skills/worry-or-not/SKILL.md`.
2. Quit the ChatGPT desktop app (Cmd+Q), reopen, Plugins → "Aaron's local plugins" →
   reinstall if offered.
3. New chat, no @-mention: `Should we worry about ZeroClick? zeroclick.ai`
4. Score against `plans/next-steps-2026-10-05.md` § Scoring, and against the Claude Code
   teardown at `~/repos/vault/projects/teardowns/2026-09-26-zeroclick-teardown.md`.
