"""Run against python -m http.server 8000; requires local Playwright."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8000"
preview = Path(__file__).resolve().parents[1] / ".preview"
preview.mkdir(exist_ok=True)
now = datetime.now(timezone.utc)
actual_news = json.loads((preview.parent / 'data/news.json').read_text(encoding='utf-8-sig'))['items']
actual_jobs = json.loads((preview.parent / 'data/jobs.json').read_text(encoding='utf-8-sig'))['items']
active_jobs = [j for j in actual_jobs if not j.get('deadline') or j['deadline'] >= now.date().isoformat()]
news = {"updated": now.isoformat(), "items": [
    {"title_en": "New clinic", "title_ar": "عيادة جديدة", "summary_en": "Care in Aleppo", "topic": "hospitals", "source": "Example", "url": "https://example.org/clinic", "published": now.date().isoformat()},
    {"title_en": "Health funding", "title_ar": "تمويل الصحة", "topic": "aid", "source": "Example", "url": "https://example.org/funding"},
    {"title_en": "Unsafe", "url": "javascript:alert(1)"},
]}
jobs = {"updated": now.isoformat(), "items": [
    {"title_en": "Nurse", "title_ar": "ممرض", "organisation": "Example", "location": "Aleppo", "deadline": now.date().isoformat(), "url": "https://example.org/nurse"},
    {"title_en": "Doctor", "location": "Damascus", "url": "https://example.org/doctor"},
    {"title_en": "Expired", "deadline": (now.date() - timedelta(days=1)).isoformat(), "url": "https://example.org/expired"},
]}
for item in news['items'] + jobs['items']:
    item.update(verification_version=2, verified_at=now.isoformat())
    item.setdefault('published', now.date().isoformat())
for item in jobs['items']:
    item.setdefault('deadline', (now.date()+timedelta(days=2)).isoformat())
news['items'].append({'title_en': 'Legacy unverified record', 'url': 'https://example.org/legacy', 'published': now.date().isoformat()})
jobs['items'].append({'title_en': 'Undated role', 'url': 'https://example.org/undated', 'published': now.date().isoformat(), 'verification_version': 2, 'verified_at': now.isoformat()})

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1100})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE, wait_until="networkidle")
    expect(page.locator("#newsList li")).to_have_count(len(actual_news))
    expect(page.locator("#jobsList li")).to_have_count(len(active_jobs))
    page.screenshot(path=str(preview / "desktop.png"), full_page=True)
    for language in ("en", "ar"):
        if page.locator("html").get_attribute("lang") != language:
            page.locator("#langToggle").click()
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900})
            assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), (language, width)
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(preview / f"{language}-mobile.png"), full_page=True)
    page.reload(wait_until="networkidle")
    expect(page.locator("html")).to_have_attribute("dir", "rtl")
    if any(n.get('title_ar') for n in actual_news):
        expect(page.locator("#newsList")).to_contain_text(re.compile(r'[\u0600-\u06ff]'))
        assert '????' not in page.locator('#newsList').inner_text()
    if any(j.get('title_ar') for j in active_jobs):
        expect(page.locator("#jobsList")).to_contain_text(re.compile(r'[\u0600-\u06ff]'))
        assert '????' not in page.locator('#jobsList').inner_text()
    page.locator("#langToggle").click()

    page.route("**/data/news.json", lambda route: route.fulfill(json=news))
    page.route("**/data/jobs.json", lambda route: route.fulfill(json=jobs))
    page.reload(wait_until="networkidle")
    expect(page.locator("#newsList li")).to_have_count(2)
    expect(page.locator("#jobsList li")).to_have_count(2)
    page.get_by_role("button", name="Hospitals & clinics", exact=True).click()
    expect(page.locator("#newsList li")).to_have_count(1)
    expect(page.get_by_role("button", name="Hospitals & clinics", exact=True)).to_be_focused()
    page.get_by_role("button", name="All stories", exact=True).click()
    page.locator("#search").fill("عيادة")
    expect(page.locator("#newsList li")).to_have_count(1)
    page.locator("#search").fill("missing result")
    expect(page.locator("#newsEmpty")).to_be_visible()
    page.locator("#newsEmpty button").click()
    expect(page.locator("#newsList li")).to_have_count(2)
    page.locator("#location").select_option("Aleppo")
    expect(page.locator("#jobsList li")).to_have_count(1)
    page.locator("#langToggle").click()
    expect(page.locator("#jobsList")).to_contain_text("ممرض")
    page.locator("#langToggle").click()
    page.unroute("**/data/news.json")
    page.route("**/data/news.json", lambda route: route.fulfill(status=503, body="Unavailable"))
    page.reload(wait_until="networkidle")
    expect(page.locator("#newsEmpty")).to_contain_text("Unable to load")
    expect(page.locator("#jobsList li")).to_have_count(2)
    page.unroute("**/data/news.json")
    page.route("**/data/news.json", lambda route: route.fulfill(json=news))
    page.locator("#newsEmpty button").click()
    expect(page.locator("#newsList li")).to_have_count(2)

    # Storage restrictions must not stop rendering.
    restricted = browser.new_context()
    restricted.add_init_script("Object.defineProperty(window, 'localStorage', {get() {throw new Error('blocked')}})")
    restricted_page = restricted.new_page()
    restricted_page.goto(BASE, wait_until="networkidle")
    expect(restricted_page.locator("#newsList li")).to_have_count(len(actual_news))
    restricted_page.locator("#langToggle").click()
    expect(restricted_page.locator("html")).to_have_attribute("lang", "ar")
    assert not errors, errors
    browser.close()
print("Browser checks passed: English/Arabic responsive layouts, search, filters, expiration, safe links, retry, persistence and restricted storage.")
