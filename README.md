# Syria Healthcare

Static website with news and job openings for Syria's healthcare sector.
Data is collected from public RSS feeds twice a day by a GitHub Actions
workflow, filtered by an LLM, and written back into the repository as JSON.

No server, no database, no hosting bill.

## Layout

```
index.html                    the whole site
assets/style.css              styling
assets/app.js                 reads the JSON files and renders the page
data/news.json                filtered news, written by the workflow
data/jobs.json                filtered vacancies, written by the workflow
sources.json                  the feeds to read — edit this to add sources
scripts/update.py             collection + AI filtering
.github/workflows/update.yml  runs twice daily at 06:00 and 18:00 UTC
CNAME                         custom domain for GitHub Pages
.nojekyll                     tells Pages to serve the files as-is
```

## Setup

1. **Enable Pages** — Settings → Pages → Source: *Deploy from a branch*,
   branch `main`, folder `/ (root)`.
2. **Custom domain** — in the same screen enter `syriahealthcare.com`.
   Then at STRATO set four A records for `@`:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   and a CNAME for `www` pointing to `ramadanklah.github.io`.
   Once DNS has propagated, tick **Enforce HTTPS**.
3. **Allow the workflow to push** — Settings → Actions → General →
   Workflow permissions → *Read and write permissions*.
4. **Run it once by hand** — Actions tab → *Update news and jobs* → *Run workflow*.

## Changing the AI provider

By default the workflow uses GitHub Models with the built-in `GITHUB_TOKEN`,
so nothing extra to sign up for. To use another free provider instead, add a
repository secret (Settings → Secrets and variables → Actions):

| Secret | Provider |
|---|---|
| `GROQ_API_KEY` | Groq |
| `GEMINI_API_KEY` | Google AI Studio |

The script prefers Groq, then Gemini, then GitHub Models. With no key at all
it keeps every item unfiltered, which is useful for testing.

## Adding sources

Edit `sources.json`. Use only public RSS or Atom feeds from sites that permit
it — most UN agencies, NGOs and health bodies publish one. Do not add scrapers
for job boards whose terms forbid automated access.

## Running locally

```bash
python scripts/update.py          # no key: keeps everything
python -m http.server 8000        # then open http://localhost:8000
```
