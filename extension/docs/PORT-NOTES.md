# Port Notes — Exact Behavior from the Python Implementation

Use this when a task says "port" or "preserve behavior." It is a distilled map, not a substitute for reading the Python when precision matters. Line numbers are approximate at commit `5777c14`.

---

## 1. Job details API (`handshake.py` ~328–449)

**CSRF**

```python
def get_csrf_token(session):
    page = session.get(f'https://{HOST}', timeout=30)
    index = page.text.find('<meta name="csrf-token" content="') + len('<meta name="csrf-token" content="')
    return page.text[index:index + 88]
```

- Only needed for POST. The extension should read the meta tag from the page if a POST fallback is used, and never persist it.

**Endpoints**

```
GET https://{HOST}/stu/jobs/{id}
GET https://{HOST}/jobs/{id}
```

Headers used:

```
Accept: application/json, text/javascript, */*; q=0.01
Accept-Language: en-US,en;q=0.9
Referer: https://{HOST}/job-search
X-Requested-With: XMLHttpRequest
X-CSRF-Token: <token>   # optional for GET
```

Behavior:

- 200 + JSON → parse.
- 422 → try next endpoint.
- 403 → give up (skip).
- Exception → try next.
- All fail → browser fallback.

Fields extracted:

```
job.title
job.employer.name
job.description
job.job_apply_setting.apply_type
job.required_job_document_types[].document_type_id
```

---

## 2. Application API fallback (`handshake.py` ~451–511)

**Status codes**

| Code | Meaning                           |
| ---: | --------------------------------- |
|    0 | applied                           |
|    1 | cookie/session error              |
|    2 | not open yet                      |
|    3 | external apply                    |
|    4 | unsupported/missing document type |
|    5 | failed to fetch details           |

**Payload**

```json
{
  "application": {
    "applicable_id": 12345678,
    "applicable_type": "Job",
    "document_ids": [111, 222]
  },
  "work_authorization_status": null
}
```

**Endpoint**

```
POST https://{HOST}/jobs/{id}/applications
Content-Type: application/json; charset=utf-8
X-CSRF-Token: <token>
```

**Document type IDs**

|  ID | Type         |
| --: | ------------ |
|   1 | resume       |
|   2 | cover letter |
|   3 | transcript   |
|   5 | other        |

**Rules**

- `apply_type != "handshake"` → external (3).
- `apply_start` > now → waiting (2).
- If a required document type is unsupported or missing → skip (4).
- Success requires HTTP 200; any other status → failure (1).
- **Extension:** do not use this as the primary path. It cannot handle custom questions and is more bot-like. Keep as documented fallback only.

---

## 3. Apply button detection (`browser_automation.py` ~1477–1571)

Order:

1. All visible buttons; exact text `apply` → apply; text containing `apply` + `externally`/`external` → external.
2. All visible links; same logic.
3. `//button[@aria-label='Apply to job']`.
4. Case-insensitive XPath containing `apply`.
5. If no button → fail.

**Port guidance:** replace breadth-first "all buttons" scanning with accessible-name matching scoped to the job header/actions. Keep external detection. Add `quick apply` as a distinct type.

---

## 4. Modal detection (`browser_automation.py` ~1594–1610)

```
[role='dialog']
[aria-modal='true']
[data-testid*='modal']
.modal-content
```

Wait 4–6s after clicking Apply (the old code). Extension: wait for visibility up to 10s, then check for Quick Apply confirmation.

---

## 5. Work authorization / sponsorship (Python ~1633–1666)

**Old behavior (do not port):**

- Find a label containing "legally authorized" or "work authorization" and click the first following radio (Yes).
- Find a label containing "sponsorship" or "visa" and click the sibling "No".

**Problem:** this is a legal attestation and may be false for the user.

**Extension:** use an answer bank entry with `sensitive: true`, `autoSubmitAllowed` only after explicit user confirmation. If unmatched → Needs You.

---

## 6. Document selection (Python ~1668–1970)

### Resume

1. **Search input** `input[placeholder*='resume' i]`:
   - click, wait 1.5s, wait for options.
   - options: `[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]`.
   - match `data-value`/`data-id`/`value` to resume ID.
   - fallback: first visible non-empty option (old bug; remove for required).
2. **React combobox** `[role='combobox'], button[aria-haspopup='listbox'], button[aria-haspopup='true'], [aria-expanded]`:
   - require "resume" in parent text or trigger text.
   - click, wait, pick option.
3. **Hidden `<select>`**:
   - `select_by_value(resume_id)`.

### Transcript

Same three strategies with placeholder `transcript` and parent text `transcript`.

### Cover letter

Same three strategies with placeholder `cover` and parent text `cover`.

- Old code has a hardcoded `cover_title_hint = "Prakash"` → **remove**.
- Old code falls back to first visible option → **remove for required**, allow only for optional and log.

**Extension:** match by ID first, then normalized title. Verify selection. Report strategy health.

---

## 7. Submit and success (`browser_automation.py` ~1972–2010)

**Selectors attempted**

```
button[type='submit']
button[data-testid*='submit']
button:contains('Submit Application')
button:contains('Submit')
button:contains('Apply')
[data-testid='submit-application']
```

**Old behavior:** click; if found, log "Successfully applied!" and return True immediately.

**Problem:** a click is not a verified submission. The extension must:

- verify no required fields are empty;
- click Submit;
- wait for a positive confirmation (`You applied on`, toast, button state);
- if ambiguous → `verifying`, reconcile;
- write-ahead before click.

---

## 8. Rate limiting (`rate_limiter.py`)

**Defaults**

```
min_delay_seconds 60
max_delay_seconds 120
daily_limit 50
session_batch_size 10
session_break_min 300
session_break_max 600
jitter_percent 10
enabled true
```

**Behavior**

- Check daily limit before each job.
- Break every 10 applications (`session_applications % batch == 0`).
- Base delay random uniform(min,max).
- Exponential backoff on consecutive errors: `2 ** errors`, capped at 16×.
- Jitter ±10%.
- Count daily application only on success.
- History keeps last 100.

**Extension changes**

- daily cap 25, hard cap 100.
- active hours 08:00–22:00.
- honor 429/403; pause after repeated signals.
- injectable clock; no terminal countdown.
- session break state survives reload.

---

## 9. Job tracker (`job_tracker.py`)

**Categories**

```
applied      permanent
external     permanent
unsupported  permanent
skipped      reprocessable (reason stored)
failed       retryable
waiting      retryable
```

**Methods**

- `is_tracked(job_id)` checks permanent only.
- `track_applied/external/skipped/unsupported/failed/waiting`.
- `prune(older_than_days)` removes external/unsupported/skipped only.
- `matches_skip_keywords(title, keywords)` simple case-insensitive substring.
- `matches_job_keywords(title, keywords)` simple substring; empty = pass.
- `set_dry_run_mode` global flag.

**Extension changes**

- add `filtered`, `needs_input`, `already_applied`, `blocked`, `ready_for_review`, `verifying`.
- filters check title + description.
- no global mutable dry-run; settings/state.
- terminal/retry policy explicit in contracts.

---

## 10. AI matcher (`resume_matcher.py`)

**Prompt shape**

```
You are a resume selector. Given a job title and job description, pick the single most relevant resume from the list below.

AVAILABLE RESUMES:
  ID {id}: {title} — {description}

SELECTION RULES:
- full stack/frontend/backend/web → FullStack
- AI/ML/data science/software engineering → AI/ML
- automation/no-code/low-code/RPA → Automation
- when in doubt, use the description

OUTPUT FORMAT:
Return ONLY the numeric resume ID. No explanation, no punctuation.

Job Title: ...
Job Description: ...
```

**Historical Python settings (not extension setup):** Gemini 2.0 Flash,
temperature 0.1, top_p 0.95, max_output_tokens 20. Extension 1.1.0 replaces its
direct cloud integration with OpenRouter; see [the AI contract](./CONTRACTS.md#10-ai-contracts).
**Parsing:** first `\d+`; validate against resume list; else fallback to first resume.
**Cache:** SHA-256 of `title::description`; in-memory exact match.
**Rate limit:** 1 second between requests.

**Extension changes**

- optional OpenRouter with the user's chosen model/key; Nano and heuristic stay;
- strict JSON `{resumeId, confidence, reason}`;
- delimit job description as untrusted;
- allowlist IDs;
- cache key includes sorted resume IDs;
- fallback to heuristic/default with low confidence, not silent first;
- no network in tests.

---

## 11. Discovery / IDs (`identifier.py`)

```python
patterns = [
  r"/stu/jobs/(\d+)",
  r"/jobs/(\d+)",
  r'data-job-id="(\d+)"',
  r'"jobId"\s*:\s*(\d+)',
]
# keep IDs > 10_000_000
```

**Extension:** extract from live DOM anchors and attributes; validate numeric > 0; do not use the 10M threshold as the primary filter (spike confirms). Dedupe by ID.

---

## 12. Config (`conf.json.template`)

Keys: `COOKIES`, `RESUMES[]`, `USER_NAME`, `COVER_LETTER_ID`, `TRANSCRIPT_ID`, `URL_LIST[]`, `SKIP_KEYWORDS[]`, `JOB_KEYWORDS[]`, `RATE_LIMIT_CONFIG`, `CHROME_PROFILE`, `PREFERRED_BROWSER`, `PROFILES`, `DATE`, `URL`.

**Extension:** import non-secret keys (see `MIGRATION.md`); never import cookies/passwords.

---

## 13. Known bugs / risks to avoid

1. Hardcoded work-auth Yes / sponsorship No.
2. Hardcoded cover-letter name hint.
3. "First available" document fallback for required docs.
4. Success reported immediately after clicking Submit.
5. `navigator.webdriver`/plugin/platform spoofing.
6. Plaintext password and cookie files.
7. Cookie extraction race with a running Chrome.
8. Chrome profile lock / "close Chrome" requirement.
9. Manual HTML-save discovery workflow.
10. Selenium/ChromeDriver version drift.
11. Global mutable dry-run flag.
12. Job ID `>10M` heuristic.
13. 90–120s fixed sleep with no active-hours/pause support.
14. No screening-question handling.
15. No crash-safe submission/reconciliation.

---

## 14. Parity tests to port

| Python test              | Behavior                                               |
| ------------------------ | ------------------------------------------------------ |
| `test_identifier.py`     | valid/invalid IDs, whitespace, floats, HTML extraction |
| `test_job_tracker.py`    | track/is_tracked/prune categories                      |
| `test_resume_matcher.py` | cache key, fallback                                    |
| `test_sanitize_url.py`   | remove page/ref/UTM, preserve others                   |
| `test_config_loader.py`  | missing conf error, secrets fallback                   |

Add new tests for pacer, answer matching, apply flow, engine, E2E.
