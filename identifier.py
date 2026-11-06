import re

def validate_job_id(value):
    try:
        s = str(value).strip()
        if not s.isdigit():
            return None
        i = int(s)
        if i <= 0:
            return None
        return i
    except Exception:
        return None

def validate_job_title(title):
    if title is None:
        return None
    if not isinstance(title, str):
        return None
    t = title.strip()
    if not t:
        return None
    return t

def extract_ids_from_html(html):
    """Extract job IDs from HTML content.
    
    Filters out likely search page IDs (smaller numbers like 10756208)
    and keeps actual job posting IDs (typically larger numbers).
    """
    ids = set()
    for pat in [r"/stu/jobs/(\d+)", r"/jobs/(\d+)", r"data-job-id=\"(\d+)\"", r'"jobId"\s*:\s*(\d+)']:
        for m in re.findall(pat, html):
            vid = validate_job_id(m)
            # Filter: job IDs should be > 10 million (actual postings)
            # Search/filter IDs are typically 8 digits starting with 10xxxxxx
            if vid is not None and vid > 10000000:
                ids.add(vid)
    return sorted(ids)
