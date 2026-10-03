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
    {"title_en": "Doctor", "location": "Damascus", "organisation": "NGO Example", "sector": "ngo", "url": "https://example.org/doctor"},
    {"title_en": "Expired", "deadline": (now.date() - timedelta(days=1)).isoformat(), "url": "https://example.org/expired"},
]}
for item in news['items'] + jobs['items']:
    item.update(verification_version=2, verified_at=now.isoformat())
    item.setdefault('published', now.date().isoformat())
for item in jobs['items']:
    item.setdefault('deadline', (now.date()+timedelta(days=2)).isoformat())
news['items'].append({'title_en': 'Legacy unverified record', 'url': 'https://example.org/legacy', 'published': now.date().isoformat()})
news['items'].extend([
    {**news['items'][0], 'title_en': 'Missing verification date', 'url': 'https://example.org/missing-verification', 'verified_at': None},
    {**news['items'][0], 'title_en': 'Future verification', 'url': 'https://example.org/future-verification', 'verified_at': (now+timedelta(days=2)).isoformat()},
])
jobs['items'].append({'title_en': 'Undated role', 'url': 'https://example.org/undated', 'published': now.date().isoformat(), 'verification_version': 2, 'verified_at': now.isoformat()})
jobs['items'].extend([
    {**jobs['items'][0], 'title_en': 'Impossible calendar date', 'url': 'https://example.org/impossible-date', 'deadline': '2099-02-30'},
    {**jobs['items'][0], 'title_en': 'Invalid exact deadline', 'url': 'https://example.org/invalid-time', 'deadline_at': 'invalid'},
    {**jobs['items'][0], 'title_en': 'Expired exact deadline', 'url': 'https://example.org/expired-time', 'deadline_at': (now-timedelta(minutes=1)).isoformat()},
])

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1100})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE, wait_until="networkidle")
    expect(page.locator("#newsList li")).to_have_count(min(6, len(actual_news)))
    expect(page.locator("#jobsList li")).to_have_count(len(active_jobs))
    page.screenshot(path=str(preview / "desktop.png"), full_page=True)
    page.screenshot(path=str(preview / "desktop-top.png"))
    if len(actual_news) > 6:
        page.locator('#moreNews').click()
        expect(page.locator('#newsList li')).to_have_count(min(12, len(actual_news)))
        expect(page.locator('#newsList li').nth(6).locator('.card-title a')).to_be_focused()
    for language in ("en", "ar"):
        if page.locator("html").get_attribute("lang") != language:
            page.locator("#langToggle").click()
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900})
            assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), (language, width)
            assert page.locator('#externalJobs li').evaluate_all('(items) => items.every(li => li.lastElementChild.getBoundingClientRect().bottom <= li.getBoundingClientRect().bottom + 1)'), (language, width, 'directory notes overflow')
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
    page.locator('[data-sector="ngo"]').click()
    expect(page.locator('#jobsList li')).to_have_count(1)
    expect(page.locator('#jobsList')).to_contain_text('Doctor')
    page.locator('#clearFilters').click()
    page.locator('#organisation').select_option('NGO Example')
    expect(page.locator('#jobsList li')).to_have_count(1)
    page.locator('#clearFilters').click()
    page.get_by_role('button', name='Save job: Nurse', exact=True).click()
    page.locator('[data-sector="saved"]').click()
    expect(page.locator('#jobsList li')).to_have_count(1)
    expect(page.locator('#jobsList')).to_contain_text('Nurse')
    page.reload(wait_until='networkidle')
    expect(page.get_by_role('button',name='Unsave job: Nurse',exact=True)).to_have_attribute('aria-pressed','true')
    page.locator('#jobSort').select_option('deadline')
    expect(page.locator('#jobsList li').first).to_contain_text('Nurse')
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
    expect(page.locator('#search')).to_be_focused()
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

    # Exact deadlines on the same date must sort by time, and distant roles
    # must not receive a misleading "Closing soon" label.
    exact_day = now + timedelta(days=7)
    exact_jobs = {'updated': now.isoformat(), 'items': [
        {**jobs['items'][0], 'title_en': 'Late closing', 'url': 'https://example.org/late', 'deadline': exact_day.date().isoformat(), 'deadline_at': exact_day.replace(hour=17, minute=0, second=0).isoformat()},
        {**jobs['items'][0], 'title_en': 'Early closing', 'url': 'https://example.org/early', 'deadline': exact_day.date().isoformat(), 'deadline_at': exact_day.replace(hour=9, minute=0, second=0).isoformat()},
    ]}
    page.unroute('**/data/jobs.json')
    page.route('**/data/jobs.json', lambda route: route.fulfill(json=exact_jobs))
    page.clock.install()
    page.reload(wait_until='networkidle')
    page.locator('#jobSort').select_option('deadline')
    expect(page.locator('#jobsList li').first).to_contain_text('Early closing')
    expect(page.locator('#featuredTitle')).to_have_text('Early closing')
    expect(page.locator('.spotlight-top .pill')).to_have_text('Featured opportunity')

    # A failed background refresh must keep valid results and disclose the
    # failure without losing the keyboard user's place in the filters.
    page.get_by_role('button', name='Hospitals & clinics', exact=True).focus()
    page.unroute('**/data/news.json')
    page.route('**/data/news.json', lambda route: route.fulfill(status=503, body='Unavailable'))
    page.clock.fast_forward(15 * 60 * 1000)
    expect(page.locator('#newsStamp')).to_contain_text('Refresh failed')
    expect(page.locator('#newsList li')).to_have_count(2)
    expect(page.get_by_role('button', name='Hospitals & clinics', exact=True)).to_be_focused()

    # Stalled requests must time out instead of leaving a permanent spinner.
    page.unroute('**/data/news.json')
    stalled_requests = []
    page.route('**/data/news.json', lambda route: stalled_requests.append(route))
    page.clock.fast_forward(15 * 60 * 1000)
    expect(page.locator('#newsList')).to_have_attribute('aria-busy', 'true')
    page.clock.fast_forward(16000)
    expect(page.locator('#newsStamp')).to_contain_text('Refresh failed')
    expect(page.locator('#newsList')).to_have_attribute('aria-busy', 'false')
    for route in stalled_requests:
        route.abort()
    page.unroute_all(behavior='ignoreErrors')

    # An open tab must remove a vacancy shortly after its exact deadline,
    # without waiting for the next fifteen-minute network refresh.
    expiry = datetime.fromtimestamp(page.evaluate('Date.now()') / 1000, timezone.utc) + timedelta(seconds=30)
    expiring_jobs = {'updated': now.isoformat(), 'items': [
        {**jobs['items'][0], 'deadline': expiry.date().isoformat(), 'deadline_at': expiry.isoformat()}
    ]}
    page.route('**/data/jobs.json', lambda route: route.fulfill(json=expiring_jobs))
    page.route('**/data/news.json', lambda route: route.fulfill(json=news))
    page.reload(wait_until='networkidle')
    expect(page.locator('#jobsList li')).to_have_count(1)
    page.locator('#jobsList .job-title a').focus()
    page.clock.fast_forward(61000)
    expect(page.locator('#jobsList li')).to_have_count(0)
    expect(page.locator('#jobsEmpty')).to_contain_text('No current openings')
    expect(page.locator('#heroJobCount')).to_have_text('0')
    expect(page.locator('#search')).to_be_focused()

    # Storage restrictions must not stop rendering.
    restricted = browser.new_context()
    restricted.add_init_script("Object.defineProperty(window, 'localStorage', {get() {throw new Error('blocked')}})")
    restricted_page = restricted.new_page()
    restricted_page.goto(BASE, wait_until="networkidle")
    expect(restricted_page.locator("#newsList li")).to_have_count(min(6, len(actual_news)))
    expect(restricted_page.locator('#savedHint')).to_contain_text('while this page stays open')
    restricted_page.locator("#langToggle").click()
    expect(restricted_page.locator("html")).to_have_attribute("lang", "ar")
    assert not errors, errors
    browser.close()
print("Browser checks passed: English/Arabic layouts, search, filters, exact deadlines, automatic expiration, safe links, refresh failures, timeouts, keyboard focus, persistence and restricted storage.")
