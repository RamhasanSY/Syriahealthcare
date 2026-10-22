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
from email.utils import parsedate_to_datetime, format_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin, quote
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


def news_geography(item):
    # Use the same location evidence for filtering and the published record.
    text = item.get('title', '') + ' ' + (item.get('raw_summary') or '')[:1500]
    text = re.sub(r'Syrian American Medical Society(?: Foundation)?|Syrian Arab Red Crescent', '', text, flags=re.I)
    return SYRIA.search(text)


def eligible_news(item):
    published = parse_date(item.get('published'))
    if not published or not now() - timedelta(days=MAX_NEWS_DAYS) <= published <= now() + timedelta(hours=1):
        return False
    title = item.get('title', '')
    lead = (item.get('raw_summary') or '')[:1500]
    # The publisher's name must never count as evidence of a Syrian location.
    if not news_geography(item):
        return False
    # Require a healthcare headline, or an explicitly Syrian mission with health content.
    return bool(HEALTH.search(title) or (SYRIA.search(title) and re.search(r'mission|بعثة|حملة', title, re.I) and HEALTH.search(lead)))


def base_record(item, source):
    pub = parse_date(item.get('published'))
    return {**original_fields(item['title']), 'url': item['url'], 'published': pub.date().isoformat() if pub else None,
            'source': source['name'], 'source_id': source['id'], 'verification_version': VERSION,
            'verified_at': now().isoformat(timespec='seconds')}


def publish_news(candidates, source):
    accepted = []
    for item in candidates:
        if not eligible_news(item):
            continue
        record = base_record(item, source)
        record['topic'] = classify(item['title'] + ' ' + item['raw_summary'][:700])
        # Original headlines only: no generated claims, summaries, or translations.
        record['evidence'] = {'geography': news_geography(item).group(0), 'type': 'publisher-headline'}
        accepted.append(record)
    return accepted, len(candidates)


def news_records(source):
    return publish_news(parse_feed(fetch(source['url']), source['name']), source)


def sana_news(source):
    content = fetch(source['url'])
    # SANA currently repeats the identical media namespace in its RSS root.
    # Repair that exact publisher defect; conflicting declarations still fail.
    start = content.find(b'<rss')
    end = content.find(b'>', start) if start >= 0 else -1
    if end >= 0:
        declaration = b'xmlns:media="http://search.yahoo.com/mrss/"'
        header = content[start:end]
        count = header.count(declaration)
        if count > 1:
            header = header.replace(declaration, b'', count - 1)
            content = content[:start] + header + content[end:]
    return publish_news(parse_feed(content, source['name']), source)


class MinistryNews(HTMLParser):
    """Read dated article cards, excluding navigation, campaigns and tenders."""
    def __init__(self, website):
        super().__init__(convert_charrefs=True)
        self.website, self.rows, self.current, self.field = website, [], None, None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            url = urljoin(self.website, attrs.get('href', ''))
            if urlsplit(url).netloc == urlsplit(self.website).netloc and urlsplit(url).path.startswith('/news/'):
                self.current = {'url': quote(url, safe=':/%?=&-._~'), 'title': [], 'raw_summary': [], 'published': []}
        if self.current is not None:
            if tag in ('h2', 'h3'):
                self.field = 'title'
            elif tag == 'p':
                self.field = 'raw_summary'
            elif tag in ('time', 'span'):
                self.field = 'published'
                if tag == 'time' and attrs.get('datetime'):
                    self.current['published'].append(attrs['datetime'])

    def handle_data(self, data):
        if self.current is not None and self.field:
            self.current[self.field].append(data)

    def handle_endtag(self, tag):
        if tag in ('h2', 'h3', 'p', 'time', 'span'):
            self.field = None
        if tag == 'a' and self.current is not None:
            row = {k: re.sub(r'\s+', ' ', ''.join(v)).strip() if isinstance(v, list) else v for k, v in self.current.items()}
            # A changed card layout must be visible as a source failure.
            if not row['title'] or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', row['published']) or not parse_date(row['published']):
                raise ValueError('Ministry news card is missing a title or valid publication date')
            self.rows.append(row)
            self.current, self.field = None, None


def ministry_news(source):
    parser = MinistryNews(source['website'])
    parser.feed(fetch(source['url']).decode('utf-8-sig'))
    if not parser.rows:
        raise ValueError('Ministry dated news cards were not found')
    return publish_news(parser.rows, source)


def reliefweb_record(source, title, published, deadline, location, url, organisation, categories):
    if urlsplit(url).hostname != 'reliefweb.int' or any(re.search(r'tender|rfp|eoi', c, re.I) for c in categories):
        return None
    item = {'title': strip_html(title), 'published': published, 'deadline': deadline,
            'location': location, 'url': url, 'reference': urlsplit(url).path.split('/')[2]}
    if not (title and organisation and job_valid(item)):
        return None
    record = job_record(item, source)
    record['organisation'] = organisation
    if any(re.search(r'health', c, re.I) for c in categories) or HEALTH.search(item['title']):
        record['sector'] = 'healthcare'
    return record


def reliefweb_api_jobs(source, appname):
    """ReliefWeb's official API, used when an approved appname is configured."""
    fields = ['title', 'url', 'date.created', 'date.closing', 'source.name', 'country.name',
              'career_categories.name', 'theme.name', 'type.name']
    payload = json.loads(fetch('https://api.reliefweb.int/v2/jobs?appname=' + quote(appname), payload={
        'filter': {'field': 'country.iso3', 'value': 'SYR'}, 'limit': 100, 'sort': ['date.created:desc'],
        'fields': {'include': fields}}))
    if not isinstance(payload.get('data'), list):
        raise ValueError('ReliefWeb API response has changed')
    result = []
    for row in payload['data']:
        f = row.get('fields', {})
        names = lambda key: [x.get('name', '') for x in f.get(key, []) if isinstance(x, dict)]
        record = reliefweb_record(source, f.get('title', ''), f.get('date', {}).get('created'), f.get('date', {}).get('closing'),
                                  ' / '.join(names('country')), f.get('url', ''), ', '.join(names('source')),
                                  names('career_categories') + names('theme') + names('type'))
        if record:
            result.append(record)
    return result, len(payload['data'])


def reliefweb_jobs(source):
    """ReliefWeb Syria jobs: employer, closing date and country come from the listing itself."""
    # The public RSS is challenged from cloud IPs (empty HTTP 202); the API needs a free approved appname.
    appname = os.environ.get('RELIEFWEB_APPNAME', '').strip()
    if appname:
        return reliefweb_api_jobs(source, appname)
    root = ElementTree.fromstring(fetch(source['url']))
    if root.tag != 'rss':
        raise ValueError('ReliefWeb response is not RSS')
    entries = root.findall('.//item')
    result = []
    for entry in entries:
        def text(tag):
            el = entry.find(tag)
            return ''.join(el.itertext()).strip() if el is not None else ''
        body = html.unescape(text('description'))
        closing = re.search(r'Closing date:\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})', body)
        organisation = re.search(r'Organization:\s*([^<\r\n]+)', body)
        country = re.search(r'Country:\s*([^<\r\n]+)', body)
        if not closing or not organisation or not country:
            continue
        record = reliefweb_record(source, text('title'), text('pubDate'), closing.group(1), country.group(1).strip(),
                                  text('link'), organisation.group(1).strip(), [c.text or '' for c in entry.findall('category')])
        if record:
            result.append(record)
    return result, len(entries)


# Hospitals from OpenStreetMap (ODbL). Community-mapped: the site asks visitors to call ahead.
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OVERPASS_QUERY = '''[out:json][timeout:180];
area["ISO3166-1"="SY"]["admin_level"="2"]->.sy;
rel(area.sy)["admin_level"="4"]["boundary"="administrative"];
map_to_area->.govs;
foreach.govs->.g(.g out tags; nwr(area.g)["amenity"="hospital"]; out tags;);'''
ARABIC = re.compile(r'[؀-ۿ]')


def osm_hospitals(elements):
    governorate, seen, result = {}, set(), []
    for e in elements:
        tags = e.get('tags', {})
        if e.get('type') == 'area':
            governorate = {'city': re.sub(r'\s+Governorate$', '', tags.get('name:en') or tags.get('name', '')),
                           'city_ar': re.sub(r'^محافظة\s+', '', tags.get('name:ar') or tags.get('name', ''))}
            continue
        key = f"{e.get('type')}/{e.get('id')}"
        name = (tags.get('name') or '').strip()
        name_en = (tags.get('name:en') or ('' if ARABIC.search(name) else name)).strip()
        name_ar = (tags.get('name:ar') or (name if ARABIC.search(name) else '')).strip()
        same = (re.sub(r'\W+', '', (name_en or name_ar).casefold()), governorate.get('city'))
        if key in seen or same in seen or not (name_en or name_ar) or not governorate.get('city') or e.get('type') not in ('node', 'way', 'relation'):
            continue
        seen.update((key, same))
        street = ' '.join(x for x in (tags.get('addr:street'), tags.get('addr:housenumber')) if x)
        address = ', '.join(dict.fromkeys(x for x in (street, tags.get('addr:suburb') or tags.get('addr:district'), tags.get('addr:city')) if x))
        record = {'name': name_en or name_ar, 'name_ar': name_ar or name_en, **governorate, 'address': address,
                  'phone': (tags.get('phone') or tags.get('contact:phone') or '').split(';')[0].strip(),
                  'emergency': tags.get('emergency') == 'yes', 'osm': True,
                  'source_url': f"https://www.openstreetmap.org/{key}"}
        result.append(record)
    result.sort(key=lambda h: (h['city'], h['name'].casefold()))
    return result


def update_hospitals():
    path = DATA / 'hospitals.json'
    old = read(path, {})
    manual = [h for h in old.get('items', []) if isinstance(h, dict) and not h.get('osm')]
    payload = json.loads(fetch(OVERPASS_URL + '?' + urlencode({'data': OVERPASS_QUERY}), timeout=200))
    hospitals = osm_hospitals(payload.get('elements', []))
    if len(hospitals) < 100:
        raise ValueError(f'OpenStreetMap returned only {len(hospitals)} hospitals')
    # Platform hospitals and the platform address are kept; they are refreshed by update_platform_facilities.
    write(path, {**old, 'updated': now().isoformat(timespec='seconds'), 'source': 'OpenStreetMap contributors (ODbL)',
                 'items': manual + hospitals})
    return len(hospitals)


# Approved doctors from the booking platform (app.syriahealthcare.com), with a link to book each one.
# Runs only when PLATFORM_URL is set, so the website never links to a platform that is not online yet.
def platform_doctors(platform_url, catalog, doctors):
    base = platform_url.rstrip('/')
    specialties, governorates = catalog.get('specialties', {}), catalog.get('governorates', {})
    result = []
    for d in doctors:
        doctor_id = str(d.get('id', ''))
        if not re.fullmatch(r'[0-9a-f-]{36}', doctor_id) or not d.get('name') or d.get('specialty') not in specialties or d.get('governorate') not in governorates:
            continue
        specialty, governorate = specialties[d['specialty']], governorates[d['governorate']]
        record = {'name': d['name'], 'specialty': specialty[0], 'specialty_ar': specialty[1], 'city': governorate[0], 'city_ar': governorate[1],
                  'address': ', '.join(x for x in (d.get('clinic_name'), d.get('clinic_address'), d.get('area')) if x),
                  'phone': d.get('clinic_phone') or '', 'booking_url': f'{base}/book?doctor={doctor_id}', 'platform': True}
        if d.get('bio'):
            record['hours'] = d['bio'][:300]  # shown as a short line under the doctor's name
        result.append(record)
    result.sort(key=lambda r: (r['city'], r['name'].casefold()))
    return result


def platform_base_url():
    platform_url = os.environ.get('PLATFORM_URL', '').strip().rstrip('/')
    if platform_url and urlsplit(platform_url).scheme != 'https' and not platform_url.startswith('http://127.0.0.1'):
        raise ValueError('PLATFORM_URL must use https')
    return platform_url


def update_platform_doctors():
    platform_url = platform_base_url()
    if not platform_url:
        return None
def update_platform_doctors():
    platform_url = os.environ.get('PLATFORM_URL', '').strip().rstrip('/')
    if not platform_url:
        return None
    if urlsplit(platform_url).scheme != 'https' and not platform_url.startswith('http://127.0.0.1'):
        raise ValueError('PLATFORM_URL must use https')
    catalog = json.loads(fetch(platform_url + '/api/catalog'))
    payload = json.loads(fetch(platform_url + '/api/doctors'))
    if not isinstance(payload.get('doctors'), list):
        raise ValueError('Platform doctor list has changed')
    path = DATA / 'doctors.json'
    manual = [d for d in read(path, {}).get('items', []) if isinstance(d, dict) and not d.get('platform')]
    doctors = platform_doctors(platform_url, catalog, payload['doctors'])
    write(path, {'updated': now().isoformat(timespec='seconds'), 'platform_url': platform_url, 'items': manual + doctors})
    return len(doctors)


# Approved labs, imaging centres, hospitals and clinics from the platform. Labs and imaging go to the Labs page,
# hospitals and clinics to the Hospitals page, each marked as verified. Only public fields are copied.
def platform_facilities(catalog, facilities):
    kinds, governorates, services = catalog.get('facilityKinds', {}), catalog.get('governorates', {}), catalog.get('facilityServices', {})
    labs, hospitals = [], []
    for f in facilities:
        kind = f.get('kind')
        if not re.fullmatch(r'[0-9a-f-]{36}', str(f.get('id', ''))) or kind not in kinds or f.get('governorate') not in governorates or not f.get('facility_name'):
            continue
        governorate, offered = governorates[f['governorate']], [services.get(kind, {}).get(s) for s in f.get('services') or []]
        offered = [s for s in offered if s]
        record = {'name': f['facility_name'], 'city': governorate[0], 'city_ar': governorate[1],
                  'address': ', '.join(x for x in (f.get('address'), f.get('area')) if x), 'phone': f.get('phone') or '',
                  'type': kinds[kind][0], 'type_ar': kinds[kind][1], 'platform': True}
        if f.get('opening_hours'):
            record['hours'] = f['opening_hours'][:200]
        if kind in ('lab', 'imaging'):
            labs.append({**record, 'tests': [s[0] for s in offered], 'tests_ar': [s[1] for s in offered]})
        else:
            hospitals.append({**record, 'emergency': f.get('emergency') is True, 'services': [s[0] for s in offered], 'services_ar': [s[1] for s in offered]})
    for rows in (labs, hospitals):
        rows.sort(key=lambda r: (r['city'], r['name'].casefold()))
    return labs, hospitals


def update_platform_facilities():
    platform_url = platform_base_url()
    if not platform_url:
        return None
    catalog = json.loads(fetch(platform_url + '/api/catalog'))
    payload = json.loads(fetch(platform_url + '/api/facilities'))
    if not isinstance(payload.get('facilities'), list):
        raise ValueError('Platform facility list has changed')
    labs, hospitals = platform_facilities(catalog, payload['facilities'])
    for name, rows in (('labs', labs), ('hospitals', hospitals)):
        path = DATA / f'{name}.json'
        old = read(path, {})
        kept = [x for x in old.get('items', []) if isinstance(x, dict) and not x.get('platform')]
        write(path, {**old, 'platform_url': platform_url, 'items': rows + kept})
    return len(labs), len(hospitals)


def job_valid(item):
    deadline, published = parse_date(item.get('deadline')), parse_date(item.get('published'))
    exact_deadline = item.get('deadline_at') or (item.get('deadline') if 'T' in str(item.get('deadline')) else None)
    exact = parse_date(exact_deadline) if exact_deadline else None
    return bool(deadline and deadline.date() >= now().date() and (not exact_deadline or (exact and exact >= now())) and published and published <= now() + timedelta(hours=1)
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
    handlers = {'rss': news_records, 'sana_rss': sana_news, 'ministry_news': ministry_news,
                'sams_jobs': sams_jobs, 'ida_jobs': ida_jobs, 'nrc_jobs': nrc_jobs, 'drc_jobs': drc_jobs,
                'reliefweb_jobs': reliefweb_jobs}
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


def news_rss(items):
    """Original headlines and attribution for readers and publishing integrations."""
    rss = ElementTree.Element('rss', version='2.0')
    channel = ElementTree.SubElement(rss, 'channel')
    for tag, value in [('title', 'Syria Healthcare - source news'), ('link', 'https://syriahealthcare.com/#news'),
                       ('description', 'Original healthcare headlines about Syria, with links to their publishers.')]:
        ElementTree.SubElement(channel, tag).text = value
    seen = set()
    for item in items:
        url = canonical_url(item.get('url', ''))
        published = parse_date(item.get('published'))
        title = item.get('title') or item.get('title_en') or item.get('title_ar')
        if not url or url in seen or not title or item.get('verification_version') != VERSION or not published:
            continue
        if published < now() - timedelta(days=MAX_NEWS_DAYS) or published > now() + timedelta(hours=1):
            continue
        seen.add(url)
        entry = ElementTree.SubElement(channel, 'item')
        for tag, value in [('title', title), ('link', url), ('description', 'Source: ' + item.get('source', 'Original publisher')),
                           ('pubDate', format_datetime(published.astimezone(timezone.utc), usegmt=True))]:
            ElementTree.SubElement(entry, tag).text = value
        ElementTree.SubElement(entry, 'guid', isPermaLink='true').text = url
    ElementTree.indent(rss)
    return ElementTree.tostring(rss, encoding='utf-8', xml_declaration=True)


def write_news_rss(items):
    temporary = DATA / 'news.xml.tmp'
    temporary.write_bytes(news_rss(items))
    os.replace(temporary, DATA / 'news.xml')


def jobs_rss(items):
    """Verified, still-open vacancies with employer attribution and deadlines."""
    rss = ElementTree.Element('rss', version='2.0')
    channel = ElementTree.SubElement(rss, 'channel')
    for tag, value in [('title', 'Syria Healthcare - open vacancies'), ('link', 'https://syriahealthcare.com/#jobs'),
                       ('description', 'Verified healthcare and NGO vacancies in Syria, linked to the original employer listing.')]:
        ElementTree.SubElement(channel, tag).text = value
    seen = set()
    for item in items:
        url = canonical_url(item.get('url', ''))
        published = parse_date(item.get('published'))
        title = item.get('title_en') or item.get('title') or item.get('title_ar')
        if not url or url in seen or not title or item.get('verification_version') != VERSION or not published or not job_valid(item):
            continue
        seen.add(url)
        entry = ElementTree.SubElement(channel, 'item')
        description = f"{item.get('organisation', item.get('source', ''))} - {item.get('location', '')}. Closes {item['deadline']}. Confirm details on the original announcement."
        for tag, value in [('title', title), ('link', url), ('description', description),
                           ('pubDate', format_datetime(published.astimezone(timezone.utc), usegmt=True))]:
            ElementTree.SubElement(entry, tag).text = value
        ElementTree.SubElement(entry, 'guid', isPermaLink='true').text = url
    ElementTree.indent(rss)
    return ElementTree.tostring(rss, encoding='utf-8', xml_declaration=True)


def write_jobs_rss(items):
    temporary = DATA / 'jobs.xml.tmp'
    temporary.write_bytes(jobs_rss(items))
    os.replace(temporary, DATA / 'jobs.xml')


def retain_verified(item, kind, configured):
    verified = parse_date(item.get('verified_at'))
    published = parse_date(item.get('published'))
    if item.get('verification_version') != VERSION or item.get('source_id') not in configured or not canonical_url(item.get('url', '')):
        return False
    if not verified or verified > now() + timedelta(hours=1) or not published or published > now() + timedelta(hours=1):
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
    return result[:60 if kind == 'news' else 80]


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
        if kind == 'news':
            write_news_rss(items)
        else:
            write_jobs_rss(items)
        if not success:
            failed = True
    try:
        print(f'openstreetmap-hospitals: ok, {update_hospitals()} accepted', flush=True)
    except Exception as error:  # Keep the previous hospital list; this never blocks jobs and news.
        print(f'::warning::openstreetmap-hospitals: {error}', flush=True)
    try:
        count = update_platform_doctors()
        print('platform-doctors: ' + ('not configured (PLATFORM_URL is empty)' if count is None else f'ok, {count} accepted'), flush=True)
    except Exception as error:  # Keep the previous doctor list when the platform is unreachable.
        print(f'::warning::platform-doctors: {error}', flush=True)
    try:
        counts = update_platform_facilities()
        print('platform-facilities: ' + ('not configured (PLATFORM_URL is empty)' if counts is None else f'ok, {counts[0]} labs and {counts[1]} hospitals or clinics'), flush=True)
    except Exception as error:  # Keep the previous lists when the platform is unreachable.
        print(f'::warning::platform-facilities: {error}', flush=True)
    write(DATA / 'status.json', {'checked_at': checked, 'sources': sorted(status_rows, key=lambda s: s['id']), 'version': VERSION})
    summary = '\n'.join(f"- {s['id']}: {s['state']} — {s['accepted']} eligible items" for s in status_rows)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
            stream.write('## Source collection\n' + summary + '\n')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
