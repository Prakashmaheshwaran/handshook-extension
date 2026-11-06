"""Tests for identifier module — job ID validation and HTML extraction."""

from identifier import validate_job_id, validate_job_title, extract_ids_from_html


class TestValidateJobId:
    def test_valid_integer(self):
        assert validate_job_id(12345678) == 12345678

    def test_valid_string(self):
        assert validate_job_id("99999999") == 99999999

    def test_negative_returns_none(self):
        assert validate_job_id(-1) is None

    def test_zero_returns_none(self):
        assert validate_job_id(0) is None

    def test_non_numeric_string(self):
        assert validate_job_id("abc") is None

    def test_float_string(self):
        assert validate_job_id("1.5") is None

    def test_whitespace_trimmed(self):
        assert validate_job_id("  42  ") == 42


class TestValidateJobTitle:
    def test_normal_title(self):
        assert validate_job_title("Software Engineer") == "Software Engineer"

    def test_strips_whitespace(self):
        assert validate_job_title("  Dev  ") == "Dev"

    def test_none_returns_none(self):
        assert validate_job_title(None) is None

    def test_empty_string_returns_none(self):
        assert validate_job_title("") is None

    def test_whitespace_only_returns_none(self):
        assert validate_job_title("   ") is None

    def test_non_string_returns_none(self):
        assert validate_job_title(123) is None


class TestExtractIdsFromHtml:
    def test_extracts_stu_jobs_url(self):
        html = '<a href="/stu/jobs/10500001">Job</a>'
        ids = extract_ids_from_html(html)
        assert 10500001 in ids

    def test_extracts_jobs_url(self):
        html = '<a href="/jobs/20000001">Job</a>'
        ids = extract_ids_from_html(html)
        assert 20000001 in ids

    def test_extracts_data_job_id_attr(self):
        html = '<div data-job-id="15000001"></div>'
        ids = extract_ids_from_html(html)
        assert 15000001 in ids

    def test_filters_small_ids(self):
        # IDs <= 10000000 should be filtered out (search page IDs)
        html = '<a href="/jobs/1234567">Job</a>'
        ids = extract_ids_from_html(html)
        assert 1234567 not in ids

    def test_deduplicates_ids(self):
        html = '<a href="/stu/jobs/10500001"></a><a href="/jobs/10500001"></a>'
        ids = extract_ids_from_html(html)
        assert ids.count(10500001) == 1

    def test_empty_html(self):
        assert extract_ids_from_html("") == []
