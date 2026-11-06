"""Tests for sanitize_url() — URL cleaning logic."""

import sys
import os

# Allow importing handshake.py from parent directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from handshake import sanitize_url


class TestSanitizeUrl:
    def test_removes_page_param(self):
        url = "https://app.joinhandshake.com/jobs?search=python&page=3"
        result = sanitize_url(url)
        assert "page=" not in result
        assert "search=python" in result

    def test_removes_utm_source(self):
        url = "https://app.joinhandshake.com/jobs?utm_source=email"
        result = sanitize_url(url)
        assert "utm_source" not in result

    def test_removes_utm_medium(self):
        url = "https://app.joinhandshake.com/jobs?utm_medium=social"
        result = sanitize_url(url)
        assert "utm_medium" not in result

    def test_removes_utm_campaign(self):
        url = "https://app.joinhandshake.com/jobs?utm_campaign=fall2024"
        result = sanitize_url(url)
        assert "utm_campaign" not in result

    def test_removes_ref_param(self):
        url = "https://app.joinhandshake.com/jobs?ref=homepage"
        result = sanitize_url(url)
        assert "ref=" not in result

    def test_preserves_search_query(self):
        url = "https://app.joinhandshake.com/jobs?search=engineer&page=2"
        result = sanitize_url(url)
        assert "search=engineer" in result

    def test_empty_url_returns_empty(self):
        assert sanitize_url("") == ""

    def test_url_without_params_unchanged(self):
        url = "https://app.joinhandshake.com/jobs"
        assert sanitize_url(url) == url

    def test_multiple_params_strips_only_bad_ones(self):
        url = "https://app.joinhandshake.com/jobs?search=python&page=2&sort=relevance&utm_source=x"
        result = sanitize_url(url)
        assert "search=python" in result
        assert "sort=relevance" in result
        assert "page=" not in result
        assert "utm_source" not in result
