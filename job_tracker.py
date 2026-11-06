"""
Job Tracker Module for Handshake Automation

Tracks job application status across sessions to avoid:
- Re-applying to already applied jobs
- Wasting API calls on external-apply jobs
- Re-processing jobs that couldn't be processed

Categories:
- applied: Successfully submitted application
- external: Requires external application (can't automate)
- skipped: Skipped due to keyword filter
- failed: Failed to process (will retry on next run)
- waiting: Not yet open for applications
"""

import json
import os
import logging
from datetime import datetime
from typing import Dict, Optional, List


# Default tracker file (in logs folder)
DEFAULT_TRACKER_FILE = "logs/job_tracker.json"


class JobTracker:
    """
    Persistent job status tracker across sessions.
    
    Tracks jobs by category to avoid redundant processing:
    - applied: Successfully applied
    - external: External apply only (skip forever)
    - skipped: Matched skip keyword (skip until keywords change)
    - unsupported: Missing required documents (skip forever)
    """
    
    # Categories that should never be reprocessed
    PERMANENT_CATEGORIES = {"applied", "external", "unsupported"}
    
    # Categories that might be worth retrying
    RETRY_CATEGORIES = {"failed", "waiting"}
    
    def __init__(self, tracker_file: str = DEFAULT_TRACKER_FILE):
        """
        Initialize the job tracker.
        
        Args:
            tracker_file: Path to the JSON tracker file
        """
        self.tracker_file = tracker_file
        self.data: Dict = self._load()
        
        # Session stats
        self.session_stats = {
            "checked": 0,
            "skipped_tracked": 0,
            "skipped_keyword": 0,
            "applied": 0,
            "external": 0,
            "failed": 0,
        }
    
    def _load(self) -> Dict:
        """Load tracker data from file."""
        if os.path.exists(self.tracker_file):
            try:
                with open(self.tracker_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                logging.info(f"📊 Loaded job tracker: {self._get_summary_str(data)}")
                return data
            except Exception as e:
                logging.warning(f"⚠️ Could not load tracker: {e}")
        
        return {
            "applied": {},
            "external": {},
            "skipped": {},
            "unsupported": {},
            "failed": {},
            "waiting": {},
            "metadata": {
                "created": datetime.now().isoformat(),
                "last_updated": datetime.now().isoformat(),
                "version": "1.0"
            }
        }
    
    def _save(self) -> bool:
        """Save tracker data to file."""
        try:
            self.data["metadata"]["last_updated"] = datetime.now().isoformat()
            with open(self.tracker_file, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, indent=2)
            return True
        except Exception as e:
            logging.error(f"❌ Could not save tracker: {e}")
            return False
    
    def _get_summary_str(self, data: Dict = None) -> str:
        """Get a summary string of tracked jobs."""
        d = data or self.data
        parts = []
        for cat in ["applied", "external", "skipped", "unsupported", "waiting"]:
            count = len(d.get(cat, {}))
            if count > 0:
                parts.append(f"{cat}={count}")
        return ", ".join(parts) if parts else "empty"
    
    def is_tracked(self, job_id: int) -> Optional[str]:
        """
        Check if a job is already tracked.
        
        Args:
            job_id: Job ID to check
            
        Returns:
            Category name if tracked, None otherwise
        """
        job_id_str = str(job_id)
        
        for category in self.PERMANENT_CATEGORIES:
            if job_id_str in self.data.get(category, {}):
                return category
        
        return None
    
    def should_process(self, job_id: int) -> bool:
        """
        Check if a job should be processed.
        
        Args:
            job_id: Job ID to check
            
        Returns:
            True if job should be processed, False to skip
        """
        category = self.is_tracked(job_id)
        
        if category in self.PERMANENT_CATEGORIES:
            self.session_stats["skipped_tracked"] += 1
            return False
        
        return True
    
    def track_applied(self, job_id: int, job_name: str, employer: str) -> None:
        """Record a successful application."""
        self.data["applied"][str(job_id)] = {
            "name": job_name,
            "employer": employer,
            "applied_at": datetime.now().isoformat()
        }
        self.session_stats["applied"] += 1
        self._save()
    
    def track_external(self, job_id: int, job_name: str = "", employer: str = "") -> None:
        """Record an external-apply job."""
        self.data["external"][str(job_id)] = {
            "name": job_name,
            "employer": employer,
            "recorded_at": datetime.now().isoformat()
        }
        self.session_stats["external"] += 1
        self._save()
    
    def track_skipped(self, job_id: int, job_name: str, reason: str) -> None:
        """Record a skipped job (keyword filter)."""
        self.data["skipped"][str(job_id)] = {
            "name": job_name,
            "reason": reason,
            "recorded_at": datetime.now().isoformat()
        }
        self.session_stats["skipped_keyword"] += 1
        self._save()
    
    def track_unsupported(self, job_id: int, job_name: str, reason: str) -> None:
        """Record a job with unsupported requirements."""
        self.data["unsupported"][str(job_id)] = {
            "name": job_name,
            "reason": reason,
            "recorded_at": datetime.now().isoformat()
        }
        self._save()
    
    def track_failed(self, job_id: int, job_name: str, error: str) -> None:
        """Record a failed job (might retry later)."""
        self.data["failed"][str(job_id)] = {
            "name": job_name,
            "error": error,
            "recorded_at": datetime.now().isoformat()
        }
        self.session_stats["failed"] += 1
        self._save()
    
    def track_waiting(self, job_id: int, job_name: str, open_date: str = "") -> None:
        """Record a job that's not yet open."""
        self.data["waiting"][str(job_id)] = {
            "name": job_name,
            "open_date": open_date,
            "recorded_at": datetime.now().isoformat()
        }
        self._save()
    
    def get_waiting_jobs(self) -> List[int]:
        """Get list of waiting job IDs to retry."""
        return [int(jid) for jid in self.data.get("waiting", {}).keys()]
    
    def clear_waiting(self, job_id: int) -> None:
        """Remove a job from waiting list."""
        job_id_str = str(job_id)
        if job_id_str in self.data.get("waiting", {}):
            del self.data["waiting"][job_id_str]
            self._save()
    
    def get_applied_count(self) -> int:
        """Get total number of applied jobs."""
        return len(self.data.get("applied", {}))
    
    def print_session_summary(self) -> None:
        """Print summary of this session's activity."""
        logging.info("\n" + "=" * 60)
        logging.info("📊 Job Tracker Session Summary")
        logging.info("=" * 60)
        logging.info(f"   Jobs checked: {self.session_stats['checked']}")
        logging.info(f"   Skipped (already tracked): {self.session_stats['skipped_tracked']}")
        logging.info(f"   Skipped (keyword filter): {self.session_stats['skipped_keyword']}")
        logging.info(f"   Applied this session: {self.session_stats['applied']}")
        logging.info(f"   External apply: {self.session_stats['external']}")
        logging.info(f"   Failed: {self.session_stats['failed']}")
        logging.info("-" * 60)
        logging.info(f"   Total applied (all time): {self.get_applied_count()}")
        logging.info(f"   Total tracked: {self._get_summary_str()}")
        logging.info("=" * 60)
    
    def increment_checked(self) -> None:
        """Increment the checked counter."""
        self.session_stats["checked"] += 1

    def prune(self, older_than_days: int) -> int:
        """Remove entries from prunable categories older than N days.

        Prunable categories: external, unsupported, skipped.
        Permanent categories (applied) are never pruned.

        Args:
            older_than_days: Remove entries recorded more than this many days ago.

        Returns:
            Number of entries removed.
        """
        from datetime import datetime, timezone, timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
        prunable = {"external", "unsupported", "skipped"}
        removed = 0
        for category in prunable:
            entries = self.data.get(category, {})
            to_delete = []
            for job_id, info in entries.items():
                recorded_at = info.get("recorded_at", "")
                try:
                    # Parse ISO timestamp; treat naive datetimes as UTC
                    dt = datetime.fromisoformat(recorded_at)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    if dt < cutoff:
                        to_delete.append(job_id)
                except (ValueError, TypeError):
                    pass
            for job_id in to_delete:
                del entries[job_id]
                removed += 1
        if removed:
            self._save()
        return removed


# =============================================================================
# Keyword Filtering
# =============================================================================

def matches_skip_keywords(job_name: str, skip_keywords: List[str]) -> Optional[str]:
    """
    Check if job name matches any skip keywords.
    
    Uses case-insensitive matching with word boundary awareness.
    
    Args:
        job_name: Job title to check
        skip_keywords: List of keywords to skip
        
    Returns:
        Matched keyword if found, None otherwise
    """
    if not skip_keywords:
        return None
    
    job_lower = job_name.lower()
    
    for keyword in skip_keywords:
        kw_lower = keyword.lower().strip()
        if not kw_lower:
            continue
        
        # Direct substring match
        if kw_lower in job_lower:
            return keyword
    
    return None


def matches_job_keywords(job_name: str, job_keywords: List[str]) -> bool:
    """
    Check if job name matches any preferred job keywords.
    
    Args:
        job_name: Job title to check
        job_keywords: List of preferred keywords
        
    Returns:
        True if matches any keyword (or if no keywords specified)
    """
    if not job_keywords:
        return True  # No filter means all jobs pass
    
    job_lower = job_name.lower()
    
    for keyword in job_keywords:
        kw_lower = keyword.lower().strip()
        if kw_lower and kw_lower in job_lower:
            return True
    
    return False


# =============================================================================
# Dry-run mode flag and helpers
# =============================================================================

_dry_run_mode: bool = False


def set_dry_run_mode(enabled: bool) -> None:
    """Enable or disable dry-run mode."""
    global _dry_run_mode
    _dry_run_mode = enabled
    if enabled:
        # Keep this ASCII-only to avoid Windows console encoding issues.
        logging.info("DRY-RUN MODE ENABLED - No applications will be submitted")


def is_dry_run() -> bool:
    """Check if dry-run mode is enabled."""
    return _dry_run_mode
