# Next steps for the plugin (written 2026-10-05, end of day)

## Pick up here (updated 2026-10-06, end of night)

Close to submittable. In order; items 1–3 block the ChatGPT submission.

1. ~~**Wayback rerun, combined with rename step 17.**~~ Done 2026-10-11, Runs 6–7 (see
   State): new phrasings trigger, the renamed plugin installs and fires, the pivot is dated
   from captures. Brackets stayed wide because the archive refused connections mid-run; the
   pacing rule added after it is untested and rides on the Vercel run (Testing).
   Original text: First check archive.org is up: open
   `https://web.archive.org/web/20260601id_/https://zeroclick.ai/` in a browser; a page
   within a couple of seconds means go. Then reinstall the plugin, new Codex chat, Exa off,
   `Should we worry about ZeroClick? zeroclick.ai`. Pass: the `teardown` skill fires, and
   the pivot is bracketed from captures (terminal fetches put it at May 20–June 6). Fail
   with the archive up means the app's fetch tool: bring the exact error. If you take
   decision 5's connector rewrite, make it before this run so one rerun covers both.
2. **Rename** to Competitive Analysis (decision 1, decided 2026-10-11): § Rename checklist.
3. **Developer name** at the upload screen (decision 2), then the remaining submission
   steps: site pages deployed, `build.sh`, zip, upload.
4. **Decide 3 and 5** (verdict calibration; what makes this stronger than default skills).
   Neither blocks the submission.
5. **Remaining tests** under Testing still to do.
6. **Claude fast follow** once ChatGPT is submitted.

## Rename checklist (written 2026-10-11)

Plugin "Competitive Analysis", plugin id `competitive-analysis`, skill id `teardown`. The
private `competitive-analysis` skill doesn't change. The icon and logo have no wordmark, so
they stay. Nothing outside this repo, the site branch, `marketplace.json` and the
`~/repos` symlink uses the old name (checked `claude-channels`, the vault, `~/.agents`).
Plans and session logs keep the old name as history.

Order matters: a Claude Code session started here runs inside
`~/.codex/plugins/worry-or-not`, so the directory move (D) goes last, at the end of a
session, and the next session starts from the new path.

**A. This repo (one commit)** — done 2026-10-11

1. `plugin.json`: `name` → `competitive-analysis`; `displayName` → `Competitive Analysis`;
   `homepage` and `websiteURL` → `https://aaronroy.com/competitive-analysis/`;
   `privacyPolicyURL` and `termsOfServiceURL` → `…/competitive-analysis/privacy/` and
   `…/terms/`; `repository` → `https://github.com/amr05008/competitive-analysis`. Leave
   `shortDescription` and `longDescription` for the listing-copy step.
2. `git mv skills/worry-or-not skills/teardown`. In `SKILL.md`: frontmatter `name: teardown`,
   H1 `# Teardown`. "Should we worry about" stays in the description and body: it's a
   trigger phrase, not the name.
3. `scripts/build.sh`: output path → `skills/teardown/references/report-template.md`. Run it;
   expect no diff.
4. `README.md`: title, and the three `skills/worry-or-not/` paths.
5. `CLAUDE.md`: title (drop "working name"), the "named worry-or-not" line, the test loop's
   `skills/teardown/SKILL.md`, and the paths `~/.codex/plugins/competitive-analysis` and
   `~/repos/competitive-analysis`.
6. This plan: the paths in Pick up here and the Claude section. Commit and push.

**B. GitHub** — done 2026-10-11

7. `gh repo rename competitive-analysis -R amr05008/worry-or-not` (the name was free on
   2026-10-11). GitHub redirects the old URL. Stays private until the submission hour.
8. `git remote set-url origin https://github.com/amr05008/competitive-analysis.git`.

**C. aaronroy.com, branch `worry-or-not-pages`** — done 2026-10-11 (`82de533`; main merged in, 44 smoke tests pass; branch name kept)

9. Bring the branch up to date with `main`, which has moved since the branch was cut.
10. `git mv src/pages/worry-or-not src/pages/competitive-analysis`. Replace "Worry Or Not" in
    the titles, H1s, body copy and both `mailto:` subjects. The index page's "the
    competitive-analysis skill I run in Claude Code" now reads like the plugin's own name;
    reword it (e.g. "my private version of this skill").
11. Links: `/worry-or-not/privacy/` and `/terms/` in `index.astro` → `/competitive-analysis/…`;
    the terms page's `https://github.com/amr05008/worry-or-not` → the new repo URL.
12. `astro.config.mjs`: the three `/worry-or-not/` URLs in `LASTMOD_EXEMPT` and the noindex
    list.
13. Don't merge yet. The pages go live with the repo flip, just before upload (Submission
    steps).

**D. This machine (last, at the end of a session)** — 14–16 done 2026-10-11; 17–18 next

14. In the app: uninstall the Worry Or Not plugin, then quit (Cmd+Q).
15. `mv ~/.codex/plugins/worry-or-not ~/.codex/plugins/competitive-analysis`;
    `rm ~/repos/worry-or-not`;
    `ln -s ~/.codex/plugins/competitive-analysis ~/repos/competitive-analysis`.
16. `~/.agents/plugins/marketplace.json`: the plugin's `name` → `competitive-analysis`, its
    `path` → `./.codex/plugins/competitive-analysis`.
17. Reopen the app → Plugins → "Aaron's local plugins" → install Competitive Analysis. Run the
    ZeroClick prompt once: the report should look the same, and the skill that fires should
    be `teardown`, not the private `competitive-analysis`.
18. Start the next Claude Code session from `~/.codex/plugins/competitive-analysis`. Its
    history starts fresh; earlier sessions stay under the old path.

**E. Before upload**

19. Search the app's Plugins directory for "Competitive Analysis".

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
  - Runs 6–7 (renamed plugin, new description, dated-fetch Wayback, Exa off, private skill
    parked, 2026-10-11). Run 6, `Competitive analysis of ZeroClick, zeroclick.ai`:
    https://chatgpt.com/s/cx_6acbc98a4e44819193310d5d9b0aaebe — Run 7, `Teardown of
    ZeroClick and its landing page`:
    https://chatgpt.com/s/cx_6acbc9b638c48191933cd9dff261624a. **Run 7 triggered without a
    mention; Run 6's prompt began with "@Competitive Analysis"**, so the "competitive
    analysis of X" phrasing is still untested as a trigger. **Pivot dated from captures in both** (VERIFIED ad-network captures Oct 13,
    2025 / Jan 19, 2026 against a June 14 agent-commerce capture, and the catch that the
    site changed before the July 21 announcement), but the brackets stayed wide: several
    archive fetches got "connection refused", most likely the archive's rate limit on the
    app's fetcher after a burst of requests. The availability lookup came back empty, as in
    the terminal. Run 7 added a landing-page critique table on top of the teardown; Run 6
    caught that the domain belonged to a different business in July 2025 and kept it out.
    Boards: 404s (Ashby 403 in Run 6). Verdict "promising but unproven" in both (decision 3).
    Follow-up: `SKILL.md` now spaces probes six months apart, fetches archive URLs one at a
    time, caps them near ten, and treats "connection refused" as the rate limit (stop
    narrowing, report the bracket). Untested.
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

1. **Name.** Decided 2026-10-11: **Competitive Analysis** (plugin id `competitive-analysis`).
   It's how people search, and it matches the plain names in `openai/plugins`. The subtitle
   carries the differentiator. Skill id inside the plugin: **`teardown`** (decided
   2026-10-11). It keeps clear of the private `competitive-analysis` skill, which stays as it
   is so `/competitive-analysis` keeps opening the richer private version; in Claude the
   plugin's skill reads `/competitive-analysis:teardown`. Steps: § Rename checklist. Do it
   before the Claude manifest exists, so that one starts with the final name.
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
   Claude port doesn't cost a second ChatGPT review. Confirmed by Run 3: the reworded
   skill loaded and the report kept its shape.
5. **What makes this stronger than default competitive-analysis skills** (raised
   2026-10-06; proposed, not decided).
   - **Connectors: one generic rule, not vendor branches.** Rewrite the Tools section as
     capability slots: search and page text (Exa, Firecrawl); company data such as
     headcount history and funding (Clay, Harmonic, Crunchbase); community sentiment (Monid
     or any Reddit connector). Use whatever connected tool fills a slot, name it in the Run
     row, never require one, company data only (no people, no contacts). Why not more:
     Exa cost $0.05 and added no findings on ZeroClick; most directory users will connect
     nothing; Monid isn't in the ChatGPT directory. The one connector signal with proven
     value is headcount history: the Claude Code teardown's 35 → 24 drop (Clay) lined up
     with the pivot.
   - **The strength is the free methods firing on default tools, plus a verdict that takes
     a position.** Wayback dated the pivot in 1 of 4 runs so far, and three plugin runs
     hedged to "promising but unproven" where the Claude Code teardown said "structurally
     challenged" on the same facts (decision 3). Hedging to the middle is what a default
     skill does.
   - **Prove it head to head** rather than guess: run the two leading Claude skills
     (Firecrawl `competitive-intel`, Anthropic `competitive-intelligence`) and this one on
     ZeroClick plus a company with a public board, scored on the same rubric (§ Scoring).
     That answers "strong enough?" with evidence and is write-up material.
   - **Sequencing:** none of this blocks the ChatGPT submission, which has no analytics and
     broken discovery. Do the head-to-head before the Claude launch, where those competitors
     and the usage numbers are.
   - Checked 2026-10-06 and set aside: SEC Form D filings as a free funding source. EDGAR
     returns 403 to a request without a declared User-Agent, and the apps' fetch tools
     probably can't set one (untested in the app).
   - Default: capability slots go into v1 (small wording change, rides the Wayback rerun);
     head-to-head before the Claude launch.

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
- **Wayback fix, revised 2026-10-11 (needs the rerun).** The availability API turned out
  unreliable: on 2026-10-11 it returned an empty `archived_snapshots` for zeroclick.ai on
  every form tried (apex, www, https), while answering for vercel.com and linear.app, and
  while the captures plainly existed. A dated `id_` fetch
  (`/web/<YYYYMMDD>id_/https://<domain>/`) redirected to the nearest capture in 0.3–0.5 s
  with the timestamp in the redirect URL, matching the 2026-10-06 lookups exactly. `SKILL.md`
  now fetches by date first; the lookup is a fallback for tools that hide the final URL.
- **Wayback fix (written 2026-10-06, superseded above).** Run 3 sent Wayback and the boards
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
  real. Use Vercel (Greenhouse): Ashby has answered the app's fetcher with 403. This run
  also tests the Wayback pacing rule on a site with a long archive. Candidates with public boards verified today: Vercel (Greenhouse), Linear (Ashby),
  Ramp (Ashby).
- **Strategic-direction mode:** one run with a specific page URL as the subject.
- **Trigger test** ("teardown of X and its landing page" passed in Run 7; "competitive
  analysis of X" still to do without the @-mention). Description rewritten 2026-10-11 to lead with the ways people ask
  ("analyze this company", "teardown of X", "competitive analysis of X", "research this
  competitor"; "should we worry" is now one example), plus a not-for line (stock picks,
  investment advice, financial statements, people). Check each phrase fires `teardown`
  without a mention, and that "analyze Apple's 10-K" does not. On this machine, park the
  private skill first (`mv ~/.agents/skills/competitive-analysis
  ~/.agents/competitive-analysis.parked`, and back afterwards): its description overlaps,
  and the app reads `~/.agents/skills`.
- **Listing copy still says "worry":** `longDescription` in `plugin.json` ("Ask whether to
  worry about a company") and the site page ("Ask it 'should we worry about company?'").
  Reword in the listing-copy step.
- **Length and truncation** of the full report on request.
- **Directory collision check:** search the Plugins directory in the app for the chosen
  name before submitting.

## Scoring

Record per run: share link, Exa on or off, the app named in the Run row, which skill fired.

Checklist (from `claude-channels/plans/worry-or-not-2026-10-05.md` step 5, extended):

- Triggers without an @-mention, and it's this skill (run table + evidence key + three-way
  coverage gaps), not the Claude Code `competitive-analysis` skill or a connector's own.
- A label on every material claim.
- Pivot dated by site captures, not only by the announcement.
- Funding present; hiring present, or the boards correctly reported as not found / blocked
  with the status.
- Connected tools used and named in the Run row.
- Coverage gaps split into not found / blocked / no connector, with exact errors.

Reference: the Claude Code teardown,
`~/repos/vault/projects/teardowns/2026-09-26-zeroclick-teardown.md`. Verdict "structurally
challenged"; pivot May–June 2026 (terminal lookups 2026-10-06: May 20–June 6); $55M raised
(COMPANY-CLAIMED); Sleek post rewritten under its original date (Wayback); headcount 35 →
24 (Clay, which the plugin doesn't have).

Reading share links: `chatgpt.com/s/cx_...` returns 403 to WebFetch and curl. Open it in
Chrome (Claude in Chrome) and read the page text.
Share links are public to anyone with the URL, signed in or not, and archiving the chat
doesn't change that (checked 2026-10-11 from a signed-out browser on Runs 6 and 7). Check
the prompt line at the top of a shared run for an "@" before scoring it as a trigger test.
**All share links were deleted 2026-10-11** (checked signed-out: Runs 2, 6, 7 and the
baseline all return "not found"). Every share URL in this plan is now dead; the chats
themselves stay in the app's history. Re-share only what the write-up needs (the no-plugin
baseline is its "before" picture). From now on, paste report text into the session instead
of sharing, especially for Manychat runs.

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

Carries over unchanged: `skills/teardown/` (Agent Skills format, which both hosts read),
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
