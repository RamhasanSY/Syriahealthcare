#!/usr/bin/env python3
"""
Collect health-sector news and job listings from public RSS feeds,
filter them with an LLM, and write data/news.json and data/jobs.json.

Runs twice a day via .github/workflows/update.yml.

AI provider is picked from environment variables, in this order:
  GITHUB_TOKEN  -> GitHub Models  (no extra signup, works inside Actions)
  GROQ_API_KEY  -> Groq
  GEMINI_API_KEY-> Google AI Studio (OpenAI-compatible endpoint)
If none is set, everything is kept unfiltered and untranslated.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(ROOT, "sources.json")
NEWS_FILE = os.path.join(ROOT, "data", "news.json")
JOBS_FILE = os.path.join(ROOT, "data", "jobs.json")

MAX_NEWS = 60          # how many stories the site keeps
MAX_JOBS = 40
MAX_AGE_DAYS = 45      # drop anything older than this
BATCH = 8              # items per LLM call

TOPICS = ["hospitals", "public-health", "aid", "workforce", "policy", "other"]

USER_AGENT = "SyriaHealthcareBot/1.0 (+https://syriahealthcare.com)"


# --------------------------------------------------------------------------
# Feed reading
# --------------------------------------------------------------------------

def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def strip_html(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = (text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " "))
    return re.sub(r"\s+", " ", text).strip()


def parse_date(raw):
    if not raw:
        return None
    raw = raw.strip()
    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc)
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            d = datetime.strptime(raw, fmt)
            return d.replace(tzinfo=d.tzinfo or timezone.utc).astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def parse_feed(xml_bytes, source_name):
    """Handle both RSS 2.0 and Atom without external dependencies."""
    out = []
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as exc:
        print(f"  ! could not parse feed from {source_name}: {exc}")
        return out

    ns = {"atom": "http://www.w3.org/2005/Atom"}

    entries = root.findall(".//item") or root.findall(".//atom:entry", ns)
    for e in entries:
        def text(tag, atom_tag=None):
            node = e.find(tag)
            if node is None and atom_tag:
                node = e.find(atom_tag, ns)
            return (node.text or "").strip() if node is not None and node.text else ""

        title = text("title", "atom:title")
        link = text("link", None)
        if not link:
            ln = e.find("atom:link", ns)
            if ln is not None:
                link = ln.get("href", "")
        desc = text("description", "atom:summary") or text("content:encoded", "atom:content")
        pub = text("pubDate", "atom:published") or text("dc:date", "atom:updated")

        if not title or not link:
            continue

        out.append({
            "title_en": strip_html(title),
            "url": link.strip(),
            "raw_summary": strip_html(desc)[:900],
            "published": parse_date(pub),
            "source": source_name,
        })
    return out


def collect(feeds):
    items = []
    for f in feeds:
        print(f"  reading {f['name']}")
        try:
            items.extend(parse_feed(fetch(f["url"]), f["name"]))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            print(f"  ! {f['name']} unreachable: {exc}")
        time.sleep(1)
    return items


# --------------------------------------------------------------------------
# LLM filtering
# --------------------------------------------------------------------------

def llm_config():
    if os.environ.get("GROQ_API_KEY"):
        return ("https://api.groq.com/openai/v1/chat/completions",
                os.environ["GROQ_API_KEY"], "llama-3.3-70b-versatile")
    if os.environ.get("GEMINI_API_KEY"):
        return ("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                os.environ["GEMINI_API_KEY"], "gemini-2.0-flash")
    if os.environ.get("GITHUB_TOKEN"):
        return ("https://models.github.ai/inference/chat/completions",
                os.environ["GITHUB_TOKEN"], "openai/gpt-4o-mini")
    return (None, None, None)


NEWS_PROMPT = """You screen articles for a site about Syria's healthcare sector.

For each numbered item decide:
- keep: true only if the article is substantially about health, medicine, hospitals,
  disease, medical staff, health funding, or health policy AND relates to Syria or
  Syrians. Otherwise false.
- topic: one of hospitals, public-health, aid, workforce, policy, other
- summary_en: one neutral sentence, max 28 words
- summary_ar: the same sentence in Modern Standard Arabic
- title_ar: the headline in Modern Standard Arabic

Reply with JSON only: {"results":[{"n":1,"keep":true,"topic":"aid","summary_en":"...","summary_ar":"...","title_ar":"..."}]}
No markdown, no commentary."""

JOBS_PROMPT = """You screen job listings for a site about Syria's healthcare sector.

For each numbered item decide:
- keep: true only if it is a real vacancy in a health or medical role, or a health
  programme role, connected to Syria or Syrians. Otherwise false.
- organisation: the hiring organisation, or "" if unclear
- location: city or region, or "" if unclear
- title_ar: the job title in Modern Standard Arabic

Reply with JSON only: {"results":[{"n":1,"keep":true,"organisation":"...","location":"...","title_ar":"..."}]}
No markdown, no commentary."""


def call_llm(url, key, model, system_prompt, payload_text, retries=3):
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": payload_text},
        ],
    }).encode()

    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        "User-Agent": USER_AGENT,
    })

    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read())
            content = data["choices"][0]["message"]["content"]
            content = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.M).strip()
            return json.loads(content).get("results", [])
        except Exception as exc:
            wait = 5 * (attempt + 1)
            print(f"  ! LLM call failed ({exc}); retrying in {wait}s")
            time.sleep(wait)
    return []


def screen(items, kind):
    url, key, model = llm_config()
    if not url:
        print("  no AI key found — keeping everything unfiltered")
        for i in items:
            i["topic"] = "other"
            i["summary_en"] = i.get("raw_summary", "")[:220]
        return items

    print(f"  screening {len(items)} items with {model}")
    prompt = NEWS_PROMPT if kind == "news" else JOBS_PROMPT
    kept = []

    for start in range(0, len(items), BATCH):
        chunk = items[start:start + BATCH]
        lines = []
        for n, it in enumerate(chunk, 1):
            lines.append(f"{n}. TITLE: {it['title_en']}\n   TEXT: {it.get('raw_summary', '')[:500]}")
        results = call_llm(url, key, model, prompt, "\n\n".join(lines))

        by_n = {r.get("n"): r for r in results if isinstance(r, dict)}
        for n, it in enumerate(chunk, 1):
            r = by_n.get(n)
            if not r or not r.get("keep"):
                continue
            if kind == "news":
                topic = r.get("topic", "other")
                it["topic"] = topic if topic in TOPICS else "other"
                it["summary_en"] = r.get("summary_en", "")
                it["summary_ar"] = r.get("summary_ar", "")
            else:
                it["organisation"] = r.get("organisation", "")
                it["location"] = r.get("location", "")
            it["title_ar"] = r.get("title_ar", "")
            kept.append(it)
        time.sleep(2)

    print(f"  kept {len(kept)} of {len(items)}")
    return kept


# --------------------------------------------------------------------------
# Assembling output
# --------------------------------------------------------------------------

def load_existing(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh).get("items", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def merge(existing, fresh, limit):
    seen = {i["url"] for i in existing}
    combined = existing + [i for i in fresh if i["url"] not in seen]

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)

    def sort_key(i):
        d = i.get("published")
        if isinstance(d, str):
            d = parse_date(d)
        return d or datetime.min.replace(tzinfo=timezone.utc)

    combined = [i for i in combined if sort_key(i) >= cutoff or not i.get("published")]
    combined.sort(key=sort_key, reverse=True)
    return combined[:limit]


def serialise(items):
    out = []
    for i in items:
        d = dict(i)
        d.pop("raw_summary", None)
        pub = d.get("published")
        if isinstance(pub, datetime):
            d["published"] = pub.date().isoformat()
        out.append(d)
    return out


def write(path, items):
    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": serialise(items),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"  wrote {len(items)} items to {os.path.relpath(path, ROOT)}")


def main():
    with open(SOURCES, encoding="utf-8") as fh:
        sources = json.load(fh)

    print("News:")
    fresh_news = collect(sources.get("news", []))
    existing_urls = {i["url"] for i in load_existing(NEWS_FILE)}
    new_only = [i for i in fresh_news if i["url"] not in existing_urls]
    print(f"  {len(new_only)} new of {len(fresh_news)} fetched")
    screened_news = screen(new_only, "news") if new_only else []
    write(NEWS_FILE, merge(load_existing(NEWS_FILE), screened_news, MAX_NEWS))

    print("Jobs:")
    fresh_jobs = collect(sources.get("jobs", []))
    existing_urls = {i["url"] for i in load_existing(JOBS_FILE)}
    new_only = [i for i in fresh_jobs if i["url"] not in existing_urls]
    print(f"  {len(new_only)} new of {len(fresh_jobs)} fetched")
    screened_jobs = screen(new_only, "jobs") if new_only else []
    write(JOBS_FILE, merge(load_existing(JOBS_FILE), screened_jobs, MAX_JOBS))


if __name__ == "__main__":
    sys.exit(main())
