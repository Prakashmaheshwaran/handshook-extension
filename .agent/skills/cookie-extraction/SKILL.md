---
name: Cookie Extraction
description: Extract and manage browser cookies for Handshake authentication
---

# Cookie Extraction Skill

This skill provides capabilities for extracting session cookies from Chrome browser for Handshake authentication.

## Overview
The Handshake automation requires valid session cookies to authenticate API requests. This skill handles:
- Extracting cookies from Chrome's cookie store
- Updating the configuration file with new cookies
- Validating cookie freshness

## Key Module
[browser_automation.py](../../../browser_automation.py)

## Functions

### `get_chrome_cookies(domain, profile_name="Default")`
Extracts cookies for a specific domain from Chrome's cookie database.

**Parameters:**
- `domain`: Target domain (e.g., `app.joinhandshake.com`)
- `profile_name`: Chrome profile name (default: "Default")

**Returns:** Dictionary of `{cookie_name: cookie_value}` or `None`

**Requirements:**
- Chrome must be **closed** for cookie file access
- Uses `browser_cookie3` library for cross-platform cookie extraction

### `update_conf_file(conf_path, cookies)`
Updates the COOKIES dictionary in conf.py with new values.

**Parameters:**
- `conf_path`: Path to configuration file
- `cookies`: Dictionary of cookies to write

### `automate_browser(url_list, html_output_dir, existing_cookies=None)`
Opens Chrome via Selenium to navigate URLs and save HTML content.

**Use Case:** When automatic cookie extraction fails, this can be used to:
1. Open Handshake login page
2. Wait for manual login
3. Extract cookies from the Selenium session
4. Save search result pages as HTML

## Usage Example

```python
from browser_automation import get_chrome_cookies, update_conf_file

# Extract cookies (Chrome must be closed)
cookies = get_chrome_cookies("app.joinhandshake.com", "Default")

if cookies:
    # Update configuration
    update_conf_file("conf.py", cookies)
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No cookies found | Ensure you're logged into Handshake in Chrome |
| Permission denied | Close Chrome before running |
| Wrong profile | Check Chrome profile name in `chrome://version` |
