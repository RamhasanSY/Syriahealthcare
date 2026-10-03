#!/usr/bin/env python3
"""Publish source-backed Syria healthcare records without an AI dependency."""
import gzip
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'sources.json'
DATA = ROOT / 'data'
VERSION = 2
USER_AGENT = 'SyriaHealthcareBot/2.0 (+https://syriahealthcare.com)'
MAX_NEWS_DAYS = 45
CACHE_HOURS = 72
SYRIA = re.compile(r'\b(?:syria|syrian|damascus|aleppo|idlib|homs|hama|daraa|dar.a|raqqa|hasakah|azaz|deir\s+(?:ez[ -]?zor|ezzor|alzoor|azzur))\b|سوري[اة]|دمشق|حلب|إدلب|ادلب|حمص|حماة|درعا|الرقة|دير الزور|أعزاز', re.I)
HEALTH = re.compile(r'\b(?:health(?:care)?|medical|medicine|hospital|clinic|cardiac|cardiology|surgery|surgeries|surgical|nurs\w*|doctor|physician|patient|cancer|cholera|vaccin\w*|dialysis|nutrition|malnutrition|physiotherapy|midwi\w*|pharmac\w*|paediatri\w*|pediatri\w*|premature|disease|ambulance|outbreak|measles|polio|mental health|ureter|sight|blindness)\b|صح[ية]|طب[يية]|مشفى|مشاف|مستشف|تمريض|ممرض|صيدل|لقاح|تغذي|سرطان|أطفال|اطفال', re.I)


def now():
    return datetime.now(timezone.utc)


def parse_date(raw):
    if isinstance(raw, datetime):
        return raw.replace(tzinfo=raw.tzinfo or timezone.utc).astimezone(timezone.utc)
    if not isinstance(raw, str) or not raw.strip():
        return None
    raw = raw.strip()
    try:
        d = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError:
        try:
            d = parsedate_to_datetime(raw)
        except (ValueError, TypeError, OverflowError):
            d = None
            for fmt in ('%B %d, %Y', '%b %d, %Y', '%d %b %Y', '%d %B %Y'):
                try:
                    d = datetime.strptime(raw, fmt)
                    break
                except ValueError:
                    pass
            if d is None:
                return None
    return d.replace(tzinfo=d.tzinfo or timezone.utc).astimezone(timezone.utc)


def canonical_url(raw):
    try:
        p = urlsplit(raw.strip())
        if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password:
            return ''
        query = [(k, v) for k, v in parse_qsl(p.query) if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid')]
        return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip('/'), urlencode(sorted(query)), ''))
    except (ValueError, AttributeError):
        return ''


def fetch(url, timeout=25, payload=None):
    headers = {'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/json, text/html, */*'}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                content = response.read(4_000_001)
                if len(content) > 4_000_000:
                    raise ValueError('Source exceeded the maximum response size')
                if not content:
                    raise ValueError(f'Empty response (HTTP {response.status})')
                return gzip.decompress(content) if content.startswith(b'\x1f\x8b') else content
        except (urllib.error.URLError, OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.ignore = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignore += 1
        elif tag in ('p', 'div', 'li', 'br', 'h1', 'h2', 'h3'):
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.ignore = max(0, self.ignore - 1)
        self.parts.append(' ')

    def handle_data(self, data):
        if not self.ignore:
            self.parts.append(data)


def strip_html(raw):
    parser = TextOnly()
    parser.feed(raw or '')
    return re.sub(r'\s+', ' ', html.unescape(''.join(parser.parts))).strip()


def clean_body(raw):
    text = strip_html(raw)
    return re.split(r'\bThe post\b|\bRead Full Article\b', text, maxsplit=1)[0].strip()


def parse_feed(content, source_name):
    root = ElementTree.fromstring(content)
    if root.tag not in ('rss', '{http://www.w3.org/2005/Atom}feed'):
        raise ValueError('Response is not RSS or Atom')
    ns = {'a': 'http://www.w3.org/2005/Atom'}
    entries = root.findall('.//item') or root.findall('a:entry', ns)
    items = []
    for entry in entries:
        def text(tag, atom=None):
            el = entry.find(tag)
            if el is None and atom:
                el = entry.find('a:' + atom, ns)
            return ''.join(el.itertext()).strip() if el is not None else ''
        url = text('link')
        if not url:
            links = entry.findall('a:link', ns)
            alternative = next((a for a in links if a.get('rel', 'alternate') == 'alternate'), None)
            url = alternative.get('href', '') if alternative is not None else ''
        title = strip_html(text('title', 'title'))
        if not title or not canonical_url(url):
            continue
        content = text('{http://purl.org/rss/1.0/modules/content/}encoded', 'content') or text('description', 'summary')
        published = text('pubDate', 'published') or text('{http://purl.org/dc/elements/1.1/}date', 'updated')
        items.append({'title': title, 'url': url, 'published': published, 'raw_summary': clean_body(content), 'source': source_name})
    return items


def classify(text):
    if re.search(r'hospital|clinic|cardiac|surg|مشفى|مستشف|جراح', text, re.I):
        return 'hospitals'
    if re.search(r'training|education|workforce|تدريب|تعليم', text, re.I):
        return 'workforce'
    if re.search(r'policy|system|سياس|نظام', text, re.I):
        return 'policy'
    return 'public-health'


def original_fields(title):
    language = 'ar' if re.search(r'[\u0600-\u06ff]', title) else 'en'
    return {'title': title, 'title_' + language: title, 'language': language}


def eligible_news(item):
    published = parse_date(item.get('published'))
    if not published or not now() - timedelta(days=MAX_NEWS_DAYS) <= published <= now() + timedelta(hours=1):
        return False
    title = item.get('title', '')
    lead = (item.get('raw_summary') or '')[:1500]
    # The publisher's name must never count as evidence of a Syrian location.
    evidence = re.sub(r'Syrian American Medical Society(?: Foundation)?|Syrian Arab Red Crescent', '', title + ' ' + lead, flags=re.I)
    if not SYRIA.search(evidence):
        return False
    # Require a healthcare headline, or an explicitly Syrian mission with health content.
    return bool(HEALTH.search(title) or (SYRIA.search(title) and re.search(r'mission|بعثة|حملة', title, re.I) and HEALTH.search(lead)))


def base_record(item, source):
    pub = parse_date(item.get('published'))
    return {**original_fields(item['title']), 'url': item['url'], 'published': pub.date().isoformat() if pub else None,
            'source': source['name'], 'source_id': source['id'], 'verification_version': VERSION,
            'verified_at': now().isoformat(timespec='seconds')}


def news_records(source):
    candidates = parse_feed(fetch(source['url']), source['name'])
    accepted = []
    for item in candidates:
        if not eligible_news(item):
            continue
        record = base_record(item, source)
        record['topic'] = classify(item['title'] + ' ' + item['raw_summary'][:700])
        # Original headlines only: no generated claims, summaries, or translations.
        record['evidence'] = {'geography': SYRIA.search(re.sub(r'Syrian American Medical Society(?: Foundation)?', '', item['title'] + ' ' + item['raw_summary'][:1500], flags=re.I)).group(0), 'type': 'publisher-headline'}
        accepted.append(record)
    return accepted, len(candidates)


def job_valid(item):
    deadline, published = parse_date(item.get('deadline')), parse_date(item.get('published'))
    exact_deadline = item.get('deadline_at') or (item.get('deadline') if 'T' in str(item.get('deadline')) else None)
    return bool(deadline and deadline.date() >= now().date() and (not exact_deadline or parse_date(exact_deadline) >= now()) and published and published <= now() + timedelta(hours=1)
                and SYRIA.search(item.get('location', '')) and canonical_url(item.get('url', '')))


def job_record(item, source):
    record = base_record(item, source)
    record.update(deadline=parse_date(item['deadline']).date().isoformat(), organisation=source['organisation'],
                  location=item['location'], reference=str(item.get('reference', '')),
                  role_type='clinical' if HEALTH.search(item['title']) else 'support',
                  evidence={'type': 'employer-listing', 'deadline': item['deadline'], 'location': item['location']})
    record['sector'] = source.get('sector', 'healthcare')
    record['listing_page'] = source.get('adapter') == 'sams_jobs'
    if 'T' in item['deadline']:
        record['deadline_at'] = parse_date(item['deadline']).isoformat()
    if item.get('contract'):
        record['contract'] = item['contract']
    record['id'] = source['id'] + ':' + str(item.get('reference') or canonical_url(item['url']))
    return record


def sams_jobs(source):
    payload = json.loads(fetch(source['url']))
    if payload.get('success') is not True or not isinstance(payload.get('data'), list):
        raise ValueError('SAMS recruitment response has changed')
    result = []
    for row in payload['data']:
        if row.get('btnwork') is not True or row.get('StatusOfPositionName') != 'Available':
            continue
        item = {'title': row.get('PositionName', ''), 'published': row.get('StartingDate'), 'deadline': row.get('EndingDate'),
                'location': row.get('PositionLocationName', ''), 'reference': row.get('PositionForCondidateID'), 'url': source['website']}
        if item['title'] and item['reference'] and job_valid(item):
            result.append(job_record(item, source))
    return result, len(payload['data'])


def ida_detail(item, source):
    if urlsplit(item['url']).hostname != urlsplit(source['url']).hostname:
        raise ValueError('Vacancy link leaves the configured employer domain')
    text = strip_html(fetch(item['url']).decode('utf-8-sig'))
    expiry = re.search(r'Expiry Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})', text)
    location = re.search(r'Workspace:\s*(.+?)(?:\s+IDA is|\s+Apply Now)', text)
    title = re.search(r'Position:\s*(.+?)\s+Department:', text)
    if not expiry or not location or not title:
        raise ValueError('Employer deadline, position or location field is missing')
    item = {**item, 'deadline': expiry.group(1), 'location': location.group(1).strip()}
    # Keep the feed's original Arabic title; the detail page supplies the English title.
    if job_valid(item):
        record = job_record(item, source)
        record['title_en'] = title.group(1).strip()
        return record
    return None


def ida_jobs(source):
    candidates = parse_feed(fetch(source['url']), source['name'])
    recent = [i for i in candidates if parse_date(i['published']) and parse_date(i['published']) >= now() - timedelta(days=45)]
    result = []
    # Each vacancy must have a deadline and workplace on its own employer page.
    for item in recent[:30]:
        record = ida_detail(item, source)
        if record:
            result.append(record)
    return result, len(candidates)


def nrc_jobs(source):
    result, total, page = [], None, 1
    while total is None or (page - 1) * 100 < total:
        payload = json.loads(fetch(source['url'], payload={'page': page, 'pageSize': 100, 'skip': (page - 1) * 100, 'take': 100, 'sort': [{'field': '1', 'dir': 'desc'}]}))
        if not isinstance(payload.get('Data'), list) or not isinstance(payload.get('Total'), int):
            raise ValueError('NRC public recruitment response has changed')
        total = payload['Total']
        if total > 1000 or (not payload['Data'] and (page - 1) * 100 < total):
            raise ValueError('NRC returned an incomplete vacancy snapshot')
        for row in payload['Data']:
            if row.get('IsInternet') is not True or row.get('TenantId') != '23109900' or not SYRIA.search(row.get('WorkPlaceFacet', '')):
                continue
            if urlsplit(row.get('OpenAdvertUrl', '')).hostname != '23109900.webcruiter.no':
                continue
            published = datetime.strptime(row['PublishedDate'], '%d/%m/%Y').date().isoformat()
            location = ' / '.join(dict.fromkeys(x for x in (row.get('WorkPlaceFacet'), row.get('Workplace3')) if x))
            item = {'title': row['Heading'], 'published': published, 'deadline': row['ApplicationDeadline'], 'location': location,
                    'url': row['OpenAdvertUrl'], 'reference': row['Id'], 'contract': row.get('JobType')}
            if job_valid(item):
                result.append(job_record(item, source))
        page += 1
    return result, total


class DRCListings(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.current = [], None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'article' and 'jobList__item' in attrs.get('class', '').split():
            self.current = attrs
        elif tag == 'a' and self.current is not None:
            self.current['url'] = attrs.get('href', '')

    def handle_endtag(self, tag):
        if tag == 'article' and self.current is not None:
            self.rows.append(self.current)
            self.current = None


def drc_jobs(source):
    page = fetch(source['url']).decode('utf-8-sig')
    if 'id="jobList"' not in page:
        raise ValueError('DRC vacancy list was not found')
    parser = DRCListings(); parser.feed(page)
    result = []
    for row in parser.rows:
        if not SYRIA.search(row.get('data-country', '')):
            continue
        item = {'title': row['data-title'], 'location': row['data-country'], 'url': urljoin(source['url'], row['url']),
                'published': datetime.strptime(row['data-published'], '%m/%d/%Y %I:%M:%S %p').date().isoformat(),
                'deadline': datetime.strptime(row['data-deadline'], '%m/%d/%Y %I:%M:%S %p').date().isoformat(), 'contract': row.get('data-contract')}
        if job_valid(item):
            result.append(job_record(item, source))
    return result, len(parser.rows)


def collect_source(source, kind):
    handlers = {'rss': news_records, 'sams_jobs': sams_jobs, 'ida_jobs': ida_jobs, 'nrc_jobs': nrc_jobs, 'drc_jobs': drc_jobs}
    try:
        items, total = handlers[source['adapter']](source)
        return items, {'id': source['id'], 'kind': kind, 'state': 'ok', 'checked_at': now().isoformat(timespec='seconds'),
                       'fetched': total, 'accepted': len(items), 'latest_published': max((i['published'] for i in items), default=None)}
    except (OSError, ValueError, KeyError, TypeError, ElementTree.ParseError) as exc:
        return [], {'id': source['id'], 'kind': kind, 'state': 'error', 'checked_at': now().isoformat(timespec='seconds'),
                    'error': str(exc)[:240], 'accepted': 0}


def read(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (FileNotFoundError, ValueError):
        return default


def write(path, payload):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def retain_verified(item, kind, configured):
    verified = parse_date(item.get('verified_at'))
    published = parse_date(item.get('published'))
    if item.get('verification_version') != VERSION or item.get('source_id') not in configured or not canonical_url(item.get('url', '')):
        return False
    if not verified or not published or published > now() + timedelta(hours=1):
        return False
    if kind == 'jobs':
        return verified >= now() - timedelta(hours=CACHE_HOURS) and job_valid(item)
    return published >= now() - timedelta(days=MAX_NEWS_DAYS)


def merge_records(existing, fresh, kind, statuses):
    configured = {s['id'] for s in statuses}
    refreshed = {s['id'] for s in statuses if s['state'] == 'ok'}
    # Never retain legacy, unverified records. Replace successful employer snapshots.
    retained = [i for i in existing if retain_verified(i, kind, configured)
                and not (kind == 'jobs' and i['source_id'] in refreshed)]
    seen, titles, result = set(), set(), []
    for item in fresh + retained:
        key = item.get('id') or canonical_url(item['url'])
        title = re.sub(r'\W+', '', item.get('title', '').casefold())
        title_key = (title, item.get('organisation', ''), item.get('location', ''))
        if key in seen or (title and title_key in titles):
            continue
        seen.add(key); titles.add(title_key); result.append(item)
    result.sort(key=lambda i: i.get('published') or '', reverse=True)
    return result[:60 if kind == 'news' else 40]


def main():
    config = read(SOURCES, {})
    status_rows, fresh = [], {'news': [], 'jobs': []}
    with ThreadPoolExecutor(max_workers=5) as pool:
        tasks = {pool.submit(collect_source, source, kind): kind for kind in ('news', 'jobs') for source in config.get(kind, [])}
        for task in as_completed(tasks):
            kind = tasks[task]
            items, status = task.result()
            fresh[kind].extend(items); status_rows.append(status)
            print(f"{status['id']}: {status['state']}, {len(items)} accepted", flush=True)
            if status['state'] == 'error':
                print('::warning::' + status['id'] + ': ' + status['error'], flush=True)
    checked = now().isoformat(timespec='seconds')
    failed = False
    for kind in ('news', 'jobs'):
        statuses = [s for s in status_rows if s['kind'] == kind]
        old = read(DATA / (kind + '.json'), {})
        success = any(s['state'] == 'ok' for s in statuses)
        items = merge_records(old.get('items', []), fresh[kind], kind, statuses)
        write(DATA / (kind + '.json'), {'updated': checked if success else old.get('updated'), 'checked_at': checked,
              'status': 'ok' if all(s['state'] == 'ok' for s in statuses) and statuses else 'partial' if success else 'error', 'items': items})
        if not success:
            failed = True
    write(DATA / 'status.json', {'checked_at': checked, 'sources': sorted(status_rows, key=lambda s: s['id']), 'version': VERSION})
    summary = '\n'.join(f"- {s['id']}: {s['state']} — {s['accepted']} eligible items" for s in status_rows)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
            stream.write('## Source collection\n' + summary + '\n')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
