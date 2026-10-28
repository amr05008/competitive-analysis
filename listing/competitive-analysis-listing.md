---
version: 0.2.1
name: Competitive Analysis
subtitle: Research companies and URLs
category: Business & Operations
prompts:
  - Competitive analysis of <company>
  - Tear down this <company> 
  - What does this pricing page signal? <url>
---

The store listing for ChatGPT, and later Claude. Edit the properties above and the two sections below, then run `sh scripts/build.sh`. It copies this into `plugin.json`, refuses anything over the limits, and builds the upload zip.

Limits: name and subtitle 30 characters each, up to 3 prompts of 128 characters, description 4,000. The description goes out as plain text with its line breaks, so check how the dashboard shows it after an upload. Vendor names are fine here and on the site, never in the skill.

## Description

The Competitive Analysis plugin helps founders, product people and business analysts tear down companies and landing pages to understand positioning, product capabilities, and company growth.

How it works:
- You name a company and/or a landing page
- The report dates changes in positioning and pricing from Wayback Machine captures, reads the company's own job listings for what it's actually building, reconciles sources that disagree, and treats silence as evidence.
- The plugin's own server does the fetching a browser struggles with: it finds the captures where a page's copy changed, reads the company's public job board, counts Hacker News discussion by year, and pulls Form D fundraising notices from SEC EDGAR. It only reads free public sources and keeps no personal data. If it's busy, the teardown carries on with ChatGPT's own browsing.
- You get a teardown where every claim carries a link, a date, and a VERIFIED / COMPANY-CLAIMED / ESTIMATE label

This plugin researches companies, not people. To get the most from this plugin, you should have the Clay plugin enabled, but it will also be valuable without that turned on. 

## Release notes

Newest first. Every upload needs a new version above and a matching heading here. The newest one goes out with that version.

### 0.2.1

Competitive Analysis now has its own server. Four read-only tools pull the evidence that browsing alone kept missing: when a company's homepage and pricing copy changed (from Wayback Machine captures), its open roles from a public Greenhouse, Lever or Ashby board, Hacker News discussion by year, and SEC filings, including Form D fundraising notices. The tools only read free public sources, need no sign-in and keep no personal data. If the server is busy or down, the teardown still finishes with the app's own browsing and lists what it couldn't check.

### 0.1.0

Initial release. 
