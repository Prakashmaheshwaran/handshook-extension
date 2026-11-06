---
description: Run the main Handshake job automation script
---

# Run Automation Workflow

## Steps

// turbo
1. Install dependencies:
```bash
pip install -r requirements.txt
```

// turbo
2. Run the full workflow:
```bash
python handshake.py
```

**Or preview first:**
```bash
python handshake.py --dry-run
```

## CLI Options
| Flag | Description |
|------|-------------|
| `--dry-run` | Preview without submitting |
| `--skip-fetch` | Skip URL fetching, use existing HTML |
| `--no-cookies` | Skip auto cookie extraction |
| `--debug` | Verbose logging |

## Output Folders
- `logs/` - handshake.log, job_tracker.json
- `csv/` - jobs_*.csv, wait_*.json
- `data/` - rate_stats_*.json
- `html/` - Saved search pages
