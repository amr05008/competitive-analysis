# Next steps for the plugin (written 2026-10-05, end of day)

## State

- **Container decided: skills-only.** ChatGPT's browser fetches the Wayback CDX index, raw
  `id_` captures, and the Greenhouse/Ashby JSON boards directly (test chat:
  https://chatgpt.com/share/6ac44d42-7074-83e9-b90a-36c0db37f98c). No server needed.
- **Identity verification:** Persona done 2026-10-05, OpenAI shows "Identity in review".
- **Two test runs on ZeroClick** through the local marketplace:
  - Run 1 (skill v1): https://chatgpt.com/s/cx_6ac44facde3c8191a8543d6469c100b9 — shape,
    labels, three of four findings right; Wayback and job boards not actually fetched.
  - Run 2 (skill v2): https://chatgpt.com/s/cx_6ac451a848f881919ea8b1886737f616 — Wayback
    ran (pivot bracketed May 20–June 14), boards checked and reported as not found,
    verdict "promising but unproven" vs Claude Code's "structurally challenged".
  - A stray run used the Claude Code skill via Codex (the app reads `~/.agents/skills`):
    https://chatgpt.com/s/cx_6ac4516b7ca48191af87beebdcaf0720. Same trigger phrase; the
    plugin still won on the explicit prompt. Keep in mind when testing.
- **Baseline without any plugin** (the "before" picture for the write-up):
  https://chatgpt.com/share/6ac44259-1c70-83ea-96a0-ace52b43e4c1 — opposite verdict,
  no labels, missed the pivot, treated the old ad business as a "separate offering".
- **Site pages** drafted on aaronroy.com (project, privacy, terms) on branch
  `worry-or-not-pages`, not on production. They name the plugin and link this repo.
- Repo is **private** until the name is settled.

## Open decisions

1. **Name.** "Worry Or Not" is provisional. Renaming touches: `plugin.json` (`name`,
   `displayName`), `skills/<dir>/` and its frontmatter `name`, `~/.agents/plugins/marketplace.json`,
   this directory's path (and the symlink), the three aaronroy.com pages and their URLs,
   and the GitHub repo name. One commit, one app restart.
2. **Developer name** must match the verified identity exactly. Read it off
   https://platform.openai.com/plugins once verification clears and set
   `extensions.com.openai.interface.developerName`.
3. **Verdict calibration.** Two runs landed one notch softer than the Claude Code run on
   the same facts. Decide whether that's acceptable (two analysts can differ) or whether
   the skill should push harder on "the rail owners give the product away" style reasoning.
   Option: add to the verdict section "structurally challenged applies when the core
   offer is available free or near-free from the platforms it depends on."

## Testing still to do

- **Exa composition (question 3 of the plan).** Install Exa's plugin in the app, sign in to
  Exa with the personal account (auto-recharge off, $20 ceiling), rerun ZeroClick, and see
  whether the skill uses Exa's tools unprompted and whether `agents/openai.yaml` caused a
  connect prompt.
- **A second company** with a real job board (Greenhouse or Ashby) so method 2 runs for
  real. Candidates with public boards verified today: Vercel (Greenhouse), Linear (Ashby),
  Ramp (Ashby).
- **Strategic-direction mode:** one run with a specific page URL as the subject.
- **Trigger test:** does "teardown of X" and "competitor research on X" fire the skill
  without a mention?
- **Length and truncation** of the full report on request.
- **Directory collision check:** search the Plugins directory in the app for the chosen
  name before submitting.

## Submission steps (when ready)

1. `sh scripts/build.sh` against a fresh `git -C ~/repos/agent-skills pull`.
2. Final `plugin.json`: name, developer name, URLs resolve (site pages deployed).
3. Zip the repo root: `plugin.json`, `skills/`, `assets/`. No `.git`, `scripts/`, `plans/`,
   `CLAUDE.md`.
4. https://platform.openai.com/plugins → Upload new or existing plugin → Skills only →
   choose the verified developer identity → upload the ZIP → fix any automated checks →
   fill listing fields (display name ≤30, subtitle ≤30, description ≤4000, category,
   capabilities, screenshots optional) → submit.
5. Flip the repo to public and push the site pages to production in the same hour.
6. Then stop watching. Discovery is broken platform-wide and there are no analytics.

## The write-up (the real deliverable)

Four answers: did it list and what did submission require; did the method survive the
host model (baseline vs plugin runs above); does a skill drive Exa's plugin; can the
browser reach Wayback and the boards. Teach-and-hand-over mode; the repo is the give.
