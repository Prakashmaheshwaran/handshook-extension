# Handshook Setup Guide

The browser extension in [extension/](extension/docs/INSTALL.md) is the recommended tool. This guide covers the legacy Python CLI; read its [known issues](README.md#known-issues-legacy-cli) before use.

Install dependencies and copy the templates before configuring the CLI:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp conf.json.template conf.json
cp secrets.json.example secrets.json
cp .env.template .env
```

Set `GEMINI_API_KEY` in `.env` for Gemini resume matching. `HANDSHAKE_EMAIL`, `HANDSHAKE_PASSWORD` and `HANDSHAKE_HOST` configure browser login. Keep these files private.

## 1. Get Your Handshake Cookies

Cookies are automatically extracted by the tool, but you can also get them manually:

### Method A: Automatic Extraction (Recommended)
1. Login to Handshake in Chrome/Brave/Edge at `https://app.joinhandshake.com`
2. Run the tool once - it will auto-extract cookies from your browser

### Method B: Manual Cookie Extraction
1. Open Chrome and login to Handshake
2. Press `F12` to open Developer Tools
3. Go to **Application** tab → **Cookies** → `https://app.joinhandshake.com`
4. Find these key cookies:
   - `_session_id` (most important)
   - `user_id`
   - `handshake_auth`
5. Create `secrets.json` file:
```json
{
  "cookies": {
    "_session_id": "your_session_id_here"
  }
}
```

### Method C: Using Browser Automation
Mode 2 reuses `data/chrome_session/` and can attempt login when a saved session expires. Fresh default configuration with empty cookies currently fails before this login flow; seed cookies using Method A or B first.

---

## 2. Get Your Resume IDs

1. **Login to Handshake** at https://app.joinhandshake.com
2. Go to **Your Profile** → **Documents**
3. **Upload resumes** if you haven't already (you need at least one)
4. Click on a resume to view it
5. **Look at the URL** - it will be like:
   ```
   https://app.joinhandshake.com/document/12345678
   ```
   The number `12345678` is your **Resume ID**
6. Repeat for each resume you have

### Update conf.json

Edit the `RESUMES` field in `conf.json` and replace the placeholder IDs. JSON does not allow comments or trailing commas:

```json
{
  "RESUMES": [
    {
      "id": 12345678,
      "title": "Software Engineer",
      "description": "Software Engineering resume with Python, React, and cloud experience"
    },
    {
      "id": 87654321,
      "title": "Data Scientist",
      "description": "Data Science resume with ML, SQL, and Python experience"
    }
  ]
}
```

**Tips for descriptions:**
- Be specific about skills (Python, JavaScript, AWS, etc.)
- Mention job types you're targeting
- Keep it under 100 words for best AI matching

---

## 3. Get Job Search URLs

1. **Login to Handshake**
2. Go to **Jobs** tab
3. **Apply filters** (location, job type, etc.)
4. **Search with keywords** like "software engineer", "entry level", etc.
5. **Copy the URL** from your browser

### Example URLs:

**Software Engineering Jobs (Entry Level):**
```
https://app.joinhandshake.com/jobs?search_query=software+engineer&job_type_ids%5B%5D=1&employment_type_ids%5B%5D=1&prefers_recent_grads=true
```

**Remote Jobs:**
```
https://app.joinhandshake.com/jobs?search_query=developer&location_id=&location_name=Remote&employment_type_ids%5B%5D=1
```

**Specific Location:**
```
https://app.joinhandshake.com/jobs?search_query=python&location_id=12345&location_name=New+York%2C+NY
```

### Update conf.json

Merge this field into your existing configuration:

```json
{
  "URL_LIST": [
    "https://app.joinhandshake.com/jobs?search_query=software+engineer&prefers_recent_grads=true",
    "https://app.joinhandshake.com/jobs?search_query=junior+developer&employment_type_ids%5B%5D=1"
  ]
}
```

**Pro tip:** Create multiple URLs with different search criteria to maximize job coverage!

---

## 4. Configure Keyword Filters

### SKIP_KEYWORDS
After a successful detail fetch, titles containing these case-insensitive substrings will be **skipped**. Merge this field into `conf.json`:

```json
{
  "SKIP_KEYWORDS": [
    "senior", "lead", "manager", "director", "principal", "staff",
    "5+ years", "10+ years", "phd", "executive"
  ]
}
```

### JOB_KEYWORDS
This key is loaded and logged but **not enforced** by the current CLI. Use Handshake search filters in `URL_LIST` to narrow discovery; do not rely on `JOB_KEYWORDS` to exclude jobs.

---

## 5. Example conf.json

Replace the synthetic IDs and search URLs with your settings. The template includes optional keys; `TRANSCRIPT_ID` is the preferred transcript field, with legacy `TRANSCRIPT` accepted when that field is absent or empty. Cookies belong in `secrets.json`.

```json
{
  "COOKIES": {},
  "RESUMES": [
    {
      "id": 12345678,
      "title": "Full-stack Developer",
      "description": "Python, Django, React, and AWS experience."
    }
  ],
  "COVER_LETTER_ID": null,
  "TRANSCRIPT_ID": null,
  "URL_LIST": [
    "https://app.joinhandshake.com/jobs?search_query=software+engineer&prefers_recent_grads=true",
    "https://app.joinhandshake.com/jobs?search_query=junior+developer&employment_type_ids%5B%5D=1"
  ],
  "SKIP_KEYWORDS": ["senior", "lead", "manager", "director", "principal", "staff"],
  "JOB_KEYWORDS": [],
  "RATE_LIMIT_CONFIG": {
    "min_delay_seconds": 60,
    "max_delay_seconds": 120,
    "daily_limit": 50,
    "session_batch_size": 10,
    "session_break_min": 300,
    "session_break_max": 600,
    "jitter_percent": 10,
    "enabled": true
  },
  "CHROME_PROFILE": "Default",
  "PREFERRED_BROWSER": null,
  "PROFILES": null
}
```

The browser batch does not fully enforce `RATE_LIMIT_CONFIG`; see README's known issues. `migrate_secrets()` (or `python config_loader.py`) copies existing `conf.json` cookies into `secrets.json` and attempts to clear the original `COOKIES` field; it does not convert Python configuration files.

---

## 6. Running the Tool

### Test Mode (Dry Run - Recommended First Time)
```bash
python handshake.py --dry-run
```
This will:
- Fetch job listings
- Show which jobs would be applied to
- Test resume matching
- **NOT actually apply**

Dry-run stops before opening the application form, so it cannot validate required answers or selected documents. It still changes tracker state and deletes cached HTML/output files.

### Full Run
```bash
python handshake.py
```

### Skip URL Fetching (Use existing HTML)
```bash
python handshake.py --skip-fetch
```

### Debug Mode
```bash
python handshake.py --debug
```

---

## 7. Troubleshooting

### "No cookies found"
- Make sure you're logged into Handshake in Chrome/Brave/Edge
- Try running without `--no-cookies` flag to enable auto-extraction

### "No resumes found"
- Check that your resume IDs in `conf.json` are correct
- Verify resumes exist in Handshake > Documents

### "No jobs found"
- Check your URL_LIST URLs are valid
- Try opening the URLs in browser to verify they show jobs
- Check HTML files are being saved to `html/` folder

### "Rate limited"
- Stop the run and inspect the cause before retrying
- The active browser path does not enforce configured backoff/session breaks, and a queued batch can exceed the daily cap

---

## Security Notes

- `conf.json` and `.env` are **gitignored** - never commit them
- `secrets.json` stores cookies - also gitignored
- Your Gemini API key (`GEMINI_API_KEY`) is in `.env`
- All output files (CSV, logs) are in gitignored folders
