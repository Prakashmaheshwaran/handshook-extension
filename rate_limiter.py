"""
Rate Limiter Module for Handshake Job Automation

This module provides rate limiting and ban protection features to prevent
getting banned by Handshake for applying to too many jobs too quickly.

Features:
- Random delays between applications (60-120 seconds)
- Daily application limits
- Session-based batching with breaks
- Exponential backoff on errors
- Statistics tracking
"""

import random
import re
import time
import json
import os
import logging
from datetime import datetime, date


# Default configuration (can be overridden by conf.json)
DEFAULT_CONFIG = {
    "min_delay_seconds": 60,          # Minimum delay between applications
    "max_delay_seconds": 120,         # Maximum delay between applications
    "daily_limit": 50,                # Max applications per day
    "session_batch_size": 10,         # Applications before taking a break
    "session_break_min": 300,         # 5 minute minimum break
    "session_break_max": 600,         # 10 minute maximum break
    "jitter_percent": 10,             # ±10% variance on all wait times
    "enabled": True                   # Toggle rate limiting on/off
}


class RateLimiter:
    """Manages rate limiting and application tracking for Handshake automation."""
    
    def __init__(self, profile_name, config=None):
        """
        Initialize the rate limiter.
        
        Args:
            profile_name: Name of the profile (for tracking files)
            config: Optional configuration dict to override defaults
        """
        self.profile_name = self._sanitize_name(profile_name)
        self.config = {**DEFAULT_CONFIG, **(config or {})}
        
        # Tracking file paths (in data folder)
        self.stats_file = f"data/rate_stats_{self.profile_name}.json"
        
        # Session tracking
        self.session_applications = 0
        self.consecutive_errors = 0
        self.session_start = datetime.now()
        
        # Load existing stats
        self.stats = self._load_stats()
        
        logging.info(f"🛡️  Rate Limiter initialized for profile: {profile_name}")
        self._print_config()
    
    def _sanitize_name(self, name):
        """Convert profile name to safe filename."""
        sanitized = re.sub(r'[^a-zA-Z0-9]+', '_', name)
        return sanitized.strip('_')
    
    def _print_config(self):
        """Display current rate limiting configuration."""
        if not self.config["enabled"]:
            logging.warning("   ⚠️  Rate limiting is DISABLED")
            return
        
        logging.info(f"   📊 Delay between applications: {self.config['min_delay_seconds']}-{self.config['max_delay_seconds']}s")
        logging.info(f"   📊 Daily limit: {self.config['daily_limit']} applications")
        logging.info(f"   📊 Session break: Every {self.config['session_batch_size']} applications")
        logging.info(f"   📊 Today's applications so far: {self._get_today_count()}")
    
    def _load_stats(self):
        """Load statistics from file."""
        try:
            if os.path.exists(self.stats_file):
                with open(self.stats_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logging.warning(f"   ⚠️  Could not load stats: {e}")
        
        return {
            "daily_counts": {},
            "total_applications": 0,
            "last_application": None,
            "history": []
        }
    
    def _save_stats(self):
        """Save statistics to file."""
        try:
            with open(self.stats_file, 'w') as f:
                json.dump(self.stats, f, indent=2)
        except Exception as e:
            logging.warning(f"   ⚠️  Could not save stats: {e}")
    
    def _get_today_count(self):
        """Get the number of applications made today."""
        today = str(date.today())
        return self.stats.get("daily_counts", {}).get(today, 0)
    
    def _add_jitter(self, seconds):
        """Add random jitter to a wait time."""
        jitter_range = seconds * (self.config["jitter_percent"] / 100)
        jitter = random.uniform(-jitter_range, jitter_range)
        return max(1, seconds + jitter)
    
    def can_apply_today(self):
        """Check if we can apply to more jobs today."""
        if not self.config["enabled"]:
            return True
        
        today_count = self._get_today_count()
        daily_limit = self.config["daily_limit"]
        
        if today_count >= daily_limit:
            logging.warning(f"\n🛑 Daily limit reached! ({today_count}/{daily_limit} applications today)")
            logging.warning("   Please wait until tomorrow to apply to more jobs.")
            return False
        
        remaining = daily_limit - today_count
        logging.info(f"\n📊 Daily applications: {today_count}/{daily_limit} (remaining: {remaining})")
        return True
    
    def get_remaining_today(self):
        """Get the number of remaining applications allowed today."""
        return max(0, self.config["daily_limit"] - self._get_today_count())
    
    def wait_before_apply(self, job_name=None):
        """
        Wait before applying to a job. This is the main rate limiting function.
        
        Args:
            job_name: Optional job name for display purposes
        
        Returns:
            True if we should proceed, False if rate limited
        """
        if not self.config["enabled"]:
            return True
        
        # Check daily limit
        if not self.can_apply_today():
            return False
        
        # Check if we need a session break
        if self._should_take_break():
            self._take_session_break()
        
        # Calculate delay with exponential backoff if there were errors
        base_delay = random.uniform(
            self.config["min_delay_seconds"],
            self.config["max_delay_seconds"]
        )
        
        # Apply exponential backoff for consecutive errors
        if self.consecutive_errors > 0:
            backoff_multiplier = min(2 ** self.consecutive_errors, 16)  # Cap at 16x
            base_delay *= backoff_multiplier
            logging.warning(f"   ⚠️  Backoff active: {self.consecutive_errors} consecutive errors, delay multiplied by {backoff_multiplier}x")
        
        # Add jitter
        final_delay = self._add_jitter(base_delay)
        
        # Display countdown
        self._countdown(final_delay, job_name)
        
        return True
    
    def _should_take_break(self):
        """Check if we should take a session break."""
        batch_size = self.config["session_batch_size"]
        return self.session_applications > 0 and self.session_applications % batch_size == 0
    
    def _take_session_break(self):
        """Take a longer session break."""
        break_time = random.uniform(
            self.config["session_break_min"],
            self.config["session_break_max"]
        )
        break_time = self._add_jitter(break_time)
        
        logging.info(f"\n☕ Taking a session break after {self.session_applications} applications...")
        logging.info(f"   This helps avoid detection. Break duration: {break_time/60:.1f} minutes")
        
        self._countdown(break_time, is_break=True)
    
    def _countdown(self, seconds, job_name=None, is_break=False):
        """Display a countdown timer."""
        total_seconds = int(seconds)
        
        if is_break:
            prefix = "☕ Break time remaining"
        else:
            prefix = "⏳ Waiting before next application"
            if job_name:
                # Truncate long job names
                display_name = job_name[:40] + "..." if len(job_name) > 40 else job_name
                logging.info(f"\n📋 Next job: {display_name}")
        
        # Show countdown in increments
        # NOTE: For proper logging, we shouldn't spam the log file with countdowns.
        # But user said "log every single thing".
        # However, writing to log file every second is not great.
        # I will log start and end of wait, and use print for the carriage return countdown for console only if I could separarte.
        # But 'logging' goes to both.
        # I'll log "Waiting for X seconds" and then just print to stdout for the visual countdown if I can access stdout directly?
        # But I should stick to logging library as requested.
        # I will simply log "Waiting X seconds..." and then sleep.
        # If I want to match original behavior of visual countdown, I'd have to use a handler that doesn't newline?
        # Standard logging doesn't support \r well in files.
        # I will change countdown to just log the wait duration.
        
        logging.info(f"{prefix}: {total_seconds}s")
        time.sleep(total_seconds)
        logging.info(f"{prefix}: Done!")
    
    def record_application(self, job_id, job_name, employer, success=True):
        """
        Record an application attempt.
        
        Args:
            job_id: ID of the job
            job_name: Name of the job
            employer: Employer name
            success: Whether the application was successful
        """
        today = str(date.today())
        timestamp = datetime.now().isoformat()
        
        # Update session count
        self.session_applications += 1
        
        # Update daily count
        if today not in self.stats["daily_counts"]:
            self.stats["daily_counts"][today] = 0
        
        if success:
            self.stats["daily_counts"][today] += 1
            self.stats["total_applications"] += 1
            self.consecutive_errors = 0
        else:
            self.consecutive_errors += 1
        
        # Record in history (keep last 100)
        self.stats["history"].append({
            "timestamp": timestamp,
            "job_id": job_id,
            "job_name": job_name,
            "employer": employer,
            "success": success
        })
        self.stats["history"] = self.stats["history"][-100:]
        
        self.stats["last_application"] = timestamp
        
        # Save stats
        self._save_stats()
    
    def record_error(self):
        """Record an error (for exponential backoff)."""
        self.consecutive_errors += 1
    
    def reset_errors(self):
        """Reset the error counter."""
        self.consecutive_errors = 0
    
    def print_session_summary(self):
        """Print a summary of the current session."""
        duration = datetime.now() - self.session_start
        minutes = duration.total_seconds() / 60
        
        logging.info("\n" + "="*60)
        logging.info("📊 Session Summary")
        logging.info("="*60)
        logging.info(f"   Applications this session: {self.session_applications}")
        logging.info(f"   Session duration: {minutes:.1f} minutes")
        logging.info(f"   Today's total: {self._get_today_count()}")
        logging.info(f"   Remaining today: {self.get_remaining_today()}")
        logging.info(f"   All-time total: {self.stats['total_applications']}")
        logging.info("="*60)
    
    def cleanup(self):
        """Cleanup and save final stats."""
        self._save_stats()
        self.print_session_summary()


def load_config():
    """Load rate limit configuration from conf.json if available."""
    try:
        from config_loader import load_conf
        conf = load_conf()
        rate_cfg = conf.get('RATE_LIMIT_CONFIG')
        if rate_cfg and isinstance(rate_cfg, dict):
            return rate_cfg
    except Exception:
        pass
    return DEFAULT_CONFIG
