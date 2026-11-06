"""Offline regressions for the legacy CLI's browser queue and transcript config."""

from unittest.mock import Mock

import pytest

import browser_automation
import config_loader
import handshake


@pytest.fixture
def profile_run(monkeypatch, tmp_path):
    """Run real profile orchestration with synthetic jobs and no browser/network IO."""
    config = {"RESUMES": [{"id": 1001}], "COVER_LETTER_ID": 2001}
    monkeypatch.setattr(config_loader, "load_conf", lambda: config)
    monkeypatch.setattr(config_loader, "load_cookies", lambda: {"synthetic_session": "fixture"})
    paths = {
        "jobs_file": tmp_path / "jobs.csv",
        "new_jobs_file": tmp_path / "new_jobs.csv",
        "wait_file": tmp_path / "wait.json",
        "html_folder": tmp_path / "html",
    }
    monkeypatch.setattr(handshake, "get_profile_paths", lambda name: paths)
    monkeypatch.setattr(handshake.atexit, "register", Mock())
    monkeypatch.setattr(handshake, "cleanup_new_jobs_file", Mock())
    monkeypatch.setattr(handshake, "check_and_extract_html", Mock())
    monkeypatch.setattr(handshake, "read_new_jobs", lambda path: ["10000001", "10000002"])
    monkeypatch.setattr(handshake, "load_rate_config", lambda: {})
    monkeypatch.setattr(handshake, "RateLimiter", Mock())
    monkeypatch.setattr(handshake, "is_dry_run", lambda: True)
    monkeypatch.setattr(handshake.Job, "set", Mock())

    def fetch_details(job):
        if job.id == 10000001:
            return False
        job.name = "Synthetic Engineer"
        job.apply_type = "handshake"
        job.full_details = {"job": {"description": "Synthetic description"}}
        return True

    monkeypatch.setattr(handshake.Job, "fetch_details", fetch_details)
    match_resume = Mock(return_value=1002)
    monkeypatch.setattr(handshake, "match_resume_with_ai", match_resume)
    monkeypatch.setattr(handshake, "get_resume_details", lambda resume_id: None)
    browser_apply = Mock(return_value={10000001: True, 10000002: True})
    monkeypatch.setattr(browser_automation, "apply_to_jobs_via_browser", browser_apply)
    tracker = Mock()
    tracker.is_tracked.return_value = None

    def run():
        profile = handshake.read_conf()[0]
        handshake.process_profile(profile, tracker, session=Mock())
        return profile

    return config, run, browser_apply, match_resume


def test_failed_detail_fetch_queues_default_resume_and_continues(profile_run):
    _, run, browser_apply, match_resume = profile_run

    run()

    browser_apply.assert_called_once()
    assert browser_apply.call_args.kwargs["job_ids"] == [10000001, 10000002]
    assert browser_apply.call_args.kwargs["resume_ids"] == {10000001: None, 10000002: 1002}
    assert browser_apply.call_args.kwargs["dry_run"] is True
    match_resume.assert_called_once_with("Synthetic Engineer", job_description="Synthetic description")


@pytest.mark.parametrize(
    ("transcript_config", "expected"),
    [
        ({"TRANSCRIPT_ID": 3001}, 3001),
        ({"TRANSCRIPT": 3002}, 3002),
        ({"TRANSCRIPT_ID": 3001, "TRANSCRIPT": 3002}, 3001),
        ({"TRANSCRIPT_ID": None, "TRANSCRIPT": 3002}, 3002),
        ({"TRANSCRIPT_ID": None}, None),
        ({}, None),
    ],
)
def test_transcript_config_matches_profile_and_browser(profile_run, monkeypatch, transcript_config, expected):
    config, run, browser_apply, _ = profile_run
    config.update(transcript_config)
    monkeypatch.setattr(handshake, "read_new_jobs", lambda path: ["10000002"])

    profile = run()

    assert profile["transcript"] == expected
    browser_apply.assert_called_once()
    assert browser_apply.call_args.kwargs["transcript_id"] == expected
