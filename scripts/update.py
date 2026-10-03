#!/usr/bin/env python3
"""
Collect health-sector news and job listings from public RSS feeds,
filter them with an LLM, and write data/news.json and data/jobs.json.

Runs twice a day via .github/workflows/update.yml.

AI provider is picked from environment variables, in this order:
  GROQ_API_KEY  -> Groq
  GEMINI_API_KEY-> Google AI Studio (OpenAI-compatible endpoint)
  GITHUB_TOKEN  -> GitHub Models (inside Actions)
If none is set, publishing fails safely and existing data is preserved.
"""

import json
import gzip
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

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
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
        "Cache-Control": "no-cache",
    })
    for attempt in range(3):
        with urllib.request.urlopen(req, timeout=timeout) as r:
            content = r.read()
            status = r.status
            if content:
                return gzip.decompress(content) if content.startswith(b"\x1f\x8b") else content
        if attempt < 2:
            time.sleep(3 * (attempt + 1))
    raise ValueError(f"Feed returned an empty response (HTTP {status}) after three attempts")


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
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return d.replace(tzinfo=d.tzinfo or timezone.utc).astimezone(timezone.utc)
    except ValueError:
        pass
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
        preview = xml_bytes[:160].decode("utf-8", errors="replace").replace("\n", " ")
        raise ValueError(f"Invalid XML from {source_name}: {exc}; response begins {preview!r}") from exc

    if root.tag not in ("rss", "{http://www.w3.org/2005/Atom}feed", "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}RDF"):
        raise ValueError(f"Not an RSS/Atom feed: {source_name}")

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
        desc = text("description", "atom:summary") or text("{http://purl.org/rss/1.0/modules/content/}encoded", "atom:content")
        pub = text("pubDate", "atom:published") or text("{http://purl.org/dc/elements/1.1/}date", "atom:updated")

        if not title or not canonical_url(link):
            continue

        item = {
            "title_en": strip_html(title),
            "url": link.strip(),
            "raw_summary": strip_html(desc)[:900],
            "published": parse_date(pub),
            "source": source_name,
        }
        closing = re.search(r"Closing date:\s*(\d{1,2} [A-Za-z]{3} \d{4})", strip_html(desc), re.I)
        if closing:
            try:
                item["deadline"] = datetime.strptime(closing.group(1), "%d %b %Y").date().isoformat()
            except ValueError:
                pass
        out.append(item)
    return out


def collect(feeds):
    items = []
    failures = []
    successes = 0
    for f in feeds:
        print(f"  reading {f['name']}")
        try:
            items.extend(parse_feed(fetch(f["url"]), f["name"]))
            successes += 1
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            print(f"  ! {f['name']} unreachable: {exc}")
            failures.append(f["name"])
        time.sleep(1)
    if not successes:
        raise RuntimeError("No sources could be read; previous data preserved")
    return items, failures


# --------------------------------------------------------------------------
# LLM filtering
# --------------------------------------------------------------------------

def llm_config():
    if os.environ.get("GROQ_API_KEY"):
        return ("https://api.groq.com/openai/v1/chat/completions",
                os.environ["GROQ_API_KEY"], "llama-3.3-70b-versatile")
    if os.environ.get("GEMINI_API_KEY"):
        return ("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                os.environ["GEMINI_API_KEY"], os.environ.get("GEMINI_MODEL", "gemini-3.6-flash"))
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
    raise RuntimeError("AI screening failed; previous data preserved")


def screen(items, kind):
    url, key, model = llm_config()
    if not url:
        raise RuntimeError("No AI credentials configured; refusing to publish unfiltered items")

    print(f"  screening {len(items)} items with {model}")
    prompt = NEWS_PROMPT if kind == "news" else JOBS_PROMPT
    kept = []

    for start in range(0, len(items), BATCH):
        chunk = items[start:start + BATCH]
        lines = []
        for n, it in enumerate(chunk, 1):
            lines.append(f"{n}. TITLE: {it['title_en']}\n   TEXT: {it.get('raw_summary', '')[:500]}")
        results = call_llm(url, key, model, prompt, "\n\n".join(lines))
        if not isinstance(results, list):
            raise ValueError("AI returned invalid results")
        by_n = {r.get("n"): r for r in results if isinstance(r, dict)}
        if len(results) != len(chunk) or set(by_n) != set(range(1, len(chunk) + 1)):
            raise ValueError("AI returned incomplete screening; previous data preserved")
        for n, it in enumerate(chunk, 1):
            r = by_n.get(n)
            if type(r.get("keep")) is not bool:
                raise ValueError("AI keep decision must be a boolean")
            if not r["keep"]:
                continue
            fields = ("title_ar", "summary_en", "summary_ar", "topic") if kind == "news" else ("title_ar", "organisation", "location")
            if any(not isinstance(r.get(field), str) for field in fields):
                raise ValueError("AI returned invalid content fields")
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
        with open(path, encoding="utf-8-sig") as fh:
            return json.load(fh).get("items", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def canonical_url(url):
    try:
        parts = urlsplit(url.strip())
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return ""
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if not k.lower().startswith("utm_") and k.lower() not in ("fbclid", "gclid")]
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), urlencode(sorted(query)), ""))
    except (ValueError, AttributeError):
        return ""


def merge(existing, fresh, limit, kind="news"):
    seen = set()
    combined = []
    for item in fresh + existing:
        key = canonical_url(item.get("url", ""))
        if key and key not in seen:
            combined.append(item)
            seen.add(key)

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)

    def sort_key(i):
        d = i.get("published")
        if isinstance(d, str):
            d = parse_date(d)
        return d or datetime.min.replace(tzinfo=timezone.utc)

    combined = [i for i in combined if sort_key(i) >= cutoff or not i.get("published")]
    if kind == "jobs":
        today = datetime.now(timezone.utc).date()
        combined = [i for i in combined if not parse_date(i.get("deadline")) or parse_date(i["deadline"]).date() >= today]
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
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(temporary, path)
    print(f"  wrote {len(items)} items to {os.path.relpath(path, ROOT)}")


def main():
    with open(SOURCES, encoding="utf-8-sig") as fh:
        sources = json.load(fh)

    failures = []
    for kind, path, limit in (("news", NEWS_FILE, MAX_NEWS), ("jobs", JOBS_FILE, MAX_JOBS)):
        print(f"{kind.title()}:")
        try:
            fresh, unavailable = collect(sources.get(kind, []))
            existing = load_existing(path)
            existing_urls = {canonical_url(i["url"]) for i in existing}
            new_only = [i for i in merge([], fresh, limit, kind) if canonical_url(i["url"]) not in existing_urls]
            screened = screen(new_only, kind) if new_only else []
            write(path, merge(existing, screened, limit, kind))
            failures.extend(unavailable)
        except (RuntimeError, ValueError, OSError) as exc:
            failures.append(f"{kind}: {exc}")
            print(f"::error::{kind}: {exc}")
    if failures:
        print("::error::Collection needs attention: " + "; ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
