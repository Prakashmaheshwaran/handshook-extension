# Handshook - Handshake Job Application Automation

## Purpose
Automate bulk job applications on Handshake with intelligent features:
- **Stealth browser automation** with human-like behavior
- **AI-powered resume matching** (Groq/Llama)
- **Job deduplication** across sessions
- **Rate limiting** to avoid detection
- **Multi-source cookie extraction**

## Tech Stack
- Python 3.10+, Selenium, BeautifulSoup4, Groq API

## Entry Points
```bash
python handshake.py --fetch-urls           # Full flow
python handshake.py --fetch-urls --dry-run # Preview
python handshake.py                         # Use existing HTML
```

## Configuration
- `conf.py` - Cookies, resumes, URLs, keywords
- `.env` - GROQ_API_KEY

## Output Folders (gitignored)
- `logs/` - handshake.log, job_tracker.json
- `csv/` - jobs_*.csv, wait_*.json
- `data/` - rate_stats_*.json
- `html/` - Saved search pages
