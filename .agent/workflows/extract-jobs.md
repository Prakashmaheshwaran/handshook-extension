---
description: Extract job IDs from saved HTML search result pages
---

# Extract Jobs from HTML Workflow

## When to Use
When you have manually saved Handshake job search pages as HTML and want to extract job IDs for processing.

## Steps

1. Save HTML files to the profile's html folder:
   - Default location: `html/Default/` (or `html/{profile_name}/`)
   - Right-click on Handshake job search page → "Save Page As" → Save as HTML

// turbo
2. Run the extraction script:
```bash
python3 extract_jobs_from_html.py html/Default new_jobs_Default.csv
```

Or run the main script which auto-extracts:
```bash
python3 handshake.py
```

## How It Works
1. Script searches for HTML files in the specified folder
2. Parses HTML using BeautifulSoup to find job IDs
3. Uses regex patterns to extract job IDs from:
   - `/stu/jobs/{id}` links
   - `/jobs/{id}` links
   - `job-search/{id}` URLs
   - `data-job-id="{id}"` attributes
   - `"jobId": {id}` JSON fields
4. Saves unique job IDs to CSV file
5. HTML files are auto-deleted after extraction

## Output
- Creates `new_jobs_{profile}.csv` with job IDs
- The main script will automatically process these IDs
