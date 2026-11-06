# Handshook

## Browser extension (recommended)

For a friend-friendly setup without Python or a terminal, use the Handshook browser
extension: **[install and first-run guide](extension/docs/INSTALL.md)**. It works with
your existing Handshake session and applies automatically by default: click **Start**
and it clicks Apply, fills Handshake's application dialog with your documents and saved
answers, clicks Submit Application, and verifies the result. Review and Dry run are
opt-outs in Settings.
Use current desktop Chrome (minimum 120); see the guide for Edge/Brave limitations.

**[Quick start (5 minutes)](extension/README.md#quick-start-5-minutes):** unzip the
release package, open `chrome://extensions`, enable **Developer mode**, and **Load
unpacked** from the folder containing `manifest.json`. Pin Handshook from Chrome's
Extensions menu, click its toolbar icon, and finish setup with the default **Autopilot**
mode. Answers can wait until a job asks. Nothing starts until you click **Start**; a
required question with no saved answer or a required document with no entered ID waits
in **Needs you**.

AI is on by default but needs your own key for any cloud request. Basic keyword matching
needs no key. In extension 1.1.0, OpenRouter replaces Gemini: bring your own OpenRouter
key and keep or change the preselected `deepseek/deepseek-v4.1-flash` model, and paste
the Handshake document links or IDs of the resumes you want matching to consider.
Handshook no longer uses a built-in browser AI model or reads your documents page.

AI matching sends limited job text and resume metadata to OpenRouter and the chosen
model's provider after your permission grant. AI page assist is narrower: when a button
or document field cannot be found, it sends a numbered list of control labels, roles and
a few attribute names — never answers, form values, document contents or URLs — and the
extension vetoes destructive controls and re-runs all its normal checks. AI answer assist
answers only from your saved answers: when a question is worded differently, it sends
the question text and your saved answers' labels — never their values — and the extension
fills your saved value itself. After your saved answers, AI may write answers to questions
that need no personal fact (how you heard about the job, why it interests you) from the job
posting and your non-sensitive saved answers; questions about your experience, eligibility
or other personal facts always wait for you. Provider data
collection is denied by default and OpenRouter bills any usage to you. Turn either off
in **Settings → AI**. Stored Gemini keys are deleted on update. See
[AI setup](extension/docs/FAQ.md#what-is-openrouter).

The Chrome Web Store listing is pending and the repository is currently private.
The guide explains release ZIP installation and private sharing from the owner.
[Extension overview](extension/README.md) · [FAQ](extension/docs/FAQ.md) ·
[Privacy policy](extension/docs/PRIVACY.md)

The remaining documentation below is for the older **Python CLI**. Do not run both
tools on the same account at the same time.

## Python CLI

Legacy Python automation for Handshake with Gemini resume matching and Selenium sessions. The remaining audited limitations are listed below; the browser extension is the recommended tool.

### Known issues (legacy CLI)

The [Python audit](docs/audit/2026-10-27/01-python-core.md) documents these unresolved issues. The failed-detail-fetch crash and transcript-key inconsistency are fixed; the behaviors below remain unchanged.

- **Submission and documents:** a submit click can be recorded as permanently applied without confirmation; one-click applications can be misreported as failed and retried. Work authorization/sponsorship answers are hardcoded, and failed document selection can keep a default or choose a different file.
- **Limits and filters:** browser batches can exceed the daily cap; configured pacing, session breaks and backoff are disconnected from that path. `JOB_KEYWORDS` is logged but not enforced. `--no-browser` submits nothing because all active applications use Selenium.
- **Setup and profiles:** fresh Mode 2 with the default empty cookies cannot reach auto-login. Profiles share one application browser and global document settings/matcher; tracking is keyed by job ID across accounts, so account/document isolation is incomplete.
- **Preview and persistence:** dry-run still deletes cached HTML/output files and writes some tracker categories, and does not inspect application forms. Failed/retry work can be lost during cleanup; wait files are not reloaded. Tracker JSON writes are not atomic or locked, and corrupt data can reset deduplication history; browser outcomes also lose fetched job/employer labels.
- **API and sessions:** job opening dates are not hydrated; malformed success JSON and CSRF extraction are weakly validated. Login checks do not verify account identity. The shared browser is not explicitly closed, apply-only sessions do not save refreshed cookies, and standalone apply has incomplete macOS Chrome discovery.
- **Maintenance:** path containment uses a string prefix, allowing sibling-prefix paths. Dead/disconnected API-apply, wait-file and extractor references remain. Selenium, rate-limit integration and successful AI generation lack regression coverage; existing fixture tests do not establish live-site compatibility.

## Features

- **Stealth Browser Automation** — Human-like scrolling, mouse movements, and random delays to avoid detection
- **AI Resume Matching** — Google Gemini 2.0 Flash selects from configured resume metadata using the title and first 2,000 description characters
- **Cover Letter Automation** — Automatically selects your cover letter by document ID when the application form requires one
- **Persistent Sessions** — Reuses saved cookies while the session remains valid
- **Job Tracking** — Suppresses jobs recorded as applied, external or unsupported
- **Rate Statistics** — Records successful browser outcomes; see the batch-limit caveat above
- **Keyword Filtering** — Skips fetched titles containing configured skip keywords
- **Multi-source Cookie Extraction** — Chrome → Edge → HAR → JSON fallback chain
- **Dry-run Mode** — Queues jobs without submitting; does not inspect forms and still changes local files
- **CI/CD Pipeline** — GitHub Actions runs security scans, linting, and the Python test suite on every push

---

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure

```bash
cp conf.json.template conf.json
cp secrets.json.example secrets.json
```

Edit `conf.json` with your settings:

```json
{
  "RESUMES": [
    {
      "id": 12345678,
      "title": "FullStack Developer",
      "description": "React, Next.js, Node.js, TypeScript, REST APIs, frontend, backend"
    },
    {
      "id": 87654321,
      "title": "AI Engineer / ML Engineer",
      "description": "Python, machine learning, deep learning, NLP, TensorFlow, PyTorch, LLMs"
    }
  ],
  "COVER_LETTER_ID": 11223344,
  "URL_LIST": [
    "https://app.joinhandshake.com/job-search/XXXXXXX?page=1&per_page=25"
  ],
  "SKIP_KEYWORDS": ["senior", "lead", "manager", "5+ years"],
  "JOB_KEYWORDS": ["software", "engineer", "developer", "ai", "intern"]
}
```

Create `.env`:

```bash
GEMINI_API_KEY=your_gemini_api_key_here
HANDSHAKE_EMAIL=your@email.com
HANDSHAKE_PASSWORD=yourpassword
HANDSHAKE_HOST=app.joinhandshake.com
CHROME_PROFILE=Default
```

### 3. Run

```bash
python handshake.py
```

On startup, choose a browser session mode:

```
======================================================================
Browser Session Mode
======================================================================
  1. Default Chrome profile  (reads cookies from your installed Chrome)
  2. Saved temporary profile (dedicated session, reused between runs)

Choose session mode [1/2] (default: 1):
```

---

## Session Modes

### Mode 1 — Default Chrome Profile

```
Choose session mode [1/2]: 1
```

- Reads cookies directly from your **installed Chrome browser** (`Default` profile by default)
- Requires Chrome to be **closed** before running, otherwise the cookie file is locked
- Best for quick one-off runs when you are already logged into Handshake in Chrome
- Cookies are re-extracted unless disabled, and refreshed fetch cookies are saved to `secrets.json`
- Configure which Chrome profile to use via `CHROME_PROFILE` in `conf.json` or `.env`

**Flow:**

1. Extracts cookies from `%LOCALAPPDATA%\Google\Chrome\User Data\<profile>\Cookies`
2. Injects them into the automation browser
3. Navigates to Handshake — already logged in

### Mode 2 — Saved Persistent Profile

```
Choose session mode [1/2]: 2
```

- Uses a **dedicated Chrome profile** saved to `data/chrome_session/` inside the project
- Reuses saved cookies from `secrets.json` while valid; expired sessions may require login again
- The fetch phase can auto-login using `HANDSHAKE_EMAIL` / `HANDSHAKE_PASSWORD` from `.env` and save refreshed cookies
- A fresh default config with empty cookies fails before browser login; see the known issues above
- Browser launch fallback can try installed Chrome profiles if the dedicated profile fails

**Flow:**

1. Launch Chrome with `data/chrome_session/` profile
2. Inject saved cookies from `secrets.json`
3. Navigate to Handshake — reuse a valid session or attempt login
4. Save updated cookies after successful page fetching

**First-time Mode 2 setup:**

- Make sure `HANDSHAKE_EMAIL` and `HANDSHAKE_PASSWORD` are set in `.env`
- Populate valid cookies through Mode 1 or the manual steps in [SETUP_GUIDE.md](SETUP_GUIDE.md) before using the default single-profile Mode 2 configuration
- A saved session can expire; credentials may be needed again

| Mode  | Chrome instance                  | Login required                   | Recommended          |
| ----- | -------------------------------- | -------------------------------- | -------------------- |
| **1** | Your installed Chrome            | Every run (cookies re-extracted) | One-off runs         |
| **2** | Dedicated `data/chrome_session/` | Whenever the session expires     | Repeated legacy runs |

---

## CLI Arguments

| Flag                         | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `--dry-run`                  | Preview jobs without submitting applications        |
| `--browser` / `--no-browser` | Enable or disable all browser applications          |
| `--skip-fetch`               | Skip URL fetching, use existing HTML files          |
| `--no-cookies`               | Skip auto cookie extraction                         |
| `--prune-tracker DAYS`       | Prune old external, unsupported and skipped records |
| `--debug`                    | Verbose logging                                     |

---

## AI Resume Matching

Gemini 2.0 Flash reads the job title and first 2,000 description characters and picks a resume from your configured metadata. Successful selections are cached in memory by the full title/description text for that process; failures fall back to the first resume and are not cached.

Example selection logic:

- **FullStack resume** → frontend, backend, web development, React, Node.js roles
- **AI/ML resume** → AI, machine learning, data science, software engineering roles
- **Automation resume** → RPA, no-code, low-code, workflow automation roles

---

## Cover Letter & Transcript Automation

Set `COVER_LETTER_ID` and `TRANSCRIPT_ID` in `conf.json` to your uploaded documents' IDs.

`TRANSCRIPT_ID` is included in `conf.json.template`; the older `TRANSCRIPT` key is used only when `TRANSCRIPT_ID` is absent or empty.

During application, the bot attempts selection using three strategies:

1. **Search input** — clicks `input[placeholder="Search your cover letters"]` / `input[placeholder="Search your transcripts"]` to open the autocomplete dropdown, then picks the matching option by document ID or filename
2. **React combobox** — falls back to `[role='combobox']` triggers near the relevant label
3. **Hidden `<select>`** — last resort: sets the React-backing hidden select element directly

If the job form has no cover letter or transcript field, that step is silently skipped.

To find your document IDs, open the document in Handshake — the ID is in the URL:

```
https://app.joinhandshake.com/docs/67636590   → COVER_LETTER_ID: 67636590
https://app.joinhandshake.com/docs/68085637   → TRANSCRIPT_ID:   68085637
```

---

## Rate Limiting

Limiter settings are configured via `RATE_LIMIT_CONFIG` in `conf.json`. The active browser batch does not enforce these pacing/break/backoff settings or reserve the remaining daily capacity; see known issues above.

```json
{
  "RATE_LIMIT_CONFIG": {
    "min_delay_seconds": 60,
    "max_delay_seconds": 120,
    "daily_limit": 50,
    "session_batch_size": 10,
    "session_break_min": 300,
    "session_break_max": 600,
    "jitter_percent": 10,
    "enabled": true
  }
}
```

---

## Project Structure

```
handshook/
├── handshake.py            # Main entry point, Job class, profile processing
├── browser_automation.py   # Selenium stealth automation, cookie extraction
├── resume_matcher.py       # Gemini AI resume selection with caching
├── rate_limiter.py         # Pacing: delays, daily caps, session breaks
├── job_tracker.py          # Persistent deduplication across sessions
├── identifier.py           # Job ID validation and HTML extraction
├── config_loader.py        # conf.json / secrets.json loader
├── conf.json.template      # Configuration template (copy to conf.json)
├── secrets.json.example    # Secrets template (copy to secrets.json)
├── requirements.txt        # Dependencies
├── .env.template           # Environment variables template
├── .github/workflows/      # CI/CD pipeline (security, lint, tests)
├── tests/                  # 63 pytest cases across 6 modules
│
└── [Generated at runtime — all gitignored]
    ├── logs/               # handshake.log, job_tracker.json
    ├── csv/                # jobs_*.csv output
    ├── data/               # rate_stats_*.json, chrome_session/
    └── html/               # Cached search result pages
```

---

## Security

The following are gitignored and must **never be committed**:

| File                   | Contains                        |
| ---------------------- | ------------------------------- |
| `.env`                 | API keys, Handshake credentials |
| `conf.json`            | Resume IDs, search URLs         |
| `secrets.json`         | Session cookies                 |
| `data/chrome_session/` | Saved Chrome profile            |

Refreshed cookies from page fetching are persisted to `secrets.json`; apply-only sessions do not currently save them.

---

## Testing

```bash
python -m pytest tests/ -v
```

63 test cases covering job ID validation, job tracker logic, URL sanitization, resume cache keys, config loading, the failed-detail-fetch browser queue and transcript-key compatibility. Browser calls in the new profile regressions are mocked; no live applications are submitted.

---

## Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and pull request rules,
[SECURITY.md](SECURITY.md) for private vulnerability reporting, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). The Chrome Web Store and GitHub launch checklist
is in [extension/docs/LAUNCH.md](extension/docs/LAUNCH.md). Licensed under the
[MIT License](LICENSE).

---

Made with love for job seekers
