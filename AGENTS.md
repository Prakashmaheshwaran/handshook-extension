# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

## Project Overview

Handshook is an automated job application tool for Handshake (joinhandshake.com). It uses stealth browser automation (Selenium), AI-powered resume matching (Google Gemini 2.0 Flash), persistent browser sessions, and persistent job tracking to apply to jobs at scale.

The recommended tool is the browser extension in [extension/](extension/README.md); this guide covers the legacy Python CLI.

## Commands

```bash
# Setup
pip install -r requirements.txt
cp conf.json.template conf.json       # fill in RESUMES, COVER_LETTER_ID, URL_LIST, etc.
cp secrets.json.example secrets.json  # cookies live here; populated automatically
cp .env.template .env                 # add GEMINI_API_KEY, HANDSHAKE_EMAIL/PASSWORD, HANDSHAKE_HOST

# Run
python handshake.py                     # full workflow (prompts for session mode 1 or 2)
python handshake.py --dry-run           # simulate without applying
python handshake.py --skip-fetch        # use cached HTML
python handshake.py --no-cookies        # skip auto cookie extraction
python handshake.py --no-browser        # disable all browser applications (submits nothing)
python handshake.py --prune-tracker 30  # prune old external/unsupported/skipped records
python handshake.py --debug             # verbose logging

# Tests (63 cases, 6 modules)
python -m pytest tests/ -v
```

Flag aliases: `--preview` == `--dry-run`, `--no-fetch` == `--skip-fetch`. Drop HTML files into `html/{profile}/` to have job IDs auto-extracted at run start (extraction is inline via `identifier.extract_ids_from_html`).

On startup the user picks a session mode:
- **Mode 1**: reads cookies from installed Chrome (profile set via `CHROME_PROFILE`). Chrome must be closed.
- **Mode 2**: dedicated profile in `data/chrome_session/`; valid saved sessions can skip login. Auto-login uses `HANDSHAKE_EMAIL`/`HANDSHAKE_PASSWORD` when needed. A fresh default config with no cookies cannot currently reach this login flow; see README's legacy known issues.

## Architecture

```
handshake.py          → CLI entry (argparse), Job class, main workflow, HOST from HANDSHAKE_HOST env,
                         per-profile orchestration, transcript/cover letter plumbing
conf.json             → User config: RESUMES, COVER_LETTER_ID, TRANSCRIPT_ID, URL_LIST, USER_NAME,
                         SKIP_KEYWORDS, JOB_KEYWORDS, RATE_LIMIT_CONFIG, CHROME_PROFILE,
                         PREFERRED_BROWSER, PROFILES (gitignored). Template: conf.json.template.
                         TRANSCRIPT_ID is in the template; TRANSCRIPT remains a fallback alias.
config_loader.py      → conf.json + secrets.json loaders, migrate_secrets() copies conf.json COOKIES
                         to secrets.json and attempts to clear the original COOKIES key;
                         save_cookies/load_cookies helpers
browser_automation.py → AuthManager (multi-source cookie extraction: Chrome/Brave/Edge/Arc/HAR/JSON),
                         single-session Selenium driver, auto-login, apply_to_jobs_via_browser()
                         with 3-strategy cover letter + transcript selection
                         (search input → React combobox → hidden <select>)
identifier.py         → Job ID validation (>10M filter) & regex extraction from cached HTML
resume_matcher.py     → Pure Gemini 2.0 Flash matching on title+description, SHA-256 exact-match
                         cache, 1-second inter-request rate limit, fallback to first resume on error
job_tracker.py        → Persistent JSON tracking: applied/external/skipped/unsupported/failed/waiting
rate_limiter.py       → Pacing helpers and stats; browser batching does not enforce all these limits
tests/                → pytest suite — config_loader, identifier, job_tracker, resume_matcher,
                         sanitize_url, profile browser queue and transcript config regressions.
                         Browser interactions and rate-limit integration remain untested.
.github/workflows/    → CI: security scan, lint, pytest on every push
```

**Flow:** Load conf/secrets → pick session mode → extract or load cookies → fetch search pages in Selenium and save refreshed cookies → extract job IDs from HTML → deduplicate via JobTracker → fetch details via API and match resumes → queue eligible jobs and failed detail fetches for browser application (or dry-run) → record returned outcomes and counts → cleanup. The active path does not call `Job.apply()`; browser delays are separate from the configured limiter.

**Key classes/functions:**
- `Job` (handshake.py) — posting with fetch/apply/wait methods
- `AuthManager` (browser_automation.py) — cookie extraction with multi-browser fallback chain
- `match_resume_with_ai` (resume_matcher.py) — Gemini call with SHA-256 title+description cache
- `RateLimiter` (rate_limiter.py) — defaults to 60–120s delays, 50/day, 10-per-batch sessions and 5–10min breaks; these controls are not fully wired into browser application batches

**JobTracker categories:** `applied`, `external`, `unsupported` are permanent (never reprocessed). `skipped`, `failed`, `waiting` can be retried.

## Output Directories (all gitignored)

- `logs/` — handshake.log (overwritten each run), job_tracker.json
- `csv/` — jobs_{profile}.csv, wait_{profile}.json, new_jobs_{profile}.csv
- `data/` — rate_stats_{profile}.json, chrome_session/ (Mode 2 persistent Chrome profile)
- `html/` — cached search result pages per profile

## Coding Conventions

- Python 3.10+, PEP 8, 120 char max line length
- Naming: `snake_case` functions, `PascalCase` classes, `UPPER_SNAKE_CASE` constants
- `logging` module with emoji prefixes (✅ success, ❌ error, ⚠️ warning, 📊 stats, 🔍 search, ⏳ wait, 🧹 cleanup, 🚀 start, 🤖 AI, 📦 cache)
- `pathlib.Path` + `encoding='utf-8'` for file operations
- Profile-specific files: `{operation}_{profile_name}.{ext}`
- Profile names sanitized via `sanitize_profile_name`; `_validate_path` checks a `BASE_DIR` string prefix, with a known sibling-prefix containment gap

## Security

- **Never commit:** `conf.json`, `.env`, `secrets.json`, `cookies.json`, `cookies_backup.json`, `*.har`, `data/chrome_session/`, CSV/JSON output files (all gitignored)
- Cookies loaded via `AuthManager` and persisted to `secrets.json` via `config_loader.save_cookies`
- `GEMINI_API_KEY` stored in `.env`, loaded via `python-dotenv`; `HANDSHAKE_EMAIL`/`HANDSHAKE_PASSWORD`/`HANDSHAKE_HOST` for auto-login
- HTTP requests use 30-second timeout (`REQUEST_TIMEOUT`)

## Known Gaps

- **Test coverage is thin** — leaf-module tests plus mocked profile orchestration regressions; no Selenium or live end-to-end coverage and no rate-limit integration coverage.
- **Legacy configuration:** `conf.py` is rejected with migration instructions, not loaded or migrated automatically. `migrate_secrets()` handles only cookies already in `conf.json`.
- See [Known issues (legacy CLI)](README.md#known-issues-legacy-cli) for the remaining audited behavior and safety gaps.
