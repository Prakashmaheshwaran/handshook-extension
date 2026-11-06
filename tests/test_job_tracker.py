"""Tests for JobTracker — add/check/prune logic with a temp JSON file."""

import pytest
from datetime import datetime, timezone, timedelta
from job_tracker import JobTracker


@pytest.fixture
def tmp_tracker(tmp_path):
    """Return a JobTracker backed by a temp file."""
    tracker_file = str(tmp_path / "tracker.json")
    return JobTracker(tracker_file=tracker_file)


class TestJobTrackerBasics:
    def test_new_tracker_is_empty(self, tmp_tracker):
        assert tmp_tracker.get_applied_count() == 0

    def test_track_applied(self, tmp_tracker):
        tmp_tracker.track_applied(1001, "Software Engineer", "Acme Corp")
        assert tmp_tracker.get_applied_count() == 1

    def test_is_tracked_permanent(self, tmp_tracker):
        tmp_tracker.track_applied(1001, "SE", "Corp")
        assert tmp_tracker.is_tracked(1001) == "applied"

    def test_is_tracked_external(self, tmp_tracker):
        tmp_tracker.track_external(2001, "Data Analyst", "BigCo")
        assert tmp_tracker.is_tracked(2001) == "external"

    def test_should_process_returns_false_for_applied(self, tmp_tracker):
        tmp_tracker.track_applied(3001, "Dev", "Co")
        assert tmp_tracker.should_process(3001) is False

    def test_should_process_returns_true_for_unknown(self, tmp_tracker):
        assert tmp_tracker.should_process(9999) is True

    def test_persists_to_file(self, tmp_path):
        tracker_file = str(tmp_path / "tracker.json")
        t1 = JobTracker(tracker_file=tracker_file)
        t1.track_applied(5001, "Engineer", "TechCorp")

        t2 = JobTracker(tracker_file=tracker_file)
        assert t2.get_applied_count() == 1
        assert t2.is_tracked(5001) == "applied"


class TestJobTrackerPrune:
    def _add_old_entry(self, tracker, category, job_id, days_old):
        """Add a tracker entry with a timestamp in the past."""
        old_dt = datetime.now(timezone.utc) - timedelta(days=days_old)
        tracker.data[category][str(job_id)] = {
            "name": f"Job {job_id}",
            "recorded_at": old_dt.isoformat(),
        }
        tracker._save()

    def test_prune_removes_old_external(self, tmp_tracker):
        self._add_old_entry(tmp_tracker, "external", 100, days_old=40)
        removed = tmp_tracker.prune(older_than_days=30)
        assert removed == 1
        assert tmp_tracker.is_tracked(100) is None

    def test_prune_keeps_recent_entries(self, tmp_tracker):
        self._add_old_entry(tmp_tracker, "external", 200, days_old=10)
        removed = tmp_tracker.prune(older_than_days=30)
        assert removed == 0
        assert tmp_tracker.is_tracked(200) == "external"

    def test_prune_never_removes_applied(self, tmp_tracker):
        """Applied entries must never be pruned."""
        tmp_tracker.track_applied(300, "Dev", "Corp")
        # Force an old timestamp
        tmp_tracker.data["applied"]["300"]["applied_at"] = (
            (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        )
        tmp_tracker._save()
        removed = tmp_tracker.prune(older_than_days=1)
        assert removed == 0
        assert tmp_tracker.is_tracked(300) == "applied"

    def test_prune_skipped_category(self, tmp_tracker):
        self._add_old_entry(tmp_tracker, "skipped", 400, days_old=60)
        removed = tmp_tracker.prune(older_than_days=30)
        assert removed == 1

    def test_prune_unsupported_category(self, tmp_tracker):
        self._add_old_entry(tmp_tracker, "unsupported", 500, days_old=60)
        removed = tmp_tracker.prune(older_than_days=30)
        assert removed == 1
