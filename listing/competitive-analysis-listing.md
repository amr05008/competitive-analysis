---
version: 0.1.0
name: Competitive Analysis
subtitle: Research companies and URLs
category: Research
prompts:
  - Competitive analysis of <company>
  - Tear down this <company> 
  - How has this pricing page changed over time? <url>
---

The store listing for ChatGPT, and later Claude. Edit the properties above and the two sections below, then run `sh scripts/build.sh`. It copies this into `plugin.json`, refuses anything over the limits, and builds the upload zip.

Limits: name and subtitle 30 characters each, up to 3 prompts of 128 characters, description 4,000. The description goes out as plain text with its line breaks, so check how the dashboard shows it after an upload. Vendor names are fine here and on the site, never in the skill.

## Description

The Competitive Analysis plugin helps founders, product people and business analysts tear down companies and landing pages to understand positioning, product capabilities, and company growth.

How it works:
- You name a company and/or a landing page
- The report dates changes in positioning and pricing from Wayback Machine captures, reads the company's own job listings for what it's actually building, reconciles sources that disagree, and treats silence as evidence.
- You get a teardown where every claim carries a link, a date, and a VERIFIED / COMPANY-CLAIMED / ESTIMATE label

This plugin researches companies, not people. To get the most from this plugin, you should have the Clay plugin enabled, but it will also be valuable without that turned on. 

## Release notes

Newest first. Every upload needs a new version above and a matching heading here. The newest one goes out with that version.

### 0.1.0

Initial release. 
