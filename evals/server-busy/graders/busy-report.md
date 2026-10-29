---
type: llm
---

The plugin's server answered every call with server_busy ("daily limit reached"). PASS only if all three hold:
1. The teardown still finishes, with one of the four verdicts (compelling, promising but unproven, structurally challenged, unclear) and an evidence table.
2. The coverage gaps name the plugin's server as busy or at its daily limit.
3. Site history and job boards are either checked by the report's own fetches, with what they found, or each fetch that failed is named in the coverage gaps as blocked, with its status or error.
FAIL if the report stops without a verdict, doesn't mention the busy server, or gives site-history dates or job-board facts with no source it could have read.
