"""
Configuration Loader for Handshake Automation

Separates sensitive credentials from configuration:
- secrets.json: Cookies, API keys (gitignored, never committed)
- conf.json: Non-sensitive config (URLs, resume IDs, rate limits)

This module provides a unified interface to load both.

NOTE: conf.py is no longer supported. Migrate to conf.json.
      See conf.json.template for the required format.
"""

import json
import logging
from pathlib import Path
from typing import Dict

BASE_DIR = Path(__file__).resolve().parent
SECRETS_FILE = BASE_DIR / "secrets.json"
CONF_JSON_FILE = BASE_DIR / "conf.json"


def _load_secrets() -> Dict:
    """Load secrets from secrets.json."""
    if not SECRETS_FILE.exists():
        logging.warning(f"⚠️ {SECRETS_FILE} not found.")
        return {}
    try:
        with open(SECRETS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        logging.error(f"❌ Invalid JSON in {SECRETS_FILE}: {e}", exc_info=True)
        return {}
    except Exception as e:
        logging.error(f"❌ Could not load {SECRETS_FILE}: {e}", exc_info=True)
        return {}


def _save_secrets(data: Dict) -> bool:
    """Save secrets to secrets.json."""
    try:
        with open(SECRETS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        return True
    except Exception as e:
        logging.error(f"❌ Could not save {SECRETS_FILE}: {e}", exc_info=True)
        return False


def load_conf() -> Dict:
    """
    Load configuration from conf.json.

    Raises:
        FileNotFoundError: with a clear migration message if conf.json is missing.
    """
    if not CONF_JSON_FILE.exists():
        conf_py = BASE_DIR / "conf.py"
        if conf_py.exists():
            raise FileNotFoundError(
                f"\n\n{'='*70}\n"
                "MIGRATION REQUIRED: conf.py is no longer supported.\n\n"
                "Handshook now uses conf.json for configuration.\n"
                "Please create conf.json from the template:\n\n"
                "    cp conf.json.template conf.json\n\n"
                "Then edit conf.json and fill in your settings.\n"
                "See conf.json.template for all available options.\n"
                f"{'='*70}\n"
            )
        raise FileNotFoundError(
            f"\n\n{'='*70}\n"
            "conf.json not found. Create it from the template:\n\n"
            "    cp conf.json.template conf.json\n\n"
            "Then edit conf.json and fill in your settings.\n"
            f"{'='*70}\n"
        )
    try:
        with open(CONF_JSON_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"❌ Invalid JSON in conf.json: {e}") from e
    except Exception as e:
        raise RuntimeError(f"❌ Could not load conf.json: {e}") from e


def load_cookies() -> Dict[str, str]:
    """Load cookies from secrets.json, falling back to conf.json."""
    secrets = _load_secrets()
    # Support both lowercase and uppercase key names
    cookies = secrets.get("cookies", secrets.get("COOKIES", {}))

    if cookies:
        return cookies

    # Fallback: try conf.json
    try:
        conf = load_conf()
        legacy_cookies = conf.get("COOKIES", {})
        if legacy_cookies:
            logging.info("📦 Loaded cookies from conf.json. Consider running migrate_secrets().")
            return legacy_cookies
    except Exception:
        pass

    return {}


# Alias for backward compatibility
get_cookies = load_cookies


def save_cookies(cookies: Dict[str, str]) -> bool:
    """Save cookies to secrets.json."""
    if not cookies:
        return False
    secrets = _load_secrets()
    # Remove old uppercase key if present, use lowercase
    secrets.pop("COOKIES", None)
    secrets["cookies"] = cookies
    return _save_secrets(secrets)


def migrate_secrets():
    """
    Migrate sensitive data from conf.json COOKIES key to secrets.json.

    Extracts COOKIES from conf.json, saves to secrets.json,
    and clears the COOKIES key in conf.json.
    """
    if not CONF_JSON_FILE.exists():
        logging.error("❌ conf.json not found")
        return False

    try:
        conf = load_conf()
    except Exception as e:
        logging.error(f"❌ Could not load conf.json: {e}", exc_info=True)
        return False

    secrets = _load_secrets()

    cookies = conf.get("COOKIES", {})
    if cookies:
        secrets["cookies"] = cookies
        logging.info(f"📦 Extracted {len(cookies)} cookies from conf.json")

    if not _save_secrets(secrets):
        return False

    # Clear COOKIES in conf.json
    try:
        conf["COOKIES"] = {}
        with open(CONF_JSON_FILE, 'w', encoding='utf-8') as f:
            json.dump(conf, f, indent=2)
        logging.info("✅ Cleared COOKIES in conf.json (now in secrets.json)")
    except Exception as e:
        logging.warning(f"⚠️ Could not update conf.json: {e}")

    logging.info(f"✅ Secrets migrated to {SECRETS_FILE}")
    return True


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    print("🔄 Migrating secrets from conf.json to secrets.json...")
    if migrate_secrets():
        print("✅ Migration complete!")
    else:
        print("❌ Migration failed!")
