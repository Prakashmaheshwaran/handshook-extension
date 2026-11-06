---
description: Refresh Handshake session cookies when they expire
---

# Update Cookies Workflow

## Symptoms of Expired Cookies
- "Cookie error" messages in logs
- HTTP 401/403 responses from Handshake API
- "Cookies are not valid, please provide new ones" message

## Method 1: Automatic Extraction (Preferred)

1. **Close Chrome completely** (important for cookie file access)

// turbo
2. Run the main script - it will auto-extract cookies:
```bash
python3 handshake.py
```

The script uses `browser_automation.get_chrome_cookies()` to:
- Read cookies from Chrome's profile directory
- Update `conf.py` automatically

## Method 2: Manual Extraction

1. Open Chrome and log into Handshake
2. Open Developer Tools (F12) → Application → Cookies
3. Copy all cookies for `app.joinhandshake.com`
4. Update the `COOKIES` dictionary in `conf.py`

## Chrome Profile Configuration
Set `CHROME_PROFILE` in `conf.py` to match your Chrome profile:
```python
CHROME_PROFILE = "Default"  # or "Profile 1", "Profile 2", etc.
```

## Cookie File Locations
- **macOS**: `~/Library/Application Support/Google/Chrome/{Profile}/Cookies`
- **Windows**: `%LOCALAPPDATA%\Google\Chrome\User Data\{Profile}\Cookies`
- **Linux**: `~/.config/google-chrome/{Profile}/Cookies`
