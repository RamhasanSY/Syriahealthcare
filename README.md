# Syria Healthcare

A bilingual interface for original healthcare news about Syria and current healthcare and NGO vacancies in Syria. Static HTML/CSS/JavaScript hosted on GitHub Pages at https://syriahealthcare.com/.

## How content is selected

The collector uses public publisher feeds and employer listings. It does not use AI to invent, summarize, translate or approve records. Titles retain their original language; the interface is available in English and Arabic. IDA's own English job titles are used when supplied by the employer alongside Arabic feed titles.

News must have a valid publication date within 45 days, evidence of a Syrian location in the headline/article lead, and a healthcare headline (or an explicitly Syrian medical mission). Publisher names and WordPress footers do not count as geographic evidence. Original headlines link to the publisher; medical claims are not independently certified by this site.

Jobs come directly from SAMS recruitment, IDA vacancies, NRC's public Webcruiter listings and DRC's public careers page. A record needs a published date, an explicit unexpired closing date and a Syrian workplace. Employer-supplied dates and locations are preserved as evidence. Clinical and support roles are distinguished. SAMS uses one shared vacancy board: its individual vacancy reference is displayed so applicants can find the correct posting. Exact closing timestamps are respected when supplied; date-only deadlines are evaluated by UTC date; applicants should check the employer's original announcement for any specific local closing time.

There is no automatic LinkedIn import. LinkedIn, ReliefWeb and UOSSM vacancy pages are external discovery links. ReliefWeb's RSS endpoint returned empty HTTP 202 responses from GitHub runners; its API requires an approved app name. No blocked feeds or unapproved API credentials are used as dependencies.

## Sources and freshness

`sources.json` contains five news feeds (SAMS, UOSSM, IDA, WHO and UN News Health) and four employer integrations (SAMS, IDA, NRC and DRC). A working source may legitimately have no recent eligible items. Older UOSSM and IDA news is not presented as fresh content.

Each record includes a source ID, original publication date, `verified_at`, and `verification_version: 2`. Legacy records without this provenance are removed even when a collection fails. Unknown dates are never guessed. Duplicates are removed by URL and matching title/location/employer.

A successful employer collection replaces that employer's previous snapshot, removing withdrawn listings. During a source outage, only previously checked, unexpired jobs remain for up to 72 hours after verification. News remains for at most 45 days from original publication. The browser independently excludes old, undated or unverified records and refreshes loaded feeds every 15 minutes. It also removes expired loaded records once per minute, rejects impossible calendar dates and future verification timestamps beyond a one-hour clock tolerance, and sorts exact deadlines by their closing time. Date-only deadlines remain open through the UTC date; exact closing times appear with a UTC label.

Browser requests time out after 15 seconds. Failed background refreshes retain eligible loaded results and display a visible warning. Refreshing filters preserves keyboard focus; unavailable local storage uses temporary bookmarks with an explicit session-only notice. Feed and individual source checks show their UTC check time.

`data/status.json` records each source's availability, checked time and accepted count. The website displays availability and clearly distinguishes an unavailable source from a reachable source with no matching items. Partial source failures generate workflow warnings; an entire unavailable news or jobs section fails the run. Valid data from reachable sources is still saved.

## Automation and deployment

`.github/workflows/update.yml` runs at 06:00 and 18:00 UTC, and supports manual dispatch. GitHub can delay scheduled jobs. No API keys, model subscription or paid automation service is required. Existing unrelated secrets are not read or modified.

The updater runs source requests with bounded retries and timeouts, atomically writes the content/status JSON, commits changes, rebases over concurrent repository changes, and pushes them to `main`.

`.github/workflows/deploy.yml` validates code, then deploys on a main-branch push and after an update run completes. Each run attempt uses a unique Pages artifact name so rerunning a failed deployment cannot select duplicate artifacts. The existing CNAME preserves `syriahealthcare.com`. Pages must use GitHub Actions as its deployment source.

For failed-run notifications, enable GitHub Actions notifications in your own GitHub account. Detailed source results appear in each update run's summary and on the website's source list.

## Preview and tests

```sh
python -m http.server 8000
python -m unittest discover -s tests -p 'test_*.py'
node --check assets/app.js
```

Optional browser checks, with the server running:

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser_check.py
```

Browser checks cover desktop/mobile layouts, English/Arabic navigation, search, healthcare/NGO and organization filters, exact deadline sorting, saved-job persistence, expiration, invalid verification records, safe links, retry behavior, background refresh failures, stalled request timeouts, keyboard focus, directory-note containment and restricted local storage. Screenshots are saved to ignored `.preview/`.

The site uses a jasmine and courtyard arch SVG logo and a simplified matching favicon. Canonical and social metadata point to the production domain. `assets/social-card.png` is the 1200 × 630 sharing image; its editable template is `scripts/social-card.html`. To regenerate it, serve the repository, open that template in a browser at 1200 × 630 with device scale 1, and save a viewport screenshot over the PNG.

Run `python scripts/update.py` to collect content locally. It writes public JSON files and makes no Git commits itself.

## Personal editorial note

Edit `data/editor.json`, set `enabled` to `true`, and provide the English/Arabic title and body. An optional link may be included. The collector never overwrites your note. Keep editorial statements distinct from automated source listings.

## Job discovery

The job board supports keyword search, location and organization filters, healthcare/NGO categories, newest/deadline sorting and bookmarks saved on the visitor's device. Bookmarks require no account. Only eligible vacancies appear; a working integration with no matching Syria jobs stays visible in source status. LinkedIn searches remain clearly marked external discovery links.

## LinkedIn publishing

The public RSS feed at https://syriahealthcare.com/data/news.xml is rebuilt with each collection. It contains original headlines, publisher attribution, original article links, publication dates and stable URL identifiers. Refreshing source verification does not create a new feed item. No full article text is republished.

A Page administrator can connect LinkedIn to Zapier using its sign-in authorization, then configure RSS by Zapier (New Item in Feed) to LinkedIn (Create Company Update). Map the title and description to the post text and the item link to its article URL. Enable only new items after setup; do not bulk-publish the existing archive. Test with a draft/sample before enabling publishing. This repository does not hold a LinkedIn password or token and no LinkedIn publishing connection is currently configured. Page creation and account authorization must be completed by the account owner.

This publishing connection does not grant access to search or import LinkedIn jobs. See linkedin-setup.txt for Page copy and setup instructions.
