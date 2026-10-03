import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from scripts import update


class CollectorTests(unittest.TestCase):
    def item(self, url="https://example.org/story", **fields):
        return {"url": url, "title_en": "Health in Syria", "published": datetime.now(timezone.utc), **fields}

    def test_deduplicates_tracking_urls_across_fresh_and_existing(self):
        old = self.item("https://example.org/story?utm_source=rss")
        fresh = self.item("https://example.org/story#top", title_en="Updated")
        merged = update.merge([old], [fresh, fresh], 60)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["title_en"], "Updated")

    def test_rejects_unsafe_links(self):
        self.assertEqual(update.merge([], [self.item("javascript:alert(1)")], 60), [])

    def test_jobs_expire_after_deadline_but_not_on_closing_day(self):
        today = datetime.now(timezone.utc).date()
        expired = self.item(deadline=(today - timedelta(days=1)).isoformat())
        current = self.item("https://example.org/current", deadline=today.isoformat())
        self.assertEqual(update.merge([], [expired, current], 40, "jobs"), [current])

    def test_extracts_only_explicit_closing_date(self):
        xml = b'<rss><channel><item><title>Nurse</title><link>https://example.org/job</link><description>Closing date: 16 Oct 2026</description></item></channel></rss>'
        self.assertEqual(update.parse_feed(xml, "Jobs")[0]["deadline"], "2026-10-16")

    def test_invalid_feed_is_a_failure_not_an_empty_success(self):
        for content in (b'<html></html>', b'broken xml'):
            with self.assertRaises(ValueError):
                update.parse_feed(content, "Broken")

    def test_atom_dates_and_links(self):
        xml = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Clinic</title><link href="https://example.org/clinic"/><updated>2026-10-01T10:00:00Z</updated><summary>Health news</summary></entry></feed>'
        item = update.parse_feed(xml, "Atom")[0]
        self.assertEqual(item["published"].day, 1)
        self.assertEqual(item["url"], "https://example.org/clinic")

    def test_missing_credentials_do_not_publish_unfiltered_items(self):
        with patch.dict(update.os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                update.screen([self.item()], "news")

    def test_incomplete_ai_response_does_not_discard_unreviewed_items(self):
        with patch.object(update, "llm_config", return_value=("url", "key", "model")), patch.object(update, "call_llm", return_value=[]):
            with self.assertRaises(ValueError):
                update.screen([self.item()], "news")

    def test_string_true_is_not_a_valid_ai_decision(self):
        with patch.object(update, "llm_config", return_value=("url", "key", "model")), patch.object(update, "call_llm", return_value=[{"n": 1, "keep": "true"}]):
            with self.assertRaises(ValueError):
                update.screen([self.item()], "news")

    def test_failure_preserves_existing_content_and_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "sources.json"
            sources.write_text('{"news":[],"jobs":[]}', encoding="utf-8")
            news, jobs = root / "news.json", root / "jobs.json"
            saved = '{"updated":"2026-09-01","items":[]}'
            news.write_text(saved, encoding="utf-8")
            jobs.write_text(saved, encoding="utf-8")
            with patch.object(update, "SOURCES", str(sources)), patch.object(update, "NEWS_FILE", str(news)), patch.object(update, "JOBS_FILE", str(jobs)):
                self.assertEqual(update.main(), 1)
            self.assertEqual(news.read_text(encoding="utf-8"), saved)
            self.assertEqual(jobs.read_text(encoding="utf-8"), saved)


if __name__ == "__main__":
    unittest.main()
