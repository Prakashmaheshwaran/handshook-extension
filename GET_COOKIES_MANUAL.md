# Manual Cookie Extraction Guide for Handshook

Since automatic cookie extraction requires admin privileges on Windows, here are alternative methods:

## Method 1: Export Cookies from Browser (Recommended)

### Step 1: Install a Cookie Export Extension
1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked" and download a cookie exporter extension, OR
4. Use this simpler method:

### Step 2: Manual Cookie Copy from DevTools
1. **Login to Handshake** in Chrome at `https://app.joinhandshake.com`
2. Press **F12** to open Developer Tools
3. Go to **Application** tab
4. In left sidebar, expand **Cookies** → `https://app.joinhandshake.com`
5. Find these important cookies:
   - `_session_id` (most important)
   - `user_id`
   - `handshake_auth` (if present)
   - Any other cookies starting with underscore

6. Copy the **Name** and **Value** of each cookie

### Step 3: Create secrets.json
Create a file called `secrets.json` in your project folder:

```json
{
  "cookies": {
    "_session_id": "paste_your_session_id_here",
    "user_id": "paste_your_user_id_here"
  }
}
```

## Method 2: Using Browser Console (Quick)

1. Login to Handshake
2. Press F12 → Console tab
3. Paste this code and press Enter:

```javascript
let cookies = {};
document.cookie.split(';').forEach(c => {
  let [name, value] = c.trim().split('=');
  cookies[name] = value;
});
JSON.stringify(cookies, null, 2);
```

4. Copy the output
5. Paste it into `secrets.json` as the `cookies` object

## Method 3: Using Network Tab (HAR File)

1. Login to Handshake
2. Press F12 → Network tab
3. Refresh the page
4. Right-click any request → "Save all as HAR with content"
5. Save as `handshake.har` in the `d:\handshook` folder
6. The tool will automatically extract cookies from this file

## Verify Your Cookies

To test if cookies are working:

```bash
python -c "from config_loader import load_cookies; print(load_cookies())"
```

You should see your cookies printed.

## Important Notes

- **Cookies expire**: You'll need to update them periodically (usually every few hours)
- **Keep secret**: Never share or commit `secrets.json`
- **File is gitignored**: The file won't be committed to git (it's in `.gitignore`)

## Troubleshooting

### "No valid cookies found"
- Make sure `secrets.json` is in the same folder as `handshake.py`
- Verify the JSON format is correct
- Ensure you've logged into Handshake recently

### "Permission denied" errors
- Close all Chrome windows before running the tool
- Or use Method 2/3 above instead of automatic extraction

### Cookies still not working
- Check if cookies have expired by logging into Handshake again
- Copy fresh cookies after logging in again
