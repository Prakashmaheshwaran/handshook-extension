---
description: Initial project setup and configuration
---

# Setup Workflow

## Prerequisites
- Python 3.10+
- Google Chrome installed
- Handshake account with login access

## Steps

// turbo
1. Clone the repository (if not already):
```bash
git clone <repo-url> handshook
cd handshook
```

// turbo
2. Create and activate virtual environment:
```bash
python3 -m venv venv
source venv/bin/activate
```

// turbo
3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Create configuration file:
```bash
cp conf.py.example conf.py  # or create from template
```

5. Create environment file for API keys:
```bash
cp .env.template .env
```

6. Edit `.env` with your Groq API key:
```
GROQ_API_KEY=your_groq_api_key_here
```

7. Edit `conf.py` with your settings:
   - **RESUMES**: Add your resume IDs with descriptions
   - **COVER/TRANSCRIPT**: Add document IDs if required
   - **DATE**: Set the cutoff date for job filtering
   - **RATE_LIMIT_CONFIG**: Adjust if needed

8. Login to Handshake in Chrome at `app.joinhandshake.com`

9. Close Chrome completely

// turbo
10. Run the automation:
```bash
python3 handshake.py
```

## Finding Document IDs
1. Go to Handshake → Documents section
2. Click on a document
3. The ID is in the URL: `app.joinhandshake.com/documents/{ID}`
