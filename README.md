# Worry Or Not

A ChatGPT and Codex plugin that produces an evidence-graded teardown of one company.
The method comes from the `competitive-analysis` skill in
[amr05008/agent-skills](https://github.com/amr05008/agent-skills); this repo packages
it for the plugin directory. Claude follows from the same package after the ChatGPT
submission.

## Layout

- `plugin.json`: the portable manifest.
- `skills/worry-or-not/SKILL.md`: the method, written for a model with a browser and
  whatever plugins the user connected.
- `skills/worry-or-not/references/report-template.md`: **generated** by
  `scripts/build.sh` from agent-skills; the report contract has one source.
- `skills/worry-or-not/agents/openai.yaml`: optional tool dependencies.
- `assets/`: icon and logo.
- `LICENSE`: MIT. Ships in the zip.

See `plans/next-steps-2026-10-05.md` for state, open decisions, and remaining tests.

## Before submission

- [x] Fetch test passed in ChatGPT (CDX, raw `id_` capture, Greenhouse and Ashby JSON). 2026-10-05
- [ ] `developerName` matches the verified identity exactly.
- [ ] Privacy and terms pages live at the URLs in `plugin.json`.
- [x] `assets/icon-small.svg` and `assets/logo.png` exist.
- [x] Installed from a local marketplace; "should we worry about ZeroClick" triggers
      the skill without a mention; labels present; pivot dated. Run 2, 2026-10-05.
- [ ] Wayback rerun with the date-lookup method dates the ZeroClick pivot from captures
      (Exa off). Run 5 was inconclusive: archive.org was down.
- [ ] `sh scripts/build.sh` run against a fresh `agent-skills` pull.
- [ ] Zip the repo root (`plugin.json`, `LICENSE`, `skills/`, `assets/`), no `.git`, no `scripts/`.
