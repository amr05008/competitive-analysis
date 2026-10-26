# Competitive Analysis

Competitive Analysis turns "competitive analysis of <company>" into an evidence-graded teardown. It dates when a company's homepage and pricing changed from Wayback Machine captures, reads its public job board for what it's actually building, counts Hacker News discussion by year, and checks SEC EDGAR for Form D fundraising notices. Every claim comes back with a link, a date and a VERIFIED, COMPANY-CLAIMED or ESTIMATE label, and the report ends with one of four verdicts: compelling, promising but unproven, structurally challenged, or unclear.

## Try it

- `Competitive analysis of <company>`
- `Should we worry about <company>? <domain>`
- `What does this pricing page signal? <url>`

It researches companies, not people: no contact lookups and no enrichment of anyone.

## What it sends and fetches

The plugin is one skill plus one connector, its own server at `https://competitive-analysis.aaronmichaelroy.com/mcp`. No sign-in, no keys.

- **What the server receives:** only the page addresses, company names and domains a teardown asks about.
- **What it reads:** free public sources only. That's the Wayback Machine (web.archive.org), the Greenhouse, Lever and Ashby job-board APIs and the company's own careers page, Hacker News search (hn.algolia.com), and SEC EDGAR.
- **How archive requests travel:** the Wayback Machine rate-limits the network the server runs on, so its archive requests go through a small relay I run on Vercel. The relay logs nothing.
- **What it keeps:** cached copies of the public pages it read, so a repeat call is quick, and a daily count of calls by tool and outcome. It keeps no personal data and doesn't log what you ask. A daily self-check on fixed test companies reports failures and a weekly count of calls to me.
- **On your side:** the skill also has Claude read public web pages with its own web tools.

The server's code is public in [`server/`](https://github.com/amr05008/competitive-analysis/tree/main/server) and the relay's in [`relay/`](https://github.com/amr05008/competitive-analysis/tree/main/relay). Neither runs on your machine.

- Privacy: https://aaronroy.com/competitive-analysis/privacy/
- Support: https://aaronroy.com/competitive-analysis/#support

## License

MIT. See [LICENSE](LICENSE).
