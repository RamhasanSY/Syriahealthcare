# Syria Healthcare

A lightweight bilingual news and opportunities website for Syria's healthcare sector. Static HTML, CSS and JavaScript; no database or application server required.

## Features

- Responsive editorial layout with English/Arabic navigation and right-to-left support.
- Search across both languages, news topic filters and vacancy location filters.
- Original source links, publication dates, confirmed closing dates and independent collection timestamps.
- Accessible loading, empty and failure states, keyboard focus and reduced-motion support.
- Optional editor's note, kept separate from automatically collected content.

## Local preview

Run `python -m http.server 8000`, then open http://localhost:8000.

## Publishing to GitHub Pages

The repository includes `.github/workflows/deploy.yml`. An administrator must enable Pages under **Settings → Pages → Build and deployment → Source: GitHub Actions**. Push to `main` or run **Deploy website** manually. The deployment also runs after **Update news and jobs** completes, because commits made with the built-in Actions token do not themselves trigger push workflows.

The deployment validates the collector and browser script, then uploads only the public website files. The existing CNAME preserves the custom domain syriahealthcare.com.

## Automated collection

`.github/workflows/update.yml` collects public RSS feeds at 06:00 and 18:00 UTC. GitHub schedules may be delayed. It can also be triggered manually.

`sources.json` preserves the existing ReliefWeb Syria, health-specific and SAMS feeds. The previous WHO EMRO URL returned non-feed content, and the OCHA URL returned HTTP 404 when checked during the revamp; both were removed. Original publishing organizations remain available through linked articles.

Provider preference:

1. `GROQ_API_KEY`, if configured as a repository secret.
2. `GEMINI_API_KEY`, if configured.
3. The workflow's `GITHUB_TOKEN`, using GitHub Models with `models: read`.

The repository/account must permit use of the selected provider and model. No credentials or missing/invalid AI decisions cause a failed update, never publication of unfiltered material. Feed and AI failures preserve the previous file and collection timestamp for the affected section. A successful section can still be committed if the other fails; the run remains failed so GitHub can report it. Enable workflow failure notifications in your GitHub notification settings.

The collector deduplicates canonical URLs, drops stories older than 45 days, excludes vacancies after confirmed closing dates, and writes JSON via atomic replacement. Closing dates are extracted from explicit source text, not guessed by AI. The browser also hides expired vacancies between collection runs and flags collection timestamps older than 48 hours.

The revamp includes an initial selection of three relevant stories and two vacancies checked against the public feeds. Future collection remains dependent on the scheduled workflow and AI provider access.

## Add your own voice

Edit `data/editor.json`: set `enabled` to `true`, fill `title_en`, `title_ar`, `body_en` and `body_ar`, and optionally provide an original source `url` with `link_en` and `link_ar`. The section stays hidden until a title and body are supplied. The collector never overwrites this file. English is used when an Arabic field is empty.

## Checks

Collector regression tests (standard library only):

```sh
python -m unittest discover -s tests -p 'test_*.py'
node --check assets/app.js
```

Browser checks (optional local development dependencies):

```sh
python -m pip install playwright
python -m playwright install chromium
python -m http.server 8000
# In another terminal:
python tests/browser_check.py
```

Browser checks use local fixtures for search, filters, deadlines, unsafe links, retry behavior, language persistence and responsive layout. Screenshots go in the ignored `.preview` directory.

## Files

- `index.html`: bilingual page structure.
- `assets/`: styles, browser behavior and favicon.
- `data/news.json`, `data/jobs.json`: published content.
- `data/editor.json`: optional editorial note.
- `sources.json`: configured public feeds.
- `scripts/update.py`: collection and screening.
- `.github/workflows/`: collection and deployment automation.
- `tests/`: collector and browser checks.
