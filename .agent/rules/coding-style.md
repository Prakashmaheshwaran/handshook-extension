---
description: Python coding conventions and style rules for the Handshook project
---

# Coding Style Rules

## Python Standards
- Use Python 3.10+ features where appropriate
- Follow PEP 8 with 4-space indentation
- Maximum line length: 120 characters
- Use type hints for function signatures when beneficial

## Naming Conventions
- Functions/methods: `snake_case` (e.g., `validate_job_id`, `get_profile_paths`)
- Classes: `PascalCase` (e.g., `Job`, `RateLimiter`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `HOST`, `RESUME_TYPE_ID`)
- Module-level variables: `snake_case` or `UPPER_CASE` for pseudo-constants

## Logging
- Always use the `logging` module instead of `print()`
- Use emoji prefixes for visual clarity:
  - ✅ Success operations
  - ❌ Errors
  - ⚠️ Warnings
  - 📊 Statistics/summaries
  - 🔍 Search/matching operations
  - ⏳ Waiting/delays
  - 🧹 Cleanup operations
  - 🚀 Starting operations

## Error Handling
- Use try/except for external API calls and file operations
- Always log exceptions with context
- Provide fallback behavior where possible (e.g., `resume_matcher.py` falls back to first resume)

## File Patterns
- Profile-specific files: `{operation}_{profile_name}.{ext}` (e.g., `jobs_default.csv`)
- Use `pathlib.Path` for cross-platform path handling
- Always use `encoding='utf-8'` for file operations

## Documentation
- Docstrings for all public functions (Google style preferred)
- Inline comments for complex logic
- Module-level docstrings explaining purpose
