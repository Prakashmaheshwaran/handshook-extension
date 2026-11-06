"""Tests for resume_matcher — cache key generation and fallback logging."""

import logging
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Patch RESUMES before importing to avoid needing conf.json during tests
import resume_matcher as _rm  # noqa: E402 - must come after sys.path setup


@pytest.fixture(autouse=True)
def patch_resumes(monkeypatch):
    """Inject a fake RESUMES list so tests run without conf.json."""
    fake_resumes = [
        {"id": 1001, "title": "SE Resume", "description": "Software Engineer"},
        {"id": 1002, "title": "DS Resume", "description": "Data Scientist"},
    ]
    monkeypatch.setattr(_rm, "RESUMES", fake_resumes)
    # Clear the cache between tests
    _rm._cache.clear()
    yield
    _rm._cache.clear()


class TestCacheKey:
    def test_key_is_sha256_hex(self):
        key = _rm._cache_key("Engineer", "some description")
        assert len(key) == 64
        assert all(c in "0123456789abcdef" for c in key)

    def test_full_description_used(self):
        """Cache key must use the FULL description (not first 200 chars)."""
        short_desc = "x" * 200
        long_desc = "x" * 200 + " extra"
        key_short = _rm._cache_key("Title", short_desc)
        key_long = _rm._cache_key("Title", long_desc)
        assert key_short != key_long

    def test_same_inputs_same_key(self):
        k1 = _rm._cache_key("Title", "desc")
        k2 = _rm._cache_key("Title", "desc")
        assert k1 == k2

    def test_different_inputs_different_key(self):
        assert _rm._cache_key("A", "B") != _rm._cache_key("A", "C")


class TestAIFallback:
    def test_fallback_logs_warning_when_no_client(self, caplog):
        """When Gemini client is None, should log a WARNING with fallback details."""
        import resume_matcher as rm
        original_client = rm.client
        rm.client = None
        try:
            with caplog.at_level(logging.WARNING):
                result = rm.match_resume_with_ai("Software Engineer", use_cache=False)
            assert result == 1001  # first resume's id
            assert any("FALLBACK" in r.message for r in caplog.records)
        finally:
            rm.client = original_client

    def test_cache_hit_returns_cached_id(self):
        key = _rm._cache_key("Eng", "desc")
        _rm._cache[key] = 1002
        result = _rm.match_resume_with_ai("Eng", "desc", use_cache=True)
        assert result == 1002


class TestGetResumeDetails:
    def test_returns_correct_resume(self):
        details = _rm.get_resume_details(1001)
        assert details is not None
        assert details["title"] == "SE Resume"

    def test_returns_none_for_unknown_id(self):
        assert _rm.get_resume_details(9999) is None
