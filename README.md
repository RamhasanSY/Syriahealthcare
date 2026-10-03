# Syria Healthcare

A bilingual interface for original healthcare news about Syria and current vacancies at healthcare employers in Syria. Static HTML/CSS/JavaScript hosted on GitHub Pages at https://syriahealthcare.com/.

## How content is selected

The collector uses public publisher feeds and employer listings. It does not use AI to invent, summarize, translate or approve records. Titles retain their original language; the interface is available in English and Arabic. IDA's own English job titles are used when supplied by the employer alongside Arabic feed titles.

News must have a valid publication date within 45 days, evidence of a Syrian location in the headline/article lead, and a healthcare headline (or an explicitly Syrian medical mission). Publisher names and WordPress footers do not count as geographic evidence. Original headlines link to the publisher; medical claims are not independently certified by this site.

Jobs come directly from SAMS recruitment and IDA vacancies. A record needs a published date, an explicit unexpired closing date and a Syrian workplace. Employer-supplied dates and locations are preserved as evidence. Clinical and support roles are distinguished. SAMS uses one shared vacancy board: its individual vacancy reference is displayed so applicants can find the correct posting. Deadline dates are evaluated by UTC date; applicants should check the employer's original announcement for any specific local closing time.

There is no automatic LinkedIn import. LinkedIn, ReliefWeb and UOSSM vacancy pages are external discovery links. ReliefWeb's RSS endpoint returned empty HTTP 202 responses from GitHub runners; its API requires an approved app name. No blocked feeds or unapproved API credentials are used as dependencies.

## Sources and freshness

`sources.json` contains five news feeds (SAMS, UOSSM, IDA, WHO and UN News Health) and two employer integrations (SAMS and IDA). A working source may legitimately have no recent eligible items. Older UOSSM and IDA news is not presented as fresh content.

Each record includes a source ID, original publication date, `verified_at`, and `verification_version: 2`. Legacy records without this provenance are removed even when a collection fails. Unknown dates are never guessed. Duplicates are removed by URL and matching title/location/employer.

A successful employer collection replaces that employer's previous snapshot, removing withdrawn listings. During a source outage, only previously checked, unexpired jobs remain for up to 72 hours after verification. News remains for at most 45 days from original publication. The browser independently excludes old, undated or unverified records and refreshes loaded feeds every 15 minutes.

`data/status.json` records each source's availability, checked time and accepted count. The website displays availability and clearly distinguishes an unavailable source from a reachable source with no matching items. Partial source failures generate workflow warnings; an entire unavailable news or jobs section fails the run. Valid data from reachable sources is still saved.

## Automation and deployment

`.github/workflows/update.yml` runs at 06:00 and 18:00 UTC, and supports manual dispatch. GitHub can delay scheduled jobs. No API keys, model subscription or paid automation service is required. Existing unrelated secrets are not read or modified.

The updater runs source requests with bounded retries and timeouts, atomically writes the content/status JSON, commits changes, rebases over concurrent repository changes, and pushes them to `main`.

`.github/workflows/deploy.yml` validates code, then deploys on a main-branch push and after an update run completes. The existing CNAME preserves `syriahealthcare.com`. Pages must use GitHub Actions as its deployment source.

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

Browser checks cover desktop/mobile layouts, English/Arabic navigation, search, filters, expiration, rejected legacy records, safe links, retry behavior and restricted local storage. Screenshots are saved to ignored `.preview/`.

Run `python scripts/update.py` to collect content locally. It writes public JSON files and makes no Git commits itself.

## Personal editorial note

Edit `data/editor.json`, set `enabled` to `true`, and provide the English/Arabic title and body. An optional link may be included. The collector never overwrites your note. Keep editorial statements distinct from automated source listings.
