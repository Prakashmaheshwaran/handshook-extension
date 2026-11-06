import requests
import json
import datetime
import csv
import os
import re
import atexit
import sys
import logging
import argparse
import io
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()  # must run before importing modules that read env at module load time

from identifier import validate_job_id  # noqa: E402
from resume_matcher import match_resume_with_ai, get_resume_details, get_cache_stats  # noqa: E402
from rate_limiter import RateLimiter, load_config as load_rate_config  # noqa: E402
from job_tracker import (  # noqa: E402
    JobTracker,
    matches_skip_keywords,
    set_dry_run_mode, is_dry_run
)
# Note: extract_jobs_from_html.py was removed; functions are defined inline below


EXTRACTOR_SCRIPT = "extract_jobs_from_html.py"
LEN_CSRF = 88
HOST = os.environ.get("HANDSHAKE_HOST", "app.joinhandshake.com")
ACCEPT_GET = "application/json"
ACCEPT_POST = "application/json, text/javascript, */*; q=0.01"
CONTENT_TYPE = "application/json; charset=utf-8"
RESUME_TYPE_ID = 1
COVER_TYPE_ID = 2
TRANSCRIPT_TYPE_ID = 3
OTHER_DOCUMENT_TYPE_ID = 5


REQUEST_TIMEOUT = 30  # Default timeout for all HTTP requests (seconds)

# Base directory for all file operations (prevents path traversal)
BASE_DIR = Path(__file__).resolve().parent


def _validate_path(path_str):
    """Validate that a path stays within the project base directory.
    Prevents path traversal attacks via malicious profile names."""
    resolved = Path(path_str).resolve()
    if not str(resolved).startswith(str(BASE_DIR)):
        raise ValueError(f"Path traversal detected: {path_str} resolves outside {BASE_DIR}")
    return str(resolved)


def sanitize_profile_name(name):
    """Convert profile name to safe filename/folder name.
    Replaces spaces and special characters with underscores."""
    if not name or not isinstance(name, str):
        raise ValueError("Profile name must be a non-empty string")
    # Replace spaces and special chars with underscores, keep alphanumeric
    sanitized = re.sub(r'[^a-zA-Z0-9]+', '_', name)
    # Remove leading/trailing underscores
    sanitized = sanitized.strip('_')
    if not sanitized:
        raise ValueError(f"Profile name '{name}' sanitizes to empty string")
    # Max length to prevent filesystem issues
    if len(sanitized) > 64:
        sanitized = sanitized[:64]
    return sanitized


def get_profile_paths(profile_name):
    """Get profile-specific file paths based on profile name.
    Returns a dict with paths organized by folder type.
    All paths are validated against path traversal."""
    sanitized_name = sanitize_profile_name(profile_name)
    paths = {
        "jobs_file": f"csv/jobs_{sanitized_name}.csv",
        "wait_file": f"csv/wait_{sanitized_name}.json",
        "html_folder": f"html/{sanitized_name}",
        "new_jobs_file": f"csv/new_jobs_{sanitized_name}.csv"
    }
    # Validate all paths stay within project directory
    for key, path in paths.items():
        _validate_path(path)
    return paths


def cleanup_on_exit(profile_paths):
    """Cleanup mechanism that runs when the program exits.
    - Wipes HTML folder for current profile
    - Deletes profile-specific CSV files
    - Deletes profile-specific wait.json file
    """
    logging.info("🧹 Starting cleanup process...")

    # 1. Wipe HTML folder for current profile
    html_path = Path(profile_paths["html_folder"])
    if html_path.exists() and html_path.is_dir():
        try:
            # Get all HTML files in profile folder
            html_files = list(html_path.glob('*.html')) + list(html_path.glob('*.htm'))
            for html_file in html_files:
                try:
                    html_file.unlink()
                    logging.info(f"   ✅ Deleted HTML file: {html_file.name}")
                except Exception as e:
                    logging.warning(f"   ⚠️  Could not delete {html_file.name}: {e}")
        except Exception as e:
            logging.error(f"   ⚠️  Error cleaning HTML folder: {e}", exc_info=True)

    # 2. Delete profile-specific CSV files
    for csv_file_name in [profile_paths["jobs_file"], profile_paths["new_jobs_file"]]:
        csv_path = Path(csv_file_name)
        if csv_path.exists():
            try:
                csv_path.unlink()
                logging.info(f"   ✅ Deleted CSV file: {csv_file_name}")
            except Exception as e:
                logging.warning(f"   ⚠️  Could not delete {csv_file_name}: {e}")

    # 3. Delete profile-specific wait.json file
    wait_file_path = Path(profile_paths["wait_file"])
    if wait_file_path.exists():
        try:
            wait_file_path.unlink()
            logging.info(f"   ✅ Deleted file: {profile_paths['wait_file']}")
        except Exception as e:
            logging.warning(f"   ⚠️  Could not delete {profile_paths['wait_file']}: {e}")

    logging.info("🧹 Cleanup completed!")


def sanitize_url(url: str) -> str:
    """Strip session-specific and tracking parameters from a URL."""
    from urllib.parse import urlparse, urlencode, parse_qs, urlunparse
    if not url:
        return url
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    remove_keys = {"page", "ref", "utm_source", "utm_medium", "utm_campaign"}
    cleaned = {k: v for k, v in params.items() if k not in remove_keys}
    new_query = urlencode(cleaned, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def check_and_extract_html(html_folder, new_jobs_file):
    """Check for HTML files and auto-extract job IDs if found.
    Uses inline extraction via identifier.extract_ids_from_html - no external script needed."""
    from identifier import extract_ids_from_html
    
    # Validate paths to prevent injection
    _validate_path(html_folder)
    _validate_path(new_jobs_file)
    html_path = Path(html_folder)
    
    # Ensure the folder exists
    html_path.mkdir(parents=True, exist_ok=True)
    
    # Check if html folder has HTML files
    html_files = list(html_path.glob('*.html')) + list(html_path.glob('*.htm'))
    if not html_files:
        return False
    
    logging.info("="*70)
    logging.info(f"📂 Found {len(html_files)} HTML file(s) in '{html_folder}/' folder")
    logging.info("🔄 Auto-extracting job IDs...")
    logging.info("="*70)
    
    try:
        # Extract job IDs from all HTML files
        all_job_ids = set()
        for html_file in html_files:
            try:
                with open(html_file, 'r', encoding='utf-8') as f:
                    html_content = f.read()
                job_ids = extract_ids_from_html(html_content)
                all_job_ids.update(job_ids)
                logging.info(f"   Extracted {len(job_ids)} job IDs from {html_file.name}")
            except Exception as e:
                logging.warning(f"   ⚠️ Could not read {html_file.name}: {e}")
        
        if not all_job_ids:
            logging.info("   No job IDs found in HTML files")
            return False
        
        # Write job IDs to CSV
        csv_path = Path(new_jobs_file)
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(csv_path, 'w', newline='', encoding='utf-8') as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(['job_id'])
            for job_id in sorted(all_job_ids):
                writer.writerow([job_id])
        
        logging.info(f"✅ Saved {len(all_job_ids)} job IDs to {new_jobs_file}")
        
        # Clean up HTML files after successful extraction
        logging.info("🧹 Cleaning up HTML files...")
        for html_file in html_files:
            try:
                html_file.unlink()
                logging.info(f"   ✅ Deleted: {html_file.name}")
            except Exception as e:
                logging.warning(f"   ⚠️  Could not delete {html_file.name}: {e}")
        
        return True
    except Exception as e:
        logging.error(f"⚠️  Error extracting job IDs: {e}", exc_info=True)
        return False


def read_new_jobs(new_jobs_file):
    """Read job IDs from profile-specific new_jobs.csv if it exists.
    After reading, the file will be cleaned up by the main function after processing."""
    if not os.path.exists(new_jobs_file):
        return None
    
    try:
        job_ids = []
        with open(new_jobs_file, 'r', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                job_id = row.get('job_id', '').strip()
                if job_id and job_id.isdigit():
                    job_ids.append(int(job_id))
        
        return job_ids if job_ids else None
    except Exception as e:
        logging.error(f"⚠️  Error reading {new_jobs_file}: {e}", exc_info=True)
        return None


def cleanup_new_jobs_file(new_jobs_file):
    """Clean up profile-specific new_jobs.csv before processing fresh data.
    Archives old file if it exists, then deletes it."""
    if os.path.exists(new_jobs_file):
        try:
            # Archive the old file
            timestamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
            archive_name = f"{new_jobs_file.replace('.csv', '')}_archived_{timestamp}.csv"
            os.rename(new_jobs_file, archive_name)
            logging.info(f"🧹 Cleaned up old {new_jobs_file} → {archive_name}")
            return True
        except Exception as e:
            logging.warning(f"⚠️  Could not clean up {new_jobs_file}: {e}")
            return False
    return True


def read_conf():
    """Read the configuration from conf.json and return PROFILES array.
    Supports both multi-profile format (PROFILES key) and single-profile format.
    Cookies are loaded from secrets.json via config_loader (falls back to conf.json)."""
    from config_loader import load_conf, load_cookies

    conf = load_conf()

    # Load cookies from secrets.json (with conf.json fallback)
    secure_cookies = load_cookies()

    # Check if PROFILES array exists (new format)
    if conf.get('PROFILES'):
        profiles = conf['PROFILES']
        normalized_profiles = []
        for profile in profiles:
            # Use profile-specific cookies if present, otherwise use shared cookies
            profile_cookies = profile.get("cookies", {}) or secure_cookies
            normalized = {
                "id": profile.get("id"),
                "name": profile.get("name", f"Profile {profile.get('id', 'Unknown')}"),
                "cookies": profile_cookies,
                "resume": profile.get("resume"),
                "cover": profile.get("cover"),
                "transcript": profile.get("transcript"),
                "other": profile.get("other"),
                "url": sanitize_url(profile.get("url", "")),
                "date": profile.get("date", "0"),
                "job_keywords": profile.get("job_keywords", []),
                "skip_keywords": profile.get("skip_keywords", []),
                "valid": True,
            }
            normalized_profiles.append(normalized)
        return normalized_profiles

    # Single-profile format: build a single profile from top-level keys
    cookies = secure_cookies or conf.get('COOKIES', {})
    if cookies:
        resumes_list = conf.get('RESUMES', [])
        resume_id = None
        if resumes_list and isinstance(resumes_list, list):
            resume_id = resumes_list[0].get('id') if isinstance(resumes_list[0], dict) else None

        cover_letter_id = conf.get('COVER_LETTER_ID') or conf.get('CV_ID')
        profile = {
            "id": 1,
            "name": "Default Profile",
            "cookies": cookies,
            "resume": resume_id,
            "cover": conf.get('COVER') or cover_letter_id,
            "transcript": conf.get('TRANSCRIPT_ID') or conf.get('TRANSCRIPT'),
            "other": conf.get('OTHER'),
            "url": sanitize_url(conf.get('URL', "")),
            "date": conf.get('DATE', "0"),
            "job_keywords": conf.get('JOB_KEYWORDS', []),
            "skip_keywords": conf.get('SKIP_KEYWORDS', []),
        }
        return [profile]

    # No valid configuration found
    raise ValueError(
        "No valid configuration found in conf.json. "
        "Ensure secrets.json has cookies or conf.json has PROFILES/COOKIES."
    )


def read_wait_file(wait_file):
    """Read the profile-specific wait file that contains jobs which were not applied to in the previous run."""
    try:
        with open(wait_file, 'r') as f:
            waited_jobs = json.load(f)
    except FileNotFoundError:
        waited_jobs = list()
    return waited_jobs


def get_csrf_token(session):
    """Get the CSRF-Token, which is required when submitting an application"""
    page = session.get(f'https://{HOST}', timeout=REQUEST_TIMEOUT)
    index = page.text.find("<meta name=\"csrf-token\" content=\"") + len("<meta name=\"csrf-token\" content=\"")
    return page.text[index: index + LEN_CSRF]


class Job:

    def __init__(self, data, full_details=None):
        self.data = data
        self.start = data.get("apply_start")
        self.date = data.get("created_at", data.get("updated_at"))
        self.id = data.get("job_id")
        self.name = data.get("job_name")
        self.employer = data.get("job", {}).get("employer_name", data.get("employer_name", "Unknown"))
        self.type = data.get("job", {}).get("type", "Job")
        
        # For list view, we won't have full details yet
        self.full_details = full_details
        self.apply_type = None
        self.document_type_ids = []
        
        # If we have full details, extract apply settings
        if full_details and "job" in full_details:
            job_data = full_details["job"]
            if "job_apply_setting" in job_data:
                self.apply_type = job_data["job_apply_setting"].get("apply_type")
            if "required_job_document_types" in job_data:
                self.document_type_ids = [doc["document_type_id"]
                                         for doc in job_data["required_job_document_types"]]

    @classmethod
    def set(cls, session, configs):
        """Set various attributes"""
        cls.session = session
        cls.date = configs["date"]
        cls.documents = {RESUME_TYPE_ID: configs["resume"], COVER_TYPE_ID: configs["cover"],
                         TRANSCRIPT_TYPE_ID: configs["transcript"], OTHER_DOCUMENT_TYPE_ID: configs.get("other")}
        cls.csrf_token = get_csrf_token(session)
        cls.now = datetime.datetime.utcnow().isoformat()
    
    def fetch_details(self):
        """Fetch full job details including apply settings and document requirements.
        
        Tries multiple endpoints:
        1. /stu/jobs/{id} (student API)
        2. /jobs/{id} (general API)
        3. Scrape from HTML if API fails
        """
        if self.full_details:
            return True
        
        # Try different endpoints
        endpoints = [
            f'https://{HOST}/stu/jobs/{self.id}',
            f'https://{HOST}/jobs/{self.id}',
        ]
        
        for url in endpoints:
            try:
                headers = {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Host": HOST,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": f"https://{HOST}/job-search",
                    "X-Requested-With": "XMLHttpRequest",
                    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                }
                
                # Add CSRF token if available
                if self.csrf_token:
                    headers["X-CSRF-Token"] = self.csrf_token
                
                response = self.session.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
                
                if response.status_code == 200:
                    try:
                        self.full_details = response.json()
                    except Exception:
                        # Not JSON, might be HTML
                        continue
                        
                    # Extract apply settings from full details
                    if "job" in self.full_details:
                        job_data = self.full_details["job"]
                        title = job_data.get("title")
                        if title:
                            self.name = title
                        emp = job_data.get("employer", {})
                        if isinstance(emp, dict):
                            en = emp.get("name")
                            if en:
                                self.employer = en
                        if "job_apply_setting" in job_data:
                            self.apply_type = job_data["job_apply_setting"].get("apply_type")
                        if "required_job_document_types" in job_data:
                            self.document_type_ids = [doc["document_type_id"]
                                                     for doc in job_data["required_job_document_types"]]
                    logging.debug(f"Successfully fetched job {self.id} from {url}")
                    return True
                elif response.status_code == 422:
                    # Unprocessable Entity - likely wrong endpoint or auth issue
                    logging.debug(f"422 error for {url}, trying next endpoint...")
                    continue
                elif response.status_code == 403:
                    # Forbidden - skip silently
                    return False
                    
            except Exception as e:
                logging.debug(f"Error fetching from {url}: {e}")
                continue
        
        # All endpoints failed — browser fallback will handle this job
        logging.debug(f"API fetch failed for job {self.id} (all endpoints returned non-200); browser fallback will apply")
        return False

    def apply(self):
        """Apply to this job, return 0 if succeed, return 1 if cookie errors, 2 if not opened yet,
        3 if the job requires applying externally, 4 if the job required other documents, 5 if failed to fetch details"""
        
        # First, fetch full job details if we don't have them
        if not self.full_details:
            if not self.fetch_details():
                return 5
        
        if self.apply_type != "handshake":
            return 3
        if self.start and self.start > self.now:
            return 2
        
        # Dynamic Resume Selection — pass job description for accurate AI matching
        job_description = ""
        if self.full_details and "job" in self.full_details:
            job_description = self.full_details["job"].get("description", "")
        matched_resume_id = match_resume_with_ai(self.name, job_description=job_description)
        resume_details = get_resume_details(matched_resume_id)
        if resume_details:
            logging.info(f"🔍 Resume selected: {resume_details.get('title', '')} (ID: {matched_resume_id})")
        else:
            logging.warning(f"⚠️  Could not find details for matched resume ID {matched_resume_id}")
        
        headers = {"Accept": ACCEPT_POST, "Host": HOST, "X-CSRF-Token": self.csrf_token, "Content-Type": CONTENT_TYPE}
        document_ids = list()
        
        for document_type_id in self.document_type_ids:
            if document_type_id not in (RESUME_TYPE_ID, COVER_TYPE_ID, TRANSCRIPT_TYPE_ID, OTHER_DOCUMENT_TYPE_ID):
                logging.info(f"Skipping job '{self.name}' - requires unsupported document type: {document_type_id}")
                return 4
                
            # Special handling for RESUME_TYPE_ID to use dynamic selection
            if document_type_id == RESUME_TYPE_ID:
                doc_id = matched_resume_id
            else:
                doc_id = self.documents.get(document_type_id)
                
            if doc_id:
                document_ids.append(doc_id)
            else:
                logging.info(f"Skipping job '{self.name}' - missing required document type: {document_type_id}")
                return 4
        
        # DRY-RUN MODE: Log what would happen but don't submit
        if is_dry_run():
            logging.info(f"🔍 [DRY-RUN] Would apply to '{self.name}' at {self.employer}")
            logging.info(f"   [DRY-RUN] Documents: {document_ids}")
            return 0  # Simulate success
        
        data = json.dumps(
            {"application": {"applicable_id": self.id, "applicable_type": self.type, "document_ids": document_ids},
             "work_authorization_status": None})
        result = self.session.post(f'https://{HOST}/jobs/{self.id}/applications',
                                   headers=headers, data=data, timeout=REQUEST_TIMEOUT)
        if result.status_code != requests.codes.ok:
            logging.error(f"Failed to apply to '{self.name}': Status {result.status_code}, Response: {result.text[:200]}")
            return 1
        logging.info(f"✅ Applied to '{self.name}' at {self.employer} successfully!")
        return 0

    def wait(self, wait_list):
        """Add to WAIT_LIST"""
        wait_list.append(self.data)

    def write(self, jobs_file):
        """Write job info to JOBS_FILE"""
        jobs_file.write("%d, \"%s\", \"%s\", \"%s\"\n" % (self.id, self.name, self.employer, self.now))


def process_profile(profile, tracker, session=None, persistent_temp_dir=None, use_browser=True, shared_driver=None):
    """Process a single profile - applies to jobs using profile-specific settings.
    
    Features:
    - Job tracking (deduplication across sessions)
    - Keyword filtering (skip_keywords, job_keywords)
    - Auto cookie refresh on errors
    - Dry-run mode support
    """
    profile_name = profile["name"]
    profile_paths = get_profile_paths(profile_name)
    
    # Get keyword filters from profile
    skip_keywords = profile.get("skip_keywords", [])
    job_keywords = profile.get("job_keywords", [])
    
    # Try to load global keywords from conf.json if not in profile
    if not skip_keywords:
        try:
            from config_loader import load_conf
            skip_keywords = load_conf().get('SKIP_KEYWORDS', [])
        except Exception:
            pass

    if not job_keywords:
        try:
            from config_loader import load_conf
            job_keywords = load_conf().get('JOB_KEYWORDS', [])
        except Exception:
            pass
    
    # Register cleanup for this profile
    def cleanup_handler():
        cleanup_on_exit(profile_paths)
    atexit.register(cleanup_handler)
    
    logging.info("\n" + "="*70)
    logging.info(f"👤 Processing Profile: {profile_name}")
    if is_dry_run():
        logging.info("🔍 DRY-RUN MODE ACTIVE")
    logging.info("="*70 + "\n")
    
    # Show filter configuration
    if skip_keywords:
        logging.info(f"🚫 Skip keywords: {skip_keywords}")
    if job_keywords:
        logging.info(f"✅ Job keywords: {job_keywords}")
    
    logging.info(f"📊 Job tracker loaded: {tracker._get_summary_str()}")
    
    # Initialize rate limiter for this profile
    rate_config = load_rate_config()
    rate_limiter = RateLimiter(profile_name, rate_config)
    
    # Check if we can apply today before starting
    if not rate_limiter.can_apply_today() and not is_dry_run():
        logging.warning("❌ Daily application limit reached. Skipping this profile.")
        rate_limiter.print_session_summary()
        return
    
    # Initialize session with profile cookies (or use provided session)
    if session is None:
        session = requests.Session()
        session.cookies.update(profile["cookies"])
    
    # Set up Job class with profile config
    configs = {
        "resume": profile.get("resume"),
        "cover": profile.get("cover"),
        "transcript": profile.get("transcript"),
        "other": profile.get("other"),
        "date": profile.get("date", "0")
    }
    Job.set(session, configs)
    
    # Read wait file for this profile (unused in current flow, kept for future use)
    wait_list = list()
    
    # Open jobs file for this profile
    jobs_file = open(profile_paths["jobs_file"], 'a+')
    
    # Stats
    jobs_checked = 0
    jobs_applied = 0
    jobs_skipped_tracker = 0
    jobs_skipped_keyword = 0
    jobs_external = 0
    
    # Clean up old new_jobs.csv before processing fresh data from HTML
    cleanup_new_jobs_file(profile_paths["new_jobs_file"])
    
    # Auto-extract from HTML files if present
    check_and_extract_html(profile_paths["html_folder"], profile_paths["new_jobs_file"])
    
    # Check if we have specific jobs from HTML extraction
    specific_job_ids = read_new_jobs(profile_paths["new_jobs_file"])
    
    # Try browser-based application if enabled or if API fails (controlled by CLI --browser/--no-browser)
    
    if specific_job_ids:
        logging.info("="*70)
        logging.info(f"🎯 Processing {len(specific_job_ids)} jobs from HTML extraction")
        logging.info("="*70 + "\n")
        
        # Browser-based application queue: {job_id: resume_id}
        api_success_count = 0
        api_failed_jobs = {}  # job_id -> resume_id (None keeps the browser default)
        
        for job_id in specific_job_ids:
            # Check daily limit before each job
            if not rate_limiter.can_apply_today() and not is_dry_run():
                logging.warning("🛑 Daily limit reached. Stopping applications.")
                break
            
            jobs_checked += 1
            tracker.increment_checked()
            
            vid = validate_job_id(job_id)
            if vid is None:
                logging.warning(f"❌ Invalid job ID {job_id}")
                continue
            
            # CHECK 1: Already tracked (applied, external, etc)?
            tracked_category = tracker.is_tracked(vid)
            if tracked_category:
                logging.info(f"⏭️ Skipping job {vid} - already tracked as: {tracked_category}")
                jobs_skipped_tracker += 1
                continue
            
            # Create job object to fetch details
            job_data = {
                'job_id': vid,
                'job_name': f'Job ID {vid}',
                'employer_name': 'Unknown',
                'created_at': datetime.datetime.utcnow().isoformat(),
                'apply_start': None
            }
            
            job = Job(job_data)
            
            # Try to fetch job details via API
            fetch_success = job.fetch_details()
            
            if not fetch_success:
                api_failed_jobs[vid] = None
                continue
            
            api_success_count += 1
            
            # CHECK 2: Skip keyword filter (after we have job title)
            matched_skip = matches_skip_keywords(job.name, skip_keywords)
            if matched_skip:
                logging.info(f"⏭️ Skipping '{job.name}' - matches skip keyword: '{matched_skip}'")
                tracker.track_skipped(vid, job.name, f"keyword: {matched_skip}")
                jobs_skipped_keyword += 1
                continue

            # CHECK 3: External or not-yet-open jobs — handle without browser
            if job.apply_type != "handshake":
                logging.info(f"⏭️ Job '{job.name}' requires external application")
                tracker.track_external(vid, job.name, job.employer)
                jobs_external += 1
                continue

            if job.start and job.start > job.now:
                logging.info(f"⏭️ Job {vid} not open yet")
                tracker.track_waiting(vid, job.name, job.start or "")
                job.wait(wait_list)
                continue

            # AI resume matching per job
            job_description = ""
            if job.full_details and "job" in job.full_details:
                job_description = job.full_details["job"].get("description", "")
            matched_resume_id = match_resume_with_ai(job.name, job_description=job_description)
            resume_details = get_resume_details(matched_resume_id)
            if resume_details:
                logging.info(f"🤖 AI matched '{job.name}' → {resume_details.get('title', '')} (ID: {matched_resume_id})")

            # Route all eligible jobs to browser-based application so the user can see the process
            logging.info(f"📋 Queued '{job.name}' for browser application")
            api_failed_jobs[vid] = matched_resume_id

        # Apply via browser for all queued jobs
        if api_failed_jobs and use_browser:
            logging.info("\n" + "="*70)
            logging.info(f"🌐 Browser-based application for {len(api_failed_jobs)} jobs")
            logging.info("="*70)
            
            try:
                from browser_automation import apply_to_jobs_via_browser
                from config_loader import load_conf as _load_conf_local
                _conf_local = _load_conf_local()
                COVER_LETTER_ID = _conf_local.get('COVER_LETTER_ID')
                TRANSCRIPT_ID = _conf_local.get('TRANSCRIPT_ID') or _conf_local.get('TRANSCRIPT')

                if not api_failed_jobs:
                    logging.warning("⚠️ No resume configured, skipping browser applications")
                else:
                    # Apply via browser with per-job resume IDs, reusing fetch browser session
                    browser_results = apply_to_jobs_via_browser(
                        job_ids=list(api_failed_jobs.keys()),
                        resume_ids=api_failed_jobs,
                        cover_letter_id=COVER_LETTER_ID,
                        transcript_id=TRANSCRIPT_ID,
                        user_name=profile.get("name", ""),
                        chrome_profile=profile.get("chrome_profile", os.environ.get("CHROME_PROFILE", "Default")),
                        headless=False,
                        dry_run=is_dry_run(),
                        persistent_temp_dir=persistent_temp_dir,
                        existing_driver=shared_driver,
                    )
                    
                    # Track results
                    for job_id, success in browser_results.items():
                        if success:
                            jobs_applied += 1
                            if not is_dry_run():
                                tracker.track_applied(job_id, f"Job {job_id}", "Unknown")
                                rate_limiter.record_application(job_id, f"Job {job_id}", "Unknown", success=True)
                        else:
                            tracker.track_failed(job_id, f"Job {job_id}", "browser_failed")
            except Exception as e:
                logging.error(f"❌ Browser application failed: {e}", exc_info=True)
        
        logging.info("\n" + "="*70)
        logging.info("📊 HTML Processing Summary")
        logging.info("="*70)
        logging.info(f"   Jobs checked: {jobs_checked}")
        logging.info(f"   Skipped (already tracked): {jobs_skipped_tracker}")
        logging.info(f"   Skipped (keyword filter): {jobs_skipped_keyword}")
        logging.info(f"   External apply: {jobs_external}")
        logging.info(f"   Applied: {jobs_applied}")
        logging.info("="*70)
        
        # Delete the new_jobs.csv after processing
        if os.path.exists(profile_paths["new_jobs_file"]):
            try:
                os.remove(profile_paths["new_jobs_file"])
                logging.info(f"🧹 Cleaned up {profile_paths['new_jobs_file']}")
            except Exception as e:
                logging.warning(f"⚠️ Could not delete {profile_paths['new_jobs_file']}: {e}")
    
    else:
        # No HTML jobs - show message
        logging.info("="*70)
        logging.info(f"📊 No {profile_paths['new_jobs_file']} found")
        logging.info("   💡 Save Handshake search pages to html/ folder, or use URL_LIST with browser automation")
        logging.info("="*70 + "\n")
    
    # Save wait list for jobs that aren't open yet
    if wait_list:
        with open(profile_paths["wait_file"], 'w') as wait_file:
            json.dump(wait_list, wait_file)
        logging.info(f"💾 Saved {len(wait_list)} jobs to wait list")
    
    # Print rate limiter session summary
    rate_limiter.print_session_summary()
    
    # Print tracker summary
    tracker.print_session_summary()
    
    jobs_file.close()


def main():
    """Main entry point - processes all profiles sequentially.
    
    Command-line arguments:
        --dry-run, --preview: Run without actually applying (simulation mode)
        --no-cookies: Skip automatic cookie extraction
        --debug: Enable debug logging
    """
    
    # Parse command-line arguments
    parser = argparse.ArgumentParser(
        description="Handshake Job Application Automation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python handshake.py                  # Full workflow (fetch URLs + apply)
  python handshake.py --dry-run        # Preview mode (no applications)
  python handshake.py --skip-fetch     # Use existing HTML only
        """
    )
    parser.add_argument(
        '--dry-run', '--preview',
        action='store_true',
        dest='dry_run',
        help='Simulate applications without actually submitting'
    )
    parser.add_argument(
        '--skip-fetch', '--no-fetch',
        action='store_true',
        dest='skip_fetch',
        help='Skip URL fetching, use existing HTML files only'
    )
    parser.add_argument(
        '--no-cookies',
        action='store_true',
        help='Skip automatic cookie extraction'
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug logging'
    )
    browser_group = parser.add_mutually_exclusive_group()
    browser_group.add_argument(
        '--browser',
        action='store_true',
        dest='use_browser',
        default=True,
        help='Use browser-based application for queued jobs (default: on)'
    )
    browser_group.add_argument(
        '--no-browser',
        action='store_false',
        dest='use_browser',
        help='Disable browser-based application (no applications are submitted)'
    )
    parser.add_argument(
        '--prune-tracker',
        type=int,
        metavar='DAYS',
        dest='prune_tracker',
        default=None,
        help='Remove tracker entries older than DAYS days from prunable categories (external, unsupported, skipped)'
    )
    args = parser.parse_args()
    
    # Create output directories
    for folder in ['logs', 'csv', 'data', 'html']:
        os.makedirs(folder, exist_ok=True)
    
    # Configure logging
    log_level = logging.DEBUG if args.debug else logging.INFO

    # Windows terminals often default to cp1252, which crashes on emoji logs.
    # Force UTF-8 for stdout/stderr to prevent UnicodeEncodeError spam/hangs.
    if sys.platform == "win32":
        try:
            # Wrap the underlying buffer so StreamHandler always writes UTF-8.
            if hasattr(sys.stdout, "buffer"):
                sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
            if hasattr(sys.stderr, "buffer"):
                sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            try:
                if hasattr(sys.stdout, "reconfigure"):
                    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
                if hasattr(sys.stderr, "reconfigure"):
                    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    else:
        try:
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            if hasattr(sys.stderr, "reconfigure"):
                sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    # Force our logging config (some imported modules may configure logging early).
    root_logger = logging.getLogger()
    for h in list(root_logger.handlers):
        root_logger.removeHandler(h)

    file_handler = logging.FileHandler("logs/handshake.log", mode='w', encoding="utf-8")
    stream_handler = logging.StreamHandler(sys.stdout)

    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(formatter)
    stream_handler.setFormatter(formatter)

    root_logger.setLevel(log_level)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(stream_handler)
    
    # Set dry-run mode if requested
    if args.dry_run:
        set_dry_run_mode(True)
        logging.info("=" * 70)
        # Keep this ASCII-only to avoid Windows console encoding issues.
        logging.info("DRY-RUN MODE ENABLED")
        logging.info("   No applications will be submitted")
        logging.info("   Use this to preview what would happen")
        logging.info("=" * 70 + "\n")
    
    # =========================================================================
    # BROWSER SESSION MODE SELECTION
    # =========================================================================
    persistent_temp_dir = None
    print("\n" + "=" * 70)
    print("Browser Session Mode")
    print("=" * 70)
    print("  1. Default Chrome profile  (reads cookies from your installed Chrome)")
    print("  2. Saved temporary profile (dedicated session, reused between runs)")
    print()
    _mode_choice = input("Choose session mode [1/2] (default: 1): ").strip()
    use_saved_temp_profile = _mode_choice == "2"

    if use_saved_temp_profile:
        persistent_temp_dir = str(BASE_DIR / "data" / "chrome_session")
        os.makedirs(persistent_temp_dir, exist_ok=True)
        logging.info(f"   Saved temporary profile: {persistent_temp_dir}")
        # AuthManager reads from the default Chrome cookie database, not from
        # a custom user-data-dir, so it cannot see this session's cookies.
        # Rely on secrets.json (saved after the first login) instead.
        args.no_cookies = True
    else:
        logging.info("   Using default Chrome profile")

    # =========================================================================
    # COOKIE EXTRACTION (Multi-source fallback)
    # =========================================================================
    if not args.no_cookies:
        try:
            from browser_automation import AuthManager, update_conf_file
            
            # Get Chrome profile from conf.json or .env
            profile_name = os.environ.get("CHROME_PROFILE", "Default")
            try:
                from config_loader import load_conf
                profile_name = load_conf().get('CHROME_PROFILE', profile_name)
            except Exception:
                pass

            # Get preferred browser if specified
            preferred_browser = None
            try:
                from config_loader import load_conf as _lc
                preferred_browser = _lc().get('PREFERRED_BROWSER')
            except Exception:
                pass
            
            logging.info("=" * 70)
            logging.info("🍪 Cookie Extraction (Multi-source fallback)")
            logging.info("=" * 70)
            
            # Initialize AuthManager with fallback chain
            auth_manager = AuthManager(
                domain=HOST,
                chrome_profile=profile_name,
                har_directory=".",
                cookies_json_path="cookies.json",
                validate=True,
                preferred_browser=preferred_browser
            )
            
            # Get cookies using fallback chain
            cookies = auth_manager.get_cookies()
            
            if cookies:
                logging.info(f"✅ Got {len(cookies)} cookies from: {auth_manager.source}")
                
                updated = update_conf_file(None, cookies)
                if updated:
                    logging.info("✅ Cookies saved to secrets.json")
                    auth_manager.save_to_json("cookies_backup.json")
                else:
                    logging.warning("⚠️ Could not save cookies to secrets.json, using cookies from memory")
            else:
                logging.warning("⚠️ No valid cookies found. Using existing secrets.json / conf.json...")
                
        except ImportError:
            logging.warning("⚠️ browser_automation not available (missing dependencies). Skipping cookie extraction.")
            logging.warning("   Run: pip install browser-cookie3 selenium webdriver_manager psutil")
            logging.warning("   Or use --no-cookies and provide cookies manually in secrets.json")
        except Exception as e:
            logging.warning(f"⚠️ Cookie extraction failed: {e}")
            logging.warning("   Continuing with existing cookies from secrets.json / conf.json")
            logging.warning("   If on a new system without a browser, use --no-cookies and set cookies manually.")
            if args.debug:
                import traceback
                logging.debug(traceback.format_exc())

    # =========================================================================
    # URL_LIST FETCHING (Selenium-based HTML extraction) - ENABLED BY DEFAULT
    # =========================================================================
    shared_driver = None  # browser session shared between fetch and apply phases
    if not args.skip_fetch:
        try:
            from config_loader import load_conf, load_cookies
            from browser_automation import automate_browser, update_conf_file
            URL_LIST = load_conf().get('URL_LIST', [])

            if URL_LIST:
                logging.info("=" * 70)
                logging.info("🌐 Fetching HTML from URL_LIST (Selenium)")
                logging.info(f"   URLs to process: {len(URL_LIST)}")
                logging.info("=" * 70)
                
                # Determine HTML output folder based on profile name
                # Read profiles to get the first profile's sanitized name
                temp_profiles = read_conf()
                if temp_profiles and len(temp_profiles) > 0:
                    profile_name = temp_profiles[0]["name"]
                    html_output_dir = get_profile_paths(profile_name)["html_folder"]
                else:
                    html_output_dir = "html/Default"
                
                logging.info(f"   Output folder: {html_output_dir}")
                os.makedirs(html_output_dir, exist_ok=True)
                
                # Use existing cookies from secrets.json for the session
                existing_cookies = load_cookies() or None
                
                # Run browser automation
                # Use Chrome profile from conf.json or .env when launching Selenium
                chrome_profile = os.environ.get("CHROME_PROFILE", "Default")
                try:
                    _conf_chrome = load_conf().get('CHROME_PROFILE')
                    if _conf_chrome:
                        chrome_profile = _conf_chrome
                except Exception:
                    pass

                fetch_result = automate_browser(
                    url_list=URL_LIST,
                    html_output_dir=html_output_dir,
                    existing_cookies=existing_cookies,
                    chrome_profile=chrome_profile,
                    persistent_temp_dir=persistent_temp_dir,
                    keep_driver_open=True,
                )

                # Unpack (cookies, driver) tuple
                if isinstance(fetch_result, tuple):
                    new_cookies, shared_driver = fetch_result
                else:
                    new_cookies, shared_driver = fetch_result, None

                if new_cookies:
                    logging.info(f"✅ Fetched {len(URL_LIST)} pages, extracted {len(new_cookies)} cookies")
                    update_conf_file(None, new_cookies)
                else:
                    logging.warning("⚠️ Browser automation completed but no cookies extracted")
            else:
                logging.info("ℹ️ URL_LIST is empty in conf.json, skipping fetch")
                
        except ImportError as e:
            logging.warning(f"⚠️ Could not load URL_LIST or browser_automation: {e}")
            logging.warning("   Skipping URL fetch. Use --skip-fetch to suppress this warning.")
            logging.warning("   Run: pip install selenium webdriver_manager")
        except Exception as e:
            logging.warning(f"⚠️ URL fetching failed: {e}")
            logging.warning("   Continuing with any HTML files already in the html/ folder.")
            if args.debug:
                import traceback
                logging.debug(traceback.format_exc())

    profiles = read_conf()

    if not profiles:
        logging.error("❌ No profiles found in conf.json. Please check your configuration.")
        exit(1)

    # Create tracker once and pass to all profiles (Phase 2.4: no global singleton)
    tracker = JobTracker()

    # Optional: prune stale tracker entries before starting
    if args.prune_tracker is not None:
        pruned = tracker.prune(args.prune_tracker)
        logging.info(f"🧹 Pruned {pruned} tracker entries older than {args.prune_tracker} days")

    logging.info("=" * 70)
    logging.info("🚀 Starting Handshake Automation")
    if args.dry_run:
        logging.info("   MODE: DRY-RUN (preview only)")
    logging.info(f"📋 Found {len(profiles)} profile(s) to process")
    logging.info("=" * 70)

    # Process each profile sequentially
    for i, profile in enumerate(profiles, 1):
        try:
            process_profile(
                profile,
                tracker=tracker,
                persistent_temp_dir=persistent_temp_dir,
                use_browser=args.use_browser,
                shared_driver=shared_driver,
            )
            if i < len(profiles):
                logging.info("\n" + "=" * 70)
                logging.info("⏭️ Moving to next profile...")
                logging.info("=" * 70)
        except Exception as e:
            logging.error(f"\n❌ Error processing profile '{profile.get('name', 'Unknown')}': {e}")
            if args.debug:
                import traceback
                logging.error(traceback.format_exc())
            continue

    # Print final summaries
    logging.info("\n" + "=" * 70)
    logging.info("✅ All profiles processed!")
    logging.info("=" * 70)

    tracker.print_session_summary()
    
    # Print resume cache stats
    cache_stats = get_cache_stats()
    logging.info(f"\n📦 Resume cache: {cache_stats['cached_entries']} cached matches")


if __name__ == '__main__':
    main()

