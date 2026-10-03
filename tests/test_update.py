import gzip
import io
import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from scripts import update as u


class CollectorTests(unittest.TestCase):
    def test_news_rss_preserves_headlines_and_stable_ids(self):
        item = self.verified(self.news(title='Syria & health <news> أخبار', source='Publisher'))
        root = u.ElementTree.fromstring(u.news_rss([item, item]))
        entries = root.findall('./channel/item')
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].findtext('title'), item['title'])
        self.assertEqual(entries[0].findtext('link'), item['url'])
        self.assertEqual(entries[0].findtext('description'), 'Source: Publisher')
        changed = {**item, 'verified_at': (u.now() + timedelta(hours=12)).isoformat()}
        next_root = u.ElementTree.fromstring(u.news_rss([changed]))
        self.assertEqual(entries[0].findtext('guid'), next_root.findtext('./channel/item/guid'))
        self.assertEqual(entries[0].findtext('pubDate'), next_root.findtext('./channel/item/pubDate'))

    def test_news_rss_rejects_unsafe_unverified_and_old_items(self):
        items = [self.news(), self.verified(self.news(url='javascript:alert(1)')),
                 self.verified(self.news(published=(u.now() - timedelta(days=46)).isoformat())),
                 self.verified(self.news(published=(u.now() + timedelta(days=2)).isoformat()))]
        self.assertEqual(u.ElementTree.fromstring(u.news_rss(items)).findall('./channel/item'), [])

    def news(self, **fields):
        return {'title': 'New cardiac services in Syria', 'url': 'https://example.org/clinic', 'published': u.now().isoformat(), 'raw_summary': 'Hospital teams in Damascus provide cardiac care.', **fields}

    def job(self, **fields):
        return {'title': 'Nurse', 'url': 'https://example.org/job', 'published': u.now().isoformat(), 'deadline': (u.now() + timedelta(days=2)).date().isoformat(), 'location': 'Syria / Aleppo', **fields}

    def verified(self, item, kind='news'):
        return {**item, 'verification_version': 2, 'source_id': 'example', 'verified_at': u.now().isoformat()}

    def test_gzip_feed_decoding(self):
        xml = b'<rss><channel /></rss>'
        response = io.BytesIO(gzip.compress(xml)); response.status = 200
        with patch.object(u.urllib.request, 'urlopen', return_value=response):
            self.assertEqual(u.fetch('https://example.org/feed'), xml)

    def test_original_headlines_and_html_entities(self):
        xml = b'<rss><channel><item><title>Health &amp; care in Syria</title><link>https://example.org/clinic</link><pubDate>Thu, 01 Oct 2026 10:00:00 +0000</pubDate><description>&lt;p&gt;Clinic news&lt;/p&gt;</description></item></channel></rss>'
        row = u.parse_feed(xml, 'Example')[0]
        self.assertEqual(row['title'], 'Health & care in Syria')
        self.assertEqual(row['raw_summary'], 'Clinic news')

    def test_atom_uses_article_link_not_self_link(self):
        xml = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Clinic</title><link rel="self" href="https://example.org/api"/><link rel="alternate" href="https://example.org/article"/><updated>2026-10-01T10:00:00Z</updated></entry></feed>'
        self.assertEqual(u.parse_feed(xml, 'Example')[0]['url'], 'https://example.org/article')

    def test_non_feed_responses_fail(self):
        with self.assertRaises(ValueError):
            u.parse_feed(b'<html></html>', 'Example')

    def test_unsafe_urls_are_rejected(self):
        for url in ['javascript:alert(1)', 'https://user:password@example.org', 'not-a-url']:
            self.assertFalse(u.canonical_url(url))

    def test_eligible_syria_health_news(self):
        self.assertTrue(u.eligible_news(self.news()))

    def test_foreign_and_nonmedical_news_are_rejected(self):
        for title, body in [('Floods in Nepal', 'Flood recovery in Nepal'), ('Hospital opens in Sudan', 'Published by Syrian American Medical Society Foundation'), ('Election campaign in Syria', 'New political party in Damascus')]:
            self.assertFalse(u.eligible_news(self.news(title=title, raw_summary=body)))

    def test_publisher_footer_is_not_country_evidence(self):
        self.assertEqual(u.clean_body('Hospital in Nepal. The post Hospital first appeared on Syrian American Medical Society.'), 'Hospital in Nepal.')
        self.assertFalse(u.eligible_news(self.news(title='Hospital in Nepal', raw_summary='Syrian American Medical Society Foundation')))

    def test_news_requires_recent_nonfuture_date(self):
        for date in [None, 'nonsense', (u.now() - timedelta(days=46)).isoformat(), (u.now() + timedelta(days=3)).isoformat()]:
            self.assertFalse(u.eligible_news(self.news(published=date)))

    def test_jobs_require_syria_and_confirmed_open_deadline(self):
        self.assertTrue(u.job_valid(self.job()))
        for fields in [{'deadline': None}, {'deadline': '2026-02-31'}, {'deadline': (u.now()-timedelta(days=1)).date().isoformat()}, {'location': 'Nigeria'}, {'location': ''}, {'published': (u.now()+timedelta(days=4)).isoformat()}]:
            self.assertFalse(u.job_valid(self.job(**fields)))

    def test_job_stays_open_on_closing_date(self):
        self.assertTrue(u.job_valid(self.job(deadline=u.now().date().isoformat())))

    def test_legacy_records_are_never_retained(self):
        statuses = [{'id': 'example', 'state': 'error'}]
        self.assertEqual(u.merge_records([self.news()], [], 'news', statuses), [])
        self.assertEqual(u.merge_records([self.job()], [], 'jobs', statuses), [])

    def test_successful_employer_snapshot_removes_withdrawn_jobs(self):
        self.assertEqual(u.merge_records([self.verified(self.job())], [], 'jobs', [{'id':'example', 'state':'ok'}]), [])

    def test_failed_employer_keeps_only_recently_checked_unexpired_jobs(self):
        good = self.verified(self.job())
        old = {**good, 'verified_at': (u.now()-timedelta(hours=73)).isoformat()}
        statuses = [{'id':'example', 'state':'error'}]
        self.assertEqual(u.merge_records([good], [], 'jobs', statuses), [good])
        self.assertEqual(u.merge_records([old], [], 'jobs', statuses), [])

    def test_deduplicate_tracking_links_and_matching_headlines(self):
        a = self.verified(self.news())
        b = {**a, 'url': a['url']+'?utm_source=rss'}
        c = {**a, 'url': 'https://example.org/duplicate'}
        self.assertEqual(len(u.merge_records([], [a,b,c], 'news', [{'id':'example','state':'ok'}])), 1)

    def test_sams_filters_closed_and_foreign_positions(self):
        source = {'id':'sams', 'name':'SAMS', 'organisation':'SAMS', 'website':'https://example.org/jobs', 'url':'https://example.org/api'}
        row = {'PositionName':'Nurse', 'PositionForCondidateID':10, 'StartingDate':u.now().date().isoformat(), 'EndingDate':(u.now()+timedelta(days=3)).date().isoformat(), 'PositionLocationName':'Syria / Damascus', 'btnwork':True, 'StatusOfPositionName':'Available'}
        payload = {'success':True,'data':[row,{**row,'PositionForCondidateID':11,'btnwork':False},{**row,'PositionForCondidateID':12,'PositionLocationName':'Jordan'}]}
        with patch.object(u, 'fetch', return_value=json.dumps(payload).encode()):
            records, _ = u.sams_jobs(source)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['reference'], '10')
        self.assertEqual(records[0]['evidence']['deadline'], row['EndingDate'])

    def test_ida_details_supply_location_and_deadline(self):
        deadline = (u.now()+timedelta(days=2)).strftime('%B %d, %Y')
        page = f'<p>Expiry Date: {deadline}</p><p>Position: Nurse</p><p>Department: Health</p><p>Workspace: Syria - Aleppo City</p><p>IDA is a medical organization.</p>'
        source = {'id':'ida','name':'IDA','organisation':'IDA','url':'https://example.org/feed/'}
        with patch.object(u, 'fetch', return_value=page.encode()):
            record = u.ida_detail(self.job(),source)
        self.assertEqual(record['location'], 'Syria - Aleppo City')
        self.assertEqual(record['title_en'], 'Nurse')

    def test_ida_missing_fields_fail_without_guessing(self):
        with patch.object(u,'fetch',return_value=b'<p>Nurse in Syria. Apply soon.</p>'):
            with self.assertRaises(ValueError):
                u.ida_detail(self.job(), {'url':'https://example.org/feed/'})

    def test_atomic_json_is_valid_unicode(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'data.json'
            u.write(path, {'items':[{'title':'ممرض'}]})
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['items'][0]['title'],'ممرض')
            self.assertFalse(path.with_suffix('.tmp').exists())

    def test_source_failure_is_reported_not_silently_empty(self):
        with patch.object(u,'fetch',side_effect=OSError('unavailable')):
            records, status = u.collect_source({'id':'example','name':'Example','adapter':'rss','url':'https://example.org/feed'},'news')
        self.assertEqual(records,[])
        self.assertEqual(status['state'],'error')

    def test_exact_job_deadline_expires_within_day(self):
        self.assertFalse(u.job_valid(self.job(deadline=(u.now()-timedelta(minutes=1)).isoformat())))

    def test_nrc_imports_only_public_syria_jobs(self):
        source = {'id':'nrc-jobs','name':'NRC','organisation':'Norwegian Refugee Council','sector':'ngo','adapter':'nrc_jobs','url':'https://example.org/jobs'}
        row = {'Id':'123','TenantId':'23109900','Heading':'Programme officer','IsInternet':True,'WorkPlaceFacet':'Syria','Workplace3':'Damascus','PublishedDate':u.now().strftime('%d/%m/%Y'),'ApplicationDeadline':(u.now()+timedelta(days=3)).isoformat(),'OpenAdvertUrl':'https://23109900.webcruiter.no/Main/Recruit/Public/123','JobType':'Contract'}
        payload = {'Total':4,'Data':[row,{**row,'IsInternet':False},{**row,'WorkPlaceFacet':'Venezuela'},{**row,'TenantId':'unrelated'}]}
        with patch.object(u,'fetch',return_value=json.dumps(payload).encode()):
            records, total = u.nrc_jobs(source)
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['sector'],'ngo')
        self.assertEqual(records[0]['location'],'Syria / Damascus')
        self.assertIn('deadline_at',records[0])
        self.assertFalse(records[0]['listing_page'])

    def test_nrc_rejects_incomplete_snapshot(self):
        with patch.object(u,'fetch',return_value=b'{"Total":5,"Data":[]}'):
            with self.assertRaises(ValueError):
                u.nrc_jobs({'url':'https://example.org/jobs'})

    def test_drc_filters_country_and_source_dates(self):
        date = (u.now()+timedelta(days=3)).strftime('%m/%d/%Y %I:%M:%S %p')
        published = u.now().strftime('%m/%d/%Y %I:%M:%S %p')
        row = f'<article class="jobList__item" data-title="Protection Officer" data-country="Syria" data-published="{published}" data-deadline="{date}"><a href="/jobs/job?id=12"></a></article>'
        page = '<section id="jobList">'+row+row.replace('Syria','Ukraine')+'</section>'
        source = {'id':'drc-jobs','name':'DRC','organisation':'Danish Refugee Council','sector':'ngo','adapter':'drc_jobs','url':'https://drc.ngo/en/about-us/careers/vacancies/'}
        with patch.object(u,'fetch',return_value=page.encode()):
            records, total = u.drc_jobs(source)
        self.assertEqual(total,2)
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['url'],'https://drc.ngo/jobs/job?id=12')

if __name__ == '__main__':
    unittest.main()
