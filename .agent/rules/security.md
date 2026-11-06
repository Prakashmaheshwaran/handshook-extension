---
description: Security guidelines for handling sensitive data
---

# Security Rules

## Sensitive Files (NEVER commit)
- `conf.py` - Contains session cookies and document IDs
- `.env` - Contains API keys (GROQ_API_KEY)
- `*.csv` - May contain job application history
- `*.json` - May contain session state

## Cookie Handling
- Cookies expire and must be refreshed regularly
- Never log full cookie values (only names/counts)
- Use the browser_automation module for extraction
- Close Chrome before extracting cookies from the profile

## API Keys
- Store GROQ_API_KEY in `.env` file only
- Use `python-dotenv` for loading
- Never hardcode API keys in source files

## File Permissions
- Set restrictive permissions on conf.py: `chmod 600 conf.py`
- HTML files may contain personal session data - delete after processing

## Logging Security
- `handshake.log` may contain job titles and employer names
- Do not share log files publicly
- The log file is overwritten on each run (mode='w')
