"""
Resume Matcher Module for Handshake Automation

Uses Google Gemini AI to intelligently match job title + description to the
most appropriate resume. No keyword/pattern heuristics — the AI makes every
decision based on the full context provided.

Features:
- Pure AI matching (Gemini 2.0 Flash) using job title AND description
- Simple exact-match cache to avoid redundant API calls for identical jobs
- Rate limiting for Gemini API
- Fallback to first resume on errors
"""

import hashlib
import os
import re
import time
import logging
from typing import Dict, Optional
from dotenv import load_dotenv

load_dotenv()

try:
    from config_loader import load_conf
    RESUMES = load_conf().get('RESUMES', [])
except Exception:
    RESUMES = []

# Initialize Gemini client
client = None
GEMINI_MODEL = "gemini-2.0-flash"
try:
    from google import genai
    _api_key = os.environ.get("GEMINI_API_KEY", "")
    if _api_key:
        client = genai.Client(api_key=_api_key)
        logging.info(f"✅ Gemini ({GEMINI_MODEL}) initialized for resume matching")
    else:
        logging.warning("⚠️ GEMINI_API_KEY not set in .env — AI resume matching disabled")
except Exception as e:
    logging.warning(f"⚠️ Gemini client could not be initialized: {e}")


# =============================================================================
# Simple exact-match cache  (title + description → resume_id)
# =============================================================================

_cache: Dict[str, int] = {}


def _cache_key(job_title: str, job_description: str) -> str:
    """Return a SHA-256 hash of the full title+description to avoid cache collisions."""
    raw = f"{job_title}::{job_description}"
    return hashlib.sha256(raw.encode()).hexdigest()


# =============================================================================
# Resume Details Lookup
# =============================================================================

def get_resume_details(resume_id: int) -> Optional[Dict]:
    """Get details for a specific resume ID."""
    for resume in RESUMES:
        if resume["id"] == resume_id:
            return resume
    return None


# =============================================================================
# Rate Limiting
# =============================================================================

_last_request_time = 0.0
_MIN_INTERVAL = 1.0  # seconds between requests


def _apply_rate_limit() -> None:
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < _MIN_INTERVAL:
        time.sleep(_MIN_INTERVAL - elapsed)
    _last_request_time = time.time()


# =============================================================================
# Main Matching Function
# =============================================================================

def match_resume_with_ai(job_title: str, job_description: str = "", use_cache: bool = True) -> Optional[int]:
    """
    Match a job to the best resume using Gemini AI.

    The AI receives the job title AND full description to make an informed
    decision. No keyword patterns are used.

    Args:
        job_title:        The job title (e.g. "Fullstack Software Engineer")
        job_description:  Full job description text (optional but improves accuracy)
        use_cache:        Skip API call if we've seen this exact job before

    Returns:
        Resume ID (int) of the best matching resume, or None on failure.
    """
    if not RESUMES:
        logging.warning("⚠️ No resumes configured. Cannot match.")
        return None

    # Check exact cache
    if use_cache:
        key = _cache_key(job_title, job_description)
        if key in _cache:
            cached_id = _cache[key]
            resume = get_resume_details(cached_id)
            label = resume.get("title", str(cached_id)) if resume else str(cached_id)
            logging.info(f"   📦 Cache hit: '{job_title[:50]}' → {label}")
            return cached_id

    # Gemini not available — fall back to first resume
    if not client:
        fallback = RESUMES[0]
        fallback_label = fallback.get("title", str(fallback["id"]))
        logging.warning(
            "⚠️ [FALLBACK] Gemini client is not available (GEMINI_API_KEY not set or import failed). "
            f"Selecting first resume as fallback: '{fallback_label}' (ID: {fallback['id']})"
        )
        return fallback["id"]

    _apply_rate_limit()

    # Build resume options for the prompt
    resume_options = "\n".join(
        f"  ID {r['id']}: {r['title']} — {r['description']}"
        for r in RESUMES
    )

    # Truncate description to keep the prompt compact
    desc_snippet = job_description[:2000].strip() if job_description else "(not provided)"

    prompt = f"""You are a resume selector. Given a job title and job description, pick the single most relevant resume from the list below.

AVAILABLE RESUMES:
{resume_options}

SELECTION RULES:
- If the job is about full stack, frontend, backend, or web development → pick the FullStack resume.
- If the job is about AI, ML, data science, software engineering, or general programming → pick the AI/ML/Software resume.
- If the job is about automation, no-code, low-code, RPA, or workflow tools → pick the Automation resume.
- When in doubt, use the job description to decide.

OUTPUT FORMAT:
Return ONLY the numeric resume ID. No explanation, no punctuation, nothing else.

Job Title: {job_title}

Job Description:
{desc_snippet}"""

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config={
                "temperature": 0.1,
                "max_output_tokens": 20,
                "top_p": 0.95,
            }
        )

        result = response.text.strip()

        match = re.search(r'\d+', result)
        if match:
            resume_id = int(match.group())
            if get_resume_details(resume_id):
                if use_cache:
                    _cache[_cache_key(job_title, job_description)] = resume_id
                resume = get_resume_details(resume_id)
                label = resume.get("title", str(resume_id)) if resume else str(resume_id)
                logging.info(f"   🤖 AI matched '{job_title[:50]}' → {label} (ID: {resume_id})")
                return resume_id

        fallback = RESUMES[0]
        fallback_label = fallback.get("title", str(fallback["id"]))
        logging.warning(
            f"⚠️ [FALLBACK] Gemini returned invalid resume ID '{result}' for job '{job_title[:50]}'. "
            f"Using first resume: '{fallback_label}' (ID: {fallback['id']})"
        )
        return fallback["id"]

    except Exception as e:
        fallback = RESUMES[0]
        fallback_label = fallback.get("title", str(fallback["id"]))
        logging.warning(
            f"⚠️ [FALLBACK] Gemini matching error for job '{job_title[:50]}': {e}. "
            f"Using first resume: '{fallback_label}' (ID: {fallback['id']})"
        )
        return fallback["id"]


def get_cache_stats() -> Dict:
    """Return cache statistics."""
    return {"cached_entries": len(_cache)}
