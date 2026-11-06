# Architecture Reference

## Module Dependency Graph
```
handshake.py (main)
├── conf.py (configuration)
├── browser_automation.py (AuthManager + Selenium stealth)
├── identifier.py (job ID validation)
├── resume_matcher.py (AI matching + cache)
├── rate_limiter.py (pacing)
├── job_tracker.py (deduplication)
└── extract_jobs_from_html.py (HTML parsing)
```

## Core Classes
- **AuthManager** - Multi-source cookie extraction
- **JobTracker** - Persistent job status tracking
- **ResumeCache** - AI matching cache
- **RateLimiter** - Application pacing

## Output Folders
| Folder | Contents |
|--------|----------|
| `logs/` | handshake.log, job_tracker.json |
| `csv/` | jobs_{profile}.csv, wait_{profile}.json |
| `data/` | rate_stats_{profile}.json |
| `html/` | Saved search pages |

## Stealth Features
- Randomized URL order
- 20-40s delays between pages
- Human-like scrolling/mouse
- Random viewport/User-Agent
- JavaScript webdriver hiding
