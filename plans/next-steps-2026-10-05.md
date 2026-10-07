# Next steps for the plugin (written 2026-10-05, end of day)

## Sequencing (decided 2026-10-05)

ChatGPT first. Claude is a fast follow after the ChatGPT submission.

1. **Finish ChatGPT:** settle the name, finish the testing below (Exa included), submit.
2. **Bring the same package to Claude:** same repo, same `SKILL.md`, one added manifest.
   See § Claude fast follow.

One package, two hosts, no fork. The method lives in one host-neutral `SKILL.md`. Anything
host-specific lives in that host's manifest: `plugin.json` and `agents/openai.yaml` for
ChatGPT, `.claude-plugin/plugin.json` for Claude. A revision to the skill is one edit that
ships to both.

## State

- **Container decided: skills-only.** ChatGPT's browser fetches the Wayback CDX index, raw
  `id_` captures, and the Greenhouse/Ashby JSON boards directly (test chat:
  https://chatgpt.com/share/6ac44d42-7074-83e9-b90a-36c0db37f98c). No server needed.
- **Identity verification: approved 2026-10-06** as an Individual (solo developer).
  Organization name on platform.openai.com: "Aaron Roy".
- **Two test runs on ZeroClick** through the local marketplace:
  - Run 1 (skill v1): https://chatgpt.com/s/cx_6ac44facde3c8191a8543d6469c100b9 — shape,
    labels, three of four findings right; Wayback and job boards not actually fetched.
  - Run 2 (skill v2): https://chatgpt.com/s/cx_6ac451a848f881919ea8b1886737f616 — Wayback
    ran (pivot bracketed May 20–June 14), boards checked and reported as not found,
    verdict "promising but unproven" vs Claude Code's "structurally challenged".
  - Run 3 / Exa control (reworded skill, no Exa, 2026-10-06):
    https://chatgpt.com/s/cx_6ac5ac6cb16c8191b0ca89c4f6610721 — rewording loaded (Run row
    reads "Codex desktop"). Labels, funding, contradiction and absence work all good; two
    findings Run 2 missed (Stripe MPP as the threat, the Zero buyer index). **Wayback and
    boards blocked:** it went through the in-app browser ("not accessible via this tool",
    `ERR_BLOCKED_BY_CLIENT`) where Run 2 used direct page reads, so the pivot was dated
    only by the July 21 announcement. Verdict "promising but unproven" again. **No Exa
    connect prompt:** `agents/openai.yaml` did not make the app ask to connect Exa.
  - Run 4 / Exa on (same skill, Exa plugin installed, 2026-10-06):
    https://chatgpt.com/s/cx_6ac5ae53335881918abfa41eec0393e6 — still Codex (Run row says
    "Codex"), so Exa is the only change from Run 3. **Our skill ran**; Exa's plugin did not
    take the trigger. **Exa used unprompted** for search and fetch. Its fetch reached the
    boards (all three `CRAWL_NOT_FOUND`, correctly reported as not found) and Wayback, but
    the homepage CDX index timed out twice (`CRAWL_LIVECRAWL_TIMEOUT`), so the pivot again
    went undated by the site. Same verdict, about the same findings as Run 2 (new:
    ActionLayer storefront; dropped: Stripe MPP, Zero index, G2).
  - **Exa answers.** Use it? Optional, not recommended: on ZeroClick it changed neither the
    verdict nor the key findings; its real value was a fetch path the in-app browser
    blocks. Bring your own? Yes: a user-connected Exa was picked up with no change on our
    side, and the skill runs without it (Run 3). Listing copy should mention Exa, since the
    app won't prompt for it. Cost: $0.05 of Exa credit for the whole teardown ($20.00 →
    $19.95).
  - **Wayback is the weak point:** site-dated pivot in 1 of 4 runs (Run 2 only).
  - Run 5 / Wayback fix, Exa off (2026-10-06):
    https://chatgpt.com/s/cx_6ac5b148f8748191a6650b4addd40540 — **tool routing fixed** (Run
    row: "page reads, direct public-page fetches", no browser). **Wayback inconclusive:**
    lookups came back empty, then timeouts and connection resets. Checked from a terminal
    straight after: archive.org was degraded (503 "Temporarily Offline", empty
    `archived_snapshots` after 12 s, 20 s timeouts) where an hour earlier the same calls
    took 1–2 s. The skill handled it as written: retried, recorded the errors, dated the
    pivot by announcement and said the site date was unverified. Boards: Greenhouse and
    Lever 404 (not found); Ashby 403 to the app but 404 from a terminal, so Ashby blocks the
    app's fetcher. New findings: seller terms that put implementation fees and revenue share
    in an order form, against the advertised $0 setup / 5% (a good contradiction catch).
    Note: a degraded archive answers the lookup with an empty result, not an error, so
    "empty" can't be read as "no captures" without a retry.
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
   and the GitHub repo name. One commit, one app restart. Settle it before the Claude
   manifest exists, so that one starts with the final name.
2. **Developer name** must match the verified identity exactly. Verification cleared
   2026-10-06 and the organization name is "Aaron Roy", which is what
   `extensions.com.openai.interface.developerName` already says. Still to confirm: the name
   shown for the verified identity at https://platform.openai.com/plugins (submission
   step 4), in case it uses the legal name from the ID check instead.
3. **Verdict calibration.** Two runs landed one notch softer than the Claude Code run on
   the same facts. Decide whether that's acceptable (two analysts can differ) or whether
   the skill should push harder on "the rail owners give the product away" style reasoning.
   Option: add to the verdict section "structurally challenged applies when the core
   offer is available free or near-free from the platforms it depends on."
4. ~~**Host-neutral wording, before or after the ChatGPT submission.**~~ Decided
   2026-10-05: before. `SKILL.md` no longer assumes ChatGPT: the run table names "the app
   you are running in", sharing is "a shareable page if this app offers one (a Site in
   ChatGPT)" in both places it appeared, the Wayback endpoints line says it was verified
   from ChatGPT, and the search tools line says "plugin or connector". Neither host is
   named except as that one example. The submitted version is the shared one, so the
   Claude port doesn't cost a second ChatGPT review. **Still to do:** rerun ZeroClick
   once on ChatGPT to confirm the rewording changed nothing.

## Testing still to do

- **Exa (question 3 of the plan).** Two questions:
  1. *Should we use it?* Install Exa's plugin in the app, sign in to Exa with the personal
     account (auto-recharge off, $20 ceiling), rerun ZeroClick, and compare with run 2.
     Does the skill call Exa's tools unprompted? Did `agents/openai.yaml` cause a connect
     prompt? Is the report enough better to recommend Exa in the listing, or only mention
     it as optional?
  2. *Can users bring their own Exa to extend the plugin?* Here "bring your own key" means
     each user connects their own Exa account through Exa's plugin, and the skill uses
     it. A skills-only plugin has no settings field, ChatGPT plugin settings have no
     secret type, and we never ship or handle a key. Confirm the skill picks up a
     user-connected Exa with no change on our side, and still runs and states the gap
     without one. The answer carries to Claude, where Exa is a connector the user
     connects from the plugin's Connectors tab.
- **Wayback fix (written 2026-10-06, needs a rerun).** Run 3 sent Wayback and the boards
  through the in-app browser, which blocked them; Run 4's CDX query timed out. Timed from a
  terminal: CDX 6–12 s, the availability API 1–2 s, an `id_` capture under 1 s. `SKILL.md`
  now (a) dates changes by availability-API lookups about three months apart, then halves
  the interval that changed, with CDX optional and tried at most once; (b) says to fetch
  with a fetch or page-read tool, not the in-app browser, and to try another tool before
  recording a gap. Seven lookups from the terminal bracketed ZeroClick's pivot to May 20–
  June 6 (title "The Ad Platform for AI" → "The OS for Selling to Agents"), tighter than
  Run 2. Test: a one-line fetch of the availability API in Codex, then ZeroClick with Exa
  off (compare with Run 3). If it holds, port it to the Claude Code `competitive-analysis`
  skill and its template, which still start from CDX.
- **One run in a regular ChatGPT chat**, not Codex. Every plugin run so far is a `cx_`
  (Codex) link; the fetch test that passed was a ChatGPT chat. Directory users will mostly
  be in chat, and its fetch tools may differ. Run 4 was meant to be a chat run but still
  reports Codex. A chat run's share link is `chatgpt.com/share/...`, not `/s/cx_...`. If a
  locally installed plugin only loads in Codex, this test waits until after submission.
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
3. Zip the repo root: `plugin.json`, `LICENSE`, `skills/`, `assets/`. No `.git`, `scripts/`,
   `plans/`, `CLAUDE.md`.
4. https://platform.openai.com/plugins → Upload new or existing plugin → Skills only →
   choose the verified developer identity → upload the ZIP → fix any automated checks →
   fill listing fields (display name ≤30, subtitle ≤30, description ≤4000, category,
   capabilities, screenshots optional) → submit.
5. Flip the repo to public and push the site pages to production in the same hour.
6. Then stop watching ChatGPT. Discovery is broken platform-wide and there are no
   analytics. Start § Claude fast follow.

## Claude fast follow (after the ChatGPT submission)

Researched 2026-10-05 against claude.com/docs. Why it's worth doing:

- One plugin format across claude.ai chat (web, desktop, mobile), Cowork, and Claude Code.
  A user installs once and it's saved to their account.
- Self-serve directory: anyone on Pro, Max, Team or Enterprise submits at
  https://claude.ai/directory/manage. A person reviews each new listing; every version gets
  automated validation and a security scan.
- A Usage tab with installs, runs per skill, and error rates. ChatGPT has no analytics, so
  this is where "did anyone use it" gets answered.
- The closest competitors already live there: Firecrawl `competitive-intel` and Anthropic
  `competitive-intelligence` (landscape plan § 5). Neither does Wayback history or per-claim
  labels.

Carries over unchanged: `skills/worry-or-not/` (Agent Skills format, which both hosts read),
`assets/`, the generated report template.

1. **Fetch test first, in claude.ai chat.** The same test that settled the container on
   ChatGPT: can chat open the CDX index, a raw `id_` capture, and the Greenhouse/Ashby JSON
   URLs the skill builds itself? Claude's web fetch has in the past opened only URLs that
   came from the user or a search result. If chat can't, decide whether a stated coverage
   gap in chat is acceptable or whether the listing steers people to Cowork or Claude Code.
2. **Add `.claude-plugin/plugin.json`** next to the root `plugin.json`. Only `name` is
   required; mirror version, description, author, homepage, repository, license, keywords.
   Reference Exa's MCP server as a connector with no key in it, after checking how Exa
   authenticates on Claude (account sign-in or a key the user enters). The directory's
   required `LICENSE` is already in place (MIT, added 2026-10-05). Run
   `claude plugin validate .`.
3. **Local test.** Customize > Plugins > Add > Upload plugin, as a zip of the repo. Run the
   same ZeroClick prompt and score it on the same rubric.
4. **Submit** at https://claude.ai/directory/manage → Submit new → Plugin bundle. Submit
   from the account that should own the listing long term: the first organization to
   submit a repo folder holds that listing. The repo must be public before the listing goes
   live; it already will be after ChatGPT step 5.
5. **Revisions once both are live:** edit `SKILL.md` once. Claude's directory picks up
   merges to the tracked branch, rescans, and serves them. ChatGPT takes a new upload.

Optional: `claude plugin eval` runs a scored prompt suite against a plugin. It might replace
the manual ZeroClick scoring for both hosts. Untried.

Separate and small: `amr05008/agent-skills` has no `.claude-plugin/marketplace.json`, so
Claude Code users install by clone and symlink script. Adding one (through the publish
script, since that repo is generated) makes it `/plugin marketplace add amr05008/agent-skills`.

## The write-up (the real deliverable)

Four answers: did it list and what did submission require; did the method survive the
host model (baseline vs plugin runs above); does a skill drive Exa's plugin; can the
browser reach Wayback and the boards. Teach-and-hand-over mode; the repo is the give.
