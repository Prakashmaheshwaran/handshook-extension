"""
Authentication Manager for Handshake Automation

Multi-source browser cookie extraction with fallback chain:
1. Chrome Default Profile
2. Custom Chromium-based browsers (Brave, Edge, Arc, etc.)
3. HAR file export
4. Manual cookies.json

Supports both macOS and Windows platforms.
"""

import os
import sys
import json
import glob
import time
import random
import logging
import requests
import threading
import psutil
import browser_cookie3
from typing import Dict, Optional, List
from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.common.exceptions import TimeoutException, WebDriverException

load_dotenv()

# Handshake host — set HANDSHAKE_HOST in .env to swap per university
HOST = os.environ.get("HANDSHAKE_HOST", "app.joinhandshake.com")

# Browser cookie paths by platform
# {profile} will be replaced with the profile name (e.g., "Default", "Profile 1")
BROWSER_PATHS = {
    "darwin": {  # macOS
        "chrome": "~/Library/Application Support/Google/Chrome/{profile}/Cookies",
        "brave": "~/Library/Application Support/BraveSoftware/Brave-Browser/{profile}/Cookies",
        "edge": "~/Library/Application Support/Microsoft Edge/{profile}/Cookies",
        "arc": "~/Library/Application Support/Arc/User Data/{profile}/Cookies",
        "chromium": "~/Library/Application Support/Chromium/{profile}/Cookies",
        "opera": "~/Library/Application Support/com.operasoftware.Opera/{profile}/Cookies",
        "vivaldi": "~/Library/Application Support/Vivaldi/{profile}/Cookies",
    },
    "win32": {  # Windows
        "chrome": "{LOCALAPPDATA}/Google/Chrome/User Data/{profile}/Network/Cookies",
        "chrome_legacy": "{LOCALAPPDATA}/Google/Chrome/User Data/{profile}/Cookies",
        "brave": "{LOCALAPPDATA}/BraveSoftware/Brave-Browser/User Data/{profile}/Network/Cookies",
        "edge": "{LOCALAPPDATA}/Microsoft/Edge/User Data/{profile}/Network/Cookies",
        "chromium": "{LOCALAPPDATA}/Chromium/User Data/{profile}/Network/Cookies",
        "opera": "{APPDATA}/Opera Software/Opera Stable/Network/Cookies",
        "vivaldi": "{LOCALAPPDATA}/Vivaldi/User Data/{profile}/Network/Cookies",
    },
    "linux": {  # Linux
        "chrome": "~/.config/google-chrome/{profile}/Cookies",
        "brave": "~/.config/BraveSoftware/Brave-Browser/{profile}/Cookies",
        "edge": "~/.config/microsoft-edge/{profile}/Cookies",
        "chromium": "~/.config/chromium/{profile}/Cookies",
        "opera": "~/.config/opera/Cookies",
        "vivaldi": "~/.config/vivaldi/{profile}/Cookies",
    }
}


class AuthManager:
    """
    Multi-source browser cookie extraction manager for Handshake authentication.
    
    Implements a fallback chain:
    1. Chrome Default Profile
    2. Other installed Chromium browsers
    3. HAR file (exported from DevTools)
    4. Manual cookies.json file
    
    Validates cookies before returning to ensure they're not expired.
    """
    
    def __init__(
        self,
        domain: str = HOST,
        chrome_profile: str = "Default",
        har_directory: str = ".",
        cookies_json_path: str = "cookies.json",
        validate: bool = True,
        preferred_browser: str = None
    ):
        """
        Initialize the AuthManager.
        
        Args:
            domain: Target domain for cookie extraction
            chrome_profile: Chrome profile name (e.g., "Default", "Profile 1")
            har_directory: Directory to search for HAR files
            cookies_json_path: Path to manual cookies.json file
            validate: Whether to validate cookies against the API
            preferred_browser: Preferred browser to try first (e.g., "brave", "edge")
        """
        self.domain = domain
        self.chrome_profile = chrome_profile
        self.har_directory = har_directory
        self.cookies_json_path = cookies_json_path
        self.validate = validate
        self.preferred_browser = preferred_browser
        self.cookies: Dict[str, str] = {}
        self.source: str = None  # Track where cookies came from
        
        # Detect platform
        self.platform = sys.platform
        if self.platform not in BROWSER_PATHS:
            self.platform = "linux"  # Default to linux for unknown platforms
        
        logging.info(f"🔐 AuthManager initialized for {domain}")
        logging.info(f"   Platform: {self.platform}")
        logging.info(f"   Chrome profile: {chrome_profile}")
    
    def get_cookies(self) -> Dict[str, str]:
        """
        Retrieve cookies using the fallback chain.
        
        Returns:
            Dict of {cookie_name: cookie_value} or empty dict if all methods fail
        """
        methods = [
            ("Chrome", lambda: self._extract_from_browser("chrome")),
        ]
        
        # Add preferred browser first if specified
        if self.preferred_browser and self.preferred_browser != "chrome":
            methods.insert(0, (
                self.preferred_browser.title(),
                lambda b=self.preferred_browser: self._extract_from_browser(b)
            ))
        
        # Add other browsers
        installed_browsers = self._detect_installed_browsers()
        for browser in installed_browsers:
            if browser not in ["chrome", self.preferred_browser]:
                methods.append((
                    browser.title(),
                    lambda b=browser: self._extract_from_browser(b)
                ))
        
        # Add HAR and JSON fallbacks
        methods.extend([
            ("HAR File", self._extract_from_har),
            ("cookies.json", self._load_from_json),
        ])
        
        for method_name, extractor in methods:
            logging.info(f"🔍 Trying {method_name}...")
            try:
                cookies = extractor()
                if cookies:
                    if self.validate:
                        logging.info(f"   Found {len(cookies)} cookies, validating...")
                        if self._validate_cookies(cookies):
                            logging.info(f"✅ {method_name}: Valid cookies extracted!")
                            self.cookies = cookies
                            self.source = method_name
                            return cookies
                        else:
                            logging.warning(f"   ⚠️ {method_name}: Cookies invalid/expired")
                    else:
                        logging.info(f"✅ {method_name}: {len(cookies)} cookies extracted (validation skipped)")
                        self.cookies = cookies
                        self.source = method_name
                        return cookies
                else:
                    logging.info(f"   ❌ {method_name}: No cookies found")
            except Exception as e:
                logging.warning(f"   ❌ {method_name}: {e}")
        
        logging.error("❌ All cookie extraction methods failed!")
        return {}
    
    def _get_browser_cookie_path(self, browser: str) -> Optional[str]:
        """
        Get the cookie file path for a specific browser.
        
        Args:
            browser: Browser name (e.g., "chrome", "brave")
            
        Returns:
            Expanded path to cookie file or None
        """
        paths = BROWSER_PATHS.get(self.platform, {})
        path_template = paths.get(browser)
        
        if not path_template:
            return None
        
        # Expand environment variables for Windows
        if self.platform == "win32":
            path = path_template.format(
                LOCALAPPDATA=os.environ.get("LOCALAPPDATA", ""),
                APPDATA=os.environ.get("APPDATA", ""),
                profile=self.chrome_profile
            )
        else:
            path = path_template.format(profile=self.chrome_profile)
        
        # Expand user home directory
        path = os.path.expanduser(path)
        
        return path
    
    def _detect_installed_browsers(self) -> List[str]:
        """
        Detect which Chromium-based browsers are installed.
        
        Returns:
            List of installed browser names
        """
        installed = []
        paths = BROWSER_PATHS.get(self.platform, {})
        
        for browser, path_template in paths.items():
            try:
                path = self._get_browser_cookie_path(browser)
                if path:
                    # Check if the browser's data directory exists
                    browser_dir = os.path.dirname(path)
                    if os.path.exists(browser_dir):
                        installed.append(browser)
            except Exception:
                continue
        
        logging.info(f"   Detected browsers: {installed}")
        return installed
    
    def _extract_from_browser(self, browser: str) -> Optional[Dict[str, str]]:
        """
        Extract cookies from a specific browser.
        
        Args:
            browser: Browser name (e.g., "chrome", "brave")
            
        Returns:
            Dict of cookies or None
        """
        cookie_path = self._get_browser_cookie_path(browser)
        
        # Check if browser is running (cookies file might be locked)
        if self._is_browser_running(browser):
            logging.warning(f"   ⚠️ {browser.title()} appears to be running. Cookies may be locked.")
        
        try:
            # Try with explicit cookie file path first
            if cookie_path and os.path.exists(cookie_path):
                logging.info(f"   Using cookie file: {cookie_path}")
                cookie_jar = browser_cookie3.chrome(
                    cookie_file=cookie_path,
                    domain_name=self.domain
                )
            else:
                # Fallback to browser_cookie3's auto-detection
                if browser == "chrome":
                    cookie_jar = browser_cookie3.chrome(domain_name=self.domain)
                elif browser == "brave":
                    cookie_jar = browser_cookie3.brave(domain_name=self.domain)
                elif browser == "edge":
                    cookie_jar = browser_cookie3.edge(domain_name=self.domain)
                elif browser == "chromium":
                    cookie_jar = browser_cookie3.chromium(domain_name=self.domain)
                elif browser == "opera":
                    cookie_jar = browser_cookie3.opera(domain_name=self.domain)
                elif browser == "vivaldi":
                    cookie_jar = browser_cookie3.vivaldi(domain_name=self.domain)
                else:
                    # For unknown browsers, try chrome with custom path
                    if cookie_path:
                        cookie_jar = browser_cookie3.chrome(
                            cookie_file=cookie_path,
                            domain_name=self.domain
                        )
                    else:
                        return None
            
            cookies = {c.name: c.value for c in cookie_jar}
            return cookies if cookies else None
            
        except PermissionError:
            logging.warning(f"   ⚠️ Permission denied. Try closing {browser.title()}.")
            return None
        except Exception as e:
            logging.debug(f"   Browser extraction error: {e}")
            return None
    
    def _is_browser_running(self, browser: str) -> bool:
        """
        Check if a browser is currently running.
        
        Args:
            browser: Browser name
            
        Returns:
            True if browser appears to be running
        """
        browser_processes = {
            "chrome": ["Google Chrome", "chrome.exe", "chrome"],
            "brave": ["Brave Browser", "brave.exe", "brave"],
            "edge": ["Microsoft Edge", "msedge.exe", "msedge"],
            "arc": ["Arc", "Arc.exe"],
            "chromium": ["Chromium", "chromium.exe", "chromium"],
            "opera": ["Opera", "opera.exe", "opera"],
            "vivaldi": ["Vivaldi", "vivaldi.exe", "vivaldi"],
        }
        
        process_names = browser_processes.get(browser, [])
        
        try:
            for proc in psutil.process_iter(['name']):
                proc_name = proc.info.get('name', '')
                if proc_name and any(name in proc_name for name in process_names):
                    return True
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
        
        return False
    
    def _extract_from_har(self) -> Optional[Dict[str, str]]:
        """
        Extract cookies from HAR (HTTP Archive) files.
        
        HAR files can be exported from browser DevTools:
        - Chrome: Network tab → Right-click → Save all as HAR
        - Firefox: Network tab → Cog icon → Save All As HAR
        
        Returns:
            Dict of cookies or None
        """
        har_pattern = os.path.join(self.har_directory, "*.har")
        har_files = glob.glob(har_pattern)
        
        if not har_files:
            return None
        
        # Use most recently modified HAR file
        latest_har = max(har_files, key=os.path.getmtime)
        logging.info(f"   Found HAR file: {os.path.basename(latest_har)}")
        
        # Guard against enormous HAR files exhausting RAM
        max_har_mb = float(os.environ.get("MAX_HAR_SIZE_MB", "50"))
        har_size_mb = os.path.getsize(latest_har) / (1024 * 1024)
        if har_size_mb > max_har_mb:
            logging.warning(
                f"   ⚠️ HAR file {os.path.basename(latest_har)} is {har_size_mb:.1f} MB "
                f"(limit: {max_har_mb:.0f} MB). Skipping HAR processing for this session."
            )
            return None

        try:
            with open(latest_har, 'r', encoding='utf-8') as f:
                data = json.load(f)

            entries = data.get('log', {}).get('entries', [])
            cookies = {}
            
            for entry in entries:
                request = entry.get('request', {})
                url = request.get('url', '')
                
                # Only extract cookies from requests to our domain
                if self.domain in url:
                    # Method A: Extract from structured 'cookies' array
                    for c in request.get('cookies', []):
                        name = c.get('name')
                        value = c.get('value')
                        if name and value:
                            cookies[name] = value
                    
                    # Method B: Parse raw 'Cookie' header string
                    for header in request.get('headers', []):
                        if header.get('name', '').lower() == 'cookie':
                            cookie_str = header.get('value', '')
                            for part in cookie_str.split(';'):
                                if '=' in part:
                                    name, value = part.strip().split('=', 1)
                                    cookies[name.strip()] = value.strip()
            
            return cookies if cookies else None
            
        except json.JSONDecodeError as e:
            logging.warning(f"   ⚠️ Invalid HAR JSON: {e}")
            return None
        except Exception as e:
            logging.warning(f"   ⚠️ HAR parsing failed: {e}")
            return None
    
    def _load_from_json(self) -> Optional[Dict[str, str]]:
        """
        Load cookies from a JSON file.
        
        Supports two formats:
        
        Format 1 - Array (browser extension export style):
        [
            {"name": "session_id", "value": "abc123"},
            {"name": "auth_token", "value": "xyz789"}
        ]
        
        Format 2 - Simple dict:
        {
            "session_id": "abc123",
            "auth_token": "xyz789"
        }
        
        Returns:
            Dict of cookies or None
        """
        if not os.path.exists(self.cookies_json_path):
            return None
        
        logging.info(f"   Found: {self.cookies_json_path}")
        
        try:
            with open(self.cookies_json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            cookies = {}
            
            if isinstance(data, list):
                # Array format (browser extension style)
                for cookie in data:
                    if isinstance(cookie, dict):
                        name = cookie.get('name')
                        value = cookie.get('value')
                        if name and value:
                            cookies[name] = value
            elif isinstance(data, dict):
                # Direct dict format
                cookies = {k: v for k, v in data.items() if isinstance(v, str)}
            
            return cookies if cookies else None
            
        except json.JSONDecodeError as e:
            logging.warning(f"   ⚠️ Invalid JSON: {e}")
            return None
        except Exception as e:
            logging.warning(f"   ⚠️ JSON loading failed: {e}")
            return None
    
    def _validate_cookies(self, cookies: Dict[str, str]) -> bool:
        """
        Validate cookies by making a request to Handshake.
        
        Checks if we get a valid response without being redirected to login.
        
        Args:
            cookies: Dict of cookies to validate
            
        Returns:
            True if cookies are valid
        """
        try:
            session = requests.Session()
            session.headers.update({
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                              'AppleWebKit/537.36 (KHTML, like Gecko) '
                              'Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            })
            
            # Set cookies
            for name, value in cookies.items():
                session.cookies.set(name, value, domain=self.domain)
            
            # Make a request to Handshake
            response = session.get(
                f'https://{self.domain}/',
                timeout=15,
                allow_redirects=True
            )
            
            # Check for success indicators
            if response.status_code != 200:
                logging.debug(f"   Validation failed: HTTP {response.status_code}")
                return False
            
            # Check if we were redirected to login
            if 'login' in response.url.lower():
                logging.debug("   Validation failed: Redirected to login")
                return False
            
            # Check for common login page indicators in content
            content_lower = response.text.lower()
            login_indicators = ['sign in', 'log in', 'login', 'authenticate']
            if any(indicator in content_lower[:2000] for indicator in login_indicators):
                # Could be false positive, check for dashboard indicators
                dashboard_indicators = ['dashboard', 'profile', 'jobs', 'applications']
                if not any(ind in content_lower for ind in dashboard_indicators):
                    logging.debug("   Validation failed: Login page detected")
                    return False
            
            return True
            
        except requests.Timeout:
            logging.warning("   Validation timeout - treating cookies as invalid")
            return False  # Fail safe: expired/unreachable validation is not valid
        except Exception as e:
            logging.warning(f"   Validation error: {e}")
            return False
    
    def save_to_json(self, path: str = None) -> bool:
        """
        Save current cookies to a JSON file for backup.
        
        Args:
            path: Output path (defaults to cookies_json_path)
            
        Returns:
            True if saved successfully
        """
        path = path or self.cookies_json_path
        
        if not self.cookies:
            logging.warning("No cookies to save")
            return False
        
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(self.cookies, f, indent=2)
            logging.info(f"✅ Saved {len(self.cookies)} cookies to {path}")
            return True
        except Exception as e:
            logging.error(f"❌ Failed to save cookies: {e}")
            return False


# =============================================================================
# Legacy compatibility functions
# =============================================================================

def get_chrome_cookies(domain: str, profile_name: str = "Default") -> Optional[Dict[str, str]]:
    """
    Legacy function for backward compatibility.
    
    Use AuthManager for new code.
    """
    auth = AuthManager(domain=domain, chrome_profile=profile_name, validate=False)
    return auth._extract_from_browser("chrome")


def is_chrome_running() -> bool:
    """Check if Google Chrome is currently running."""
    auth = AuthManager()
    return auth._is_browser_running("chrome")


# =============================================================================
# Selenium-based browser automation (preserved from original)
# =============================================================================


def find_chrome_binary() -> Optional[str]:
    """Find the Chrome executable path on the current platform."""
    env_override = os.environ.get("CHROME_BINARY")
    if env_override and os.path.isfile(env_override):
        return env_override

    if sys.platform == "win32":
        candidates = [
            os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
        ]
    elif sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    else:
        candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
        ]

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def get_chrome_user_data_dir() -> str:
    """Get Chrome's user data directory path."""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "Google", "Chrome")
    elif sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    else:
        return os.path.join(home, ".config", "google-chrome")


def get_available_chrome_profiles() -> List[str]:
    """List Chrome profile directory names (Default, Profile 1, Profile 2, ...)."""
    user_data = get_chrome_user_data_dir()
    if not os.path.isdir(user_data):
        return ["Default"]
    profiles = []
    for name in os.listdir(user_data):
        path = os.path.join(user_data, name)
        if not os.path.isdir(path):
            continue
        if name == "Default":
            profiles.append(name)
        elif name.startswith("Profile ") and name[8:].strip().isdigit():
            profiles.append(name)
    # Sort: Default first, then Profile 1, 2, ... 14
    def _order(p):
        if p == "Default":
            return (0, 0)
        return (1, int(p.replace("Profile ", "").strip()))
    profiles.sort(key=_order)
    return profiles if profiles else ["Default"]


def load_cookies_to_driver(driver, cookies_dict: Dict[str, str]) -> None:
    """Load cookies into a Selenium WebDriver."""
    if not cookies_dict:
        return
    
    try:
        for name, value in cookies_dict.items():
            cookie = {'name': name, 'value': value}
            driver.add_cookie(cookie)
        logging.info(f"✅ Loaded {len(cookies_dict)} cookies into session")
    except Exception as e:
        logging.warning(f"⚠️ Error loading cookies: {e}")


def automate_browser(
    url_list,
    html_output_dir: str,
    existing_cookies: Dict = None,
    chrome_profile: str = None,
    persistent_temp_dir: str = None,
    keep_driver_open: bool = False,
) -> Optional[Dict[str, str]]:
    """
    Open Chrome via Selenium to navigate URLs and save HTML content.
    
    STEALTH MODE FEATURES:
    - Randomized URL processing order
    - 20-40 second random delays between URLs
    - Human-like scrolling behavior
    - Random mouse movements
    - Extensive anti-detection Chrome flags
    - Randomized viewport sizes
    - Disabled automation indicators
    
    Args:
        url_list: List of URLs to visit
        html_output_dir: Directory to save HTML files
        existing_cookies: Optional cookies to restore
        
    Returns:
        Dict of extracted cookies or None
    """
    import random
    from selenium.webdriver.common.action_chains import ActionChains
    
    logging.info("🥷 STEALTH MODE: Using Chrome profile with anti-detection")
    
    # Ensure url_list is a list
    if isinstance(url_list, str):
        url_list = [url_list]
    
    # STEALTH: Randomize URL order to avoid predictable patterns
    url_list = list(url_list)  # Copy to avoid modifying original
    random.shuffle(url_list)
    logging.info(f"🎲 Randomized URL order ({len(url_list)} URLs)")
    
    # Ensure output directory exists
    os.makedirs(html_output_dir, exist_ok=True)
    
    cookies_extracted = {}
    driver = None
    
    try:
        from dotenv import load_dotenv
        load_dotenv()
        logging.info("🚀 Launching Chrome with stealth configuration...")
        options = Options()
        
        # =====================================================
        # MINIMAL CHROME FLAGS FOR PROFILE 14
        # =====================================================
        
        # Hide automation - essential only
        options.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
        options.add_experimental_option('useAutomationExtension', False)
        
        # Basic window size
        options.add_argument("--window-size=1536,864")
        
        # Language
        options.add_argument("--lang=en-US")
        
        # =====================================================
        # CHROME CONFIGURATION - try available profiles until one launches
        # =====================================================
        chrome_binary = find_chrome_binary()
        if not chrome_binary:
            logging.error("❌ Chrome binary not found. Please install Chrome or set CHROME_BINARY env var.")
            return {}
        options.binary_location = chrome_binary

        user_data_dir = get_chrome_user_data_dir()
        available = get_available_chrome_profiles()
        preferred = (chrome_profile or "Default").strip()
        # Try preferred first, then the rest
        profiles_to_try = [preferred] if preferred in available else []
        profiles_to_try += [p for p in available if p not in profiles_to_try]
        logging.info(f"   Available Chrome profiles: {profiles_to_try}")

        # Minimal essential flags (same for every attempt)
        options.add_argument("--no-first-run")
        options.add_argument("--no-default-browser-check")

        service = Service(ChromeDriverManager().install())
        launch_timeout_sec = 28

        # Try temporary profile FIRST (always works, even when Chrome is running)
        if persistent_temp_dir:
            temp_dir = persistent_temp_dir
            os.makedirs(temp_dir, exist_ok=True)
            logging.info(f"   Using persistent session profile: {temp_dir}")
        else:
            import tempfile
            temp_dir = tempfile.mkdtemp(prefix="handshook_chrome_")
            logging.info("   Trying temporary Chrome profile first (works even when Chrome is running)...")
        opt_temp = Options()
        opt_temp.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
        opt_temp.add_experimental_option("useAutomationExtension", False)
        opt_temp.add_argument("--window-size=1536,864")
        opt_temp.add_argument("--lang=en-US")
        opt_temp.binary_location = chrome_binary
        opt_temp.add_argument(f"--user-data-dir={temp_dir}")
        opt_temp.add_argument("--no-first-run")
        opt_temp.add_argument("--no-default-browser-check")
        try:
            driver = webdriver.Chrome(service=service, options=opt_temp)
            chrome_profile = "Temporary"
            logging.info("   Chrome started successfully with temporary profile")
        except Exception as e_temp:
            logging.warning(f"   Temporary profile failed: {e_temp}")
            logging.info("   Falling back to real Chrome profiles...")

            # Fallback: try real profiles
            for profile_name in profiles_to_try:
                opt = Options()
                opt.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
                opt.add_experimental_option("useAutomationExtension", False)
                opt.add_argument("--window-size=1536,864")
                opt.add_argument("--lang=en-US")
                opt.binary_location = chrome_binary
                opt.add_argument(f"--user-data-dir={user_data_dir}")
                opt.add_argument(f"--profile-directory={profile_name}")
                opt.add_argument("--no-first-run")
                opt.add_argument("--no-default-browser-check")

                create_result = {"driver": None, "error": None}

                def _create(opt_copy):
                    try:
                        create_result["driver"] = webdriver.Chrome(service=service, options=opt_copy)
                    except Exception as e:
                        create_result["error"] = e

                logging.info(f"   Trying profile: {profile_name} ...")
                t = threading.Thread(target=_create, args=(opt,), daemon=True)
                t.start()
                t.join(timeout=launch_timeout_sec)

                if t.is_alive():
                    logging.warning(f"   Timed out with profile '{profile_name}' (likely in use), trying next.")
                    continue
                if create_result["error"] is not None:
                    logging.warning(f"   Profile '{profile_name}' failed: {create_result['error']}")
                    continue

                driver = create_result["driver"]
                chrome_profile = profile_name
                logging.info(f"   Chrome started successfully with profile: {chrome_profile}")
                break
            else:
                logging.error("❌ Could not start Chrome with any profile.")
                return {}

        # Avoid indefinite hangs on navigation
        try:
            driver.set_page_load_timeout(60)
        except Exception:
            pass
        
        # Additional JavaScript-level stealth
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": """
                // Override webdriver property
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                
                // Override plugins to look normal
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                
                // Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
                
                // Override platform (consistent with User-Agent - Windows)
                Object.defineProperty(navigator, 'platform', {
                    get: () => 'Win32'
                });
                
                // Hide automation indicators in Chrome
                window.chrome = { runtime: {} };
            """
        })
        
        logging.info("✅ Chrome launched with stealth configuration")

        def safe_get(url_to_open: str, attempts: int = 3) -> bool:
            """Navigate with timeouts/retries. Returns True if we reached a non-blank URL."""
            last_err = None
            for n in range(1, attempts + 1):
                try:
                    driver.get(url_to_open)
                    cur = (driver.current_url or "").lower()
                    if cur and cur != "about:blank" and not cur.startswith("data:"):
                        return True
                    # Sometimes Chrome loads blank briefly; give it a moment.
                    time.sleep(2)
                    cur = (driver.current_url or "").lower()
                    if cur and cur != "about:blank" and not cur.startswith("data:"):
                        return True
                except TimeoutException as e:
                    last_err = e
                    try:
                        driver.execute_script("window.stop();")
                    except Exception:
                        pass
                except WebDriverException as e:
                    last_err = e

                # Small backoff before retry
                time.sleep(2 * n)

            if last_err:
                logging.warning(f"⚠️ Navigation failed after retries: {last_err}")
            return False
        
        # =====================================================
        # HELPER FUNCTIONS FOR HUMAN-LIKE BEHAVIOR
        # =====================================================
        
        def human_scroll(driver):
            """Simulate human-like scrolling behavior."""
            try:
                # Random number of scroll actions (2-5)
                num_scrolls = random.randint(2, 5)
                
                for _ in range(num_scrolls):
                    # Random scroll amount (200-600 pixels)
                    scroll_amount = random.randint(200, 600)
                    
                    # 70% scroll down, 30% scroll up (humans mostly scroll down)
                    direction = -1 if random.random() < 0.7 else 1
                    
                    driver.execute_script(f"window.scrollBy(0, {scroll_amount * direction})")
                    
                    # Pause between scrolls (0.5-2 seconds)
                    time.sleep(random.uniform(0.5, 2.0))
                
                # Sometimes scroll back to top (20% chance)
                if random.random() < 0.2:
                    driver.execute_script("window.scrollTo(0, 0)")
                    time.sleep(random.uniform(0.3, 0.8))
                    
            except Exception as e:
                logging.debug(f"Scroll simulation: {e}")
        
        def human_mouse_movement(driver):
            """Simulate random mouse movements."""
            try:
                actions = ActionChains(driver)
                
                # Random number of movements (2-4)
                num_moves = random.randint(2, 4)

                for _ in range(num_moves):
                    # Move to position with slight offset
                    actions.move_by_offset(
                        random.randint(-50, 50),
                        random.randint(-50, 50)
                    )
                    actions.pause(random.uniform(0.1, 0.5))
                
                actions.perform()
                
            except Exception as e:
                logging.debug(f"Mouse movement simulation: {e}")
        
        def random_delay(min_seconds=20, max_seconds=40):
            """Wait a random amount of time."""
            delay = random.uniform(min_seconds, max_seconds)
            logging.info(f"⏳ Human-like delay: {delay:.1f} seconds...")
            time.sleep(delay)
        
        # try_auto_login is now a module-level function (defined below)
        
        # =====================================================
        # RESTORE COOKIES
        # =====================================================
        if existing_cookies:
            logging.info("🍪 Restoring session cookies...")
            try:
                from urllib.parse import urlparse
                if url_list:
                    domain = urlparse(url_list[0]).netloc
                    driver.get(f"https://{domain}")
                    time.sleep(random.uniform(2, 4))  # Random initial wait
                    load_cookies_to_driver(driver, existing_cookies)
                    logging.info("✅ Cookies restored")
                    time.sleep(random.uniform(1, 3))
            except Exception as e:
                logging.warning(f"⚠️ Could not restore cookies: {e}")
        
        # =====================================================
        # PROCESS URLS (RANDOMIZED ORDER WITH HUMAN BEHAVIOR)
        # =====================================================
        for i, url in enumerate(url_list):
            logging.info(f"\n[{i+1}/{len(url_list)}] 🌍 Navigating to URL...")
            logging.info(f"   {url[:80]}..." if len(url) > 80 else f"   {url}")

            # Always warm up the session on the Handshake host first.
            # This reduces blank/failed navigations on some Chrome profiles.
            safe_get(f"https://{HOST}/", attempts=2)

            if not safe_get(url, attempts=3):
                logging.error("❌ Could not navigate to target URL. Skipping to next URL.")
                continue
            
            # Initial page load wait (10-15 seconds as requested)
            initial_wait = random.uniform(10, 15)
            logging.info(f"⏳ Page loading... ({initial_wait:.1f}s)")
            time.sleep(initial_wait)
            
            # Check for login page or not logged in
            is_logged_in = False
            max_attempts = 3
            attempt = 0
            
            while not is_logged_in and attempt < max_attempts:
                attempt += 1
                current_url = driver.current_url
                page_source = driver.page_source.lower()
                
                # Check various indicators of not being logged in
                _has_session = (
                    driver.get_cookie("_session_id") is not None
                    or driver.get_cookie("_trajectory_session") is not None
                    or driver.get_cookie("production_current_user") is not None
                )
                if "login" in current_url or \
                   "sign in" in page_source[:5000] or \
                   "signin" in current_url or \
                   "session expired" in page_source[:5000] or \
                   not _has_session:
                    
                    logging.warning(f"⚠️ Not logged in (attempt {attempt}/{max_attempts})")
                    handshake_email = os.environ.get("HANDSHAKE_EMAIL", "").strip()
                    handshake_password = os.environ.get("HANDSHAKE_PASSWORD", "")
                    if handshake_email and handshake_password:
                        logging.info("   Attempting auto-login with credentials from .env...")
                        if try_auto_login(driver, handshake_email, handshake_password):
                            is_logged_in = True
                            logging.info("✅ Login successful!")
                            logging.info(f"   Current URL: {driver.current_url}")
                            time.sleep(random.uniform(3, 6))
                            break
                        logging.warning("   Auto-login failed; falling back to manual login.")
                    logging.warning("   Please log in to Handshake manually in the opened Chrome window...")
                    logging.warning("   You have 180 seconds (3 minutes) to log in...")
                    
                    max_wait = 180
                    start_time = time.time()
                    
                    while (time.time() - start_time) < max_wait:
                        time.sleep(2)
                        current_url = driver.current_url
                        page_source = driver.page_source.lower()
                        
                        # Check if logged in now
                        if "login" not in current_url and \
                           "signin" not in current_url and \
                           ("dashboard" in current_url or
                            "job-search" in current_url or
                            "jobs" in current_url or
                            driver.get_cookie("_session_id") is not None or
                            driver.get_cookie("_trajectory_session") is not None or
                            driver.get_cookie("production_current_user") is not None):
                            is_logged_in = True
                            break
                    
                    if not is_logged_in:
                        logging.warning("⚠️ Still not logged in after waiting")
                        if attempt < max_attempts:
                            logging.info(f"   Retrying... (attempt {attempt + 1}/{max_attempts})")
                            driver.refresh()
                            time.sleep(5)
                    else:
                        logging.info("✅ Login successful!")
                        logging.info(f"   Current URL: {driver.current_url}")
                        time.sleep(random.uniform(3, 6))
                else:
                    is_logged_in = True
                    logging.info("✅ Already logged in to Handshake")
                    logging.info(f"   Current URL: {driver.current_url}")
            
            if not is_logged_in:
                logging.error("❌ Failed to log in after multiple attempts")
                logging.error("   Skipping this URL and continuing to the next one")
                continue
            
            # HUMAN BEHAVIOR: Scroll around the page
            logging.info("📜 Simulating reading behavior (scrolling)...")
            human_scroll(driver)
            
            # HUMAN BEHAVIOR: Random mouse movements
            logging.info("🖱️ Simulating mouse activity...")
            human_mouse_movement(driver)
            
            # Brief pause after interactions
            time.sleep(random.uniform(2, 5))
            
            # Extract cookies
            driver_cookies = driver.get_cookies()
            for c in driver_cookies:
                cookies_extracted[c['name']] = c['value']
            
            # Save HTML
            html_content = driver.page_source
            timestamp = int(time.time())
            # Use random suffix to avoid predictable filenames
            random_suffix = random.randint(1000, 9999)
            html_file = os.path.join(html_output_dir, f"page_{timestamp}_{random_suffix}.html")
            
            with open(html_file, "w", encoding="utf-8") as f:
                f.write(html_content)
            
            logging.info(f"✅ Saved HTML: {os.path.basename(html_file)}")

            # Persist cookies immediately after each successful URL so they
            # survive if Chrome crashes on a later URL.
            if cookies_extracted:
                try:
                    update_conf_file(None, cookies_extracted)
                    logging.info(f"   🍪 Session cookies saved ({len(cookies_extracted)} cookies)")
                except Exception as _ce:
                    logging.debug(f"   Could not persist cookies mid-run: {_ce}")

            # HUMAN DELAY: 20-40 seconds between URLs (as requested)
            if i < len(url_list) - 1:
                random_delay(20, 40)

        logging.info(f"\n✅ Extracted {len(cookies_extracted)} cookies")

        if keep_driver_open:
            logging.info("✅ Stealth fetch complete. Keeping browser open for apply phase...")
            return cookies_extracted, driver
        else:
            logging.info("✅ Stealth automation complete. Closing browser...")
            time.sleep(random.uniform(1, 3))
            driver.quit()
            return cookies_extracted

    except Exception as e:
        logging.error(f"❌ Automation error: {e}")
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        # Return any cookies collected before the crash so they are not lost
        result = cookies_extracted if cookies_extracted else None
        return (result, None) if keep_driver_open else result


def try_auto_login(driver, email: str, password: str) -> bool:
    """Attempt to log in to Handshake using email/password.
    Handshake uses a two-step flow: Enter email -> Next -> Enter password -> Sign in."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC  # noqa: F401
    
    try:
        login_url = f"https://{HOST}/login"
        # Always navigate to the login page to guarantee a clean login form
        driver.get(login_url)
        time.sleep(random.uniform(3, 5))

        # Step 0: Some Handshake variants show a "Continue with email" / "Sign in with email"
        # button before revealing the email input. Click it if present.
        for by, val in [
            (By.XPATH, "//button[contains(.,'Continue with email') or contains(.,'Sign in with email') or contains(.,'Use email')]"),
            (By.XPATH, "//a[contains(.,'Continue with email') or contains(.,'Sign in with email')]"),
        ]:
            try:
                btn = driver.find_element(by, val)
                if btn and btn.is_displayed():
                    logging.info("   Auto-login: clicking 'Continue with email' button")
                    btn.click()
                    time.sleep(random.uniform(2, 3))
                    break
            except Exception:
                continue

        wait = WebDriverWait(driver, 20)
        # Step 1: Find "Enter email" field (Handshake first step)
        email_el = None
        for by, val in [
            (By.CSS_SELECTOR, "input[placeholder='Enter email']"),
            (By.XPATH, "//input[@placeholder='Enter email']"),
            (By.CSS_SELECTOR, "input[type='email']"),
            (By.CSS_SELECTOR, "input[name='email']"),
            (By.CSS_SELECTOR, "input[id='email']"),
            (By.XPATH, "//input[contains(@placeholder,'mail') or contains(@placeholder,'Email')]"),
        ]:
            try:
                email_el = wait.until(EC.presence_of_element_located((by, val)))
                if email_el and email_el.is_displayed():
                    break
                email_el = None
            except Exception:
                continue
        if not email_el:
            logging.warning("   Auto-login: could not find 'Enter email' field")
            return False
        email_el.clear()
        time.sleep(0.2)
        email_el.send_keys(email)
        time.sleep(random.uniform(0.3, 0.6))
        # Click "Next" button (Handshake shows Next after email)
        next_btn = None
        for by, val in [
            (By.XPATH, "//button[contains(.,'Next')]"),
            (By.XPATH, "//*[contains(text(),'Next') and self::button or self::input]"),
            (By.CSS_SELECTOR, "button[type='submit']"),
        ]:
            try:
                next_btn = driver.find_element(by, val)
                if next_btn and next_btn.is_displayed():
                    break
            except Exception:
                continue
        if not next_btn:
            logging.warning("   Auto-login: could not find Next button")
            return False
        next_btn.click()
        time.sleep(random.uniform(4, 7))
        # Step 2: Find password field (Handshake second step)
        wait_password = WebDriverWait(driver, 15)
        password_el = None
        for by, val in [
            (By.CSS_SELECTOR, "input[type='password']"),
            (By.CSS_SELECTOR, "input[name='password']"),
            (By.CSS_SELECTOR, "input[id='password']"),
            (By.CSS_SELECTOR, "input[autocomplete='current-password']"),
            (By.XPATH, "//input[contains(@placeholder,'assword') or contains(@placeholder,'Password')]"),
        ]:
            try:
                password_el = wait_password.until(EC.presence_of_element_located((by, val)))
                if password_el and password_el.is_displayed():
                    break
            except Exception:
                continue
        if not password_el:
            logging.warning("   Auto-login: could not find password field (after Next)")
            return False
        password_el.clear()
        time.sleep(0.2)
        password_el.send_keys(password)
        time.sleep(random.uniform(0.3, 0.6))
        # Click Sign in / Log in button
        submit = None
        for by, val in [
            (By.XPATH, "//button[contains(.,'Sign in') or contains(.,'Log in') or contains(.,'Login')]"),
            (By.CSS_SELECTOR, "button[type='submit']"),
            (By.CSS_SELECTOR, "input[type='submit']"),
        ]:
            try:
                submit = driver.find_element(by, val)
                if submit and submit.is_displayed():
                    break
            except Exception:
                continue
        if not submit:
            logging.warning("   Auto-login: could not find Sign in / Log in button")
            return False
        submit.click()
        time.sleep(random.uniform(5, 8))
        current_url = driver.current_url
        if "login" in current_url or "signin" in current_url.lower():
            logging.warning("   Auto-login: still on login page (wrong credentials or captcha?)")
            return False
        logging.info("   Auto-login succeeded")
        return True
    except Exception as e:
        logging.warning(f"   Auto-login failed: {e}")
        return False


def update_conf_file(conf_path: str, cookies: Dict[str, str]) -> bool:
    """
    Save cookies to secrets.json (config_loader). Does not modify conf.py
    to avoid corrupting it with embedded cookie data.

    Args:
        conf_path: Unused; kept for API compatibility.
        cookies: Dict of cookies to write

    Returns:
        True if saved successfully
    """
    if not cookies:
        return False
    try:
        from config_loader import save_cookies
        if save_cookies(cookies):
            logging.info(f"Updated secrets.json with {len(cookies)} cookies")
            return True
        return False
    except Exception as e:
        logging.error(f"Error saving cookies to secrets.json: {e}")
        return False


def apply_to_jobs_via_browser(job_ids: List[int], resume_id: int = None, resume_ids: Dict[int, int] = None,
                                 cover_letter_id: int = None,
                                 transcript_id: int = None, user_name: str = None,
                                 chrome_profile: str = "Default",
                                 headless: bool = False, dry_run: bool = True,
                                 persistent_temp_dir: str = None,
                                 existing_driver=None) -> Dict[int, bool]:
    """
    Apply to jobs using browser automation (clicking Apply buttons).
    This bypasses API issues and uses the actual Handshake web interface.

    Args:
        job_ids: List of job IDs to apply to
        resume_id: Single resume document ID (fallback if resume_ids not provided)
        resume_ids: Dict mapping job_id -> resume_id for per-job AI-matched resume selection
        cover_letter_id: Optional Cover Letter document ID to upload if requested
        user_name: User's name for document selection (e.g., "John Doe")
        chrome_profile: Chrome profile to use (default: Default)
        headless: Whether to run headless (False for debugging)
        dry_run: If True, won't actually submit applications

    Returns:
        Dict mapping job_id -> success (True/False)
    """
    import tempfile
    import shutil
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from webdriver_manager.chrome import ChromeDriverManager
    
    results = {}
    driver = None
    _owned_driver = True  # track if we launched the driver (so we know whether to quit it)

    try:
        logging.info(f"🚀 Starting browser-based job application for {len(job_ids)} jobs")
        logging.info(f"   Dry run mode: {dry_run}")

        handshake_email = os.environ.get("HANDSHAKE_EMAIL", "").strip()
        handshake_password = os.environ.get("HANDSHAKE_PASSWORD", "")

        if existing_driver is not None:
            # Reuse the browser session from the fetch phase — no relaunch needed
            driver = existing_driver
            _owned_driver = False
            logging.info("♻️  Reusing existing browser session — skipping relaunch & re-login")
        else:
            logging.info(f"   Chrome profile: {chrome_profile}")

            # Setup Chrome options
            options = Options()

            if headless:
                options.add_argument("--headless")

            # Anti-detection options
            options.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
            options.add_experimental_option('useAutomationExtension', False)
            options.add_argument("--disable-blink-features=AutomationControlled")

            # Window size
            options.add_argument("--window-size=1536,864")

            # Get Chrome binary
            chrome_binary = os.environ.get("CHROME_BINARY", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            if not os.path.exists(chrome_binary):
                chrome_binary = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
            if not os.path.exists(chrome_binary):
                import shutil as _shutil
                chrome_binary = _shutil.which("chrome") or _shutil.which("google-chrome")

            if not chrome_binary:
                logging.error("❌ Chrome binary not found")
                return results

            # Use persistent profile if provided, otherwise a throwaway temp dir
            _ephemeral_dir = None
            if persistent_temp_dir:
                temp_dir = persistent_temp_dir
                os.makedirs(temp_dir, exist_ok=True)
                logging.info(f"   Using persistent session profile: {temp_dir}")
            else:
                import tempfile
                temp_dir = tempfile.mkdtemp(prefix="chrome_apply_")
                _ephemeral_dir = temp_dir
                logging.info(f"   Using temporary Chrome profile: {temp_dir}")

            options.binary_location = chrome_binary
            options.add_argument(f"--user-data-dir={temp_dir}")

            # Launch browser
            service = Service(ChromeDriverManager().install())
            driver = webdriver.Chrome(service=service, options=options)

            # Stealth JS
            driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
                "source": """
                    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
                    Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                    window.chrome = { runtime: {} };
                """
            })

            wait = WebDriverWait(driver, 15)

            # SESSION RESTORE — inject saved cookies before checking login state
            from dotenv import load_dotenv
            load_dotenv()
            try:
                from config_loader import load_cookies as _load_cookies
                saved_cookies = _load_cookies()
                if saved_cookies:
                    driver.get(f"https://{HOST}/")
                    time.sleep(3)
                    load_cookies_to_driver(driver, saved_cookies)
                    logging.info(f"🍪 Injected {len(saved_cookies)} saved cookies into apply session")
                    time.sleep(2)
                    driver.get(f"https://{HOST}/")
                    time.sleep(4)
            except Exception as _ce:
                logging.debug(f"Could not inject saved cookies: {_ce}")

            # CHECK if already logged in; only do auto-login if needed
            _cur = driver.current_url.lower()
            _has_session = (
                driver.get_cookie("_session_id") is not None
                or driver.get_cookie("_trajectory_session") is not None
                or driver.get_cookie("production_current_user") is not None
            )
            _already_logged_in = (
                "login" not in _cur
                and "signin" not in _cur
                and _has_session
            )

            if _already_logged_in:
                logging.info("✅ Already logged in via saved session — skipping login step")
            else:
                logging.info("🔐 Session not active, attempting auto-login...")

                if not handshake_email or not handshake_password:
                    logging.error("❌ HANDSHAKE_EMAIL and HANDSHAKE_PASSWORD must be set in .env")
                    return results

                if not try_auto_login(driver, handshake_email, handshake_password):
                    logging.error("❌ Auto-login failed. Cannot proceed with job applications.")
                    return results

                logging.info("✅ Login successful! Proceeding with job applications...")
        
        # Process each job
        for idx, job_id in enumerate(job_ids, 1):
            try:
                logging.info(f"\n[{idx}/{len(job_ids)}] Processing job {job_id}...")

                # Guard: verify the browser window is still alive before navigating.
                # If Chrome was closed (e.g. after a long inter-job delay), mark all
                # remaining jobs failed and stop — we cannot recover without a restart.
                try:
                    _ = driver.window_handles
                except Exception:
                    logging.warning("   Browser window closed — cannot continue. Remaining jobs marked failed.")
                    for remaining_id in job_ids[idx - 1:]:
                        results[remaining_id] = False
                    break

                # Navigate to job page (correct Handshake URL format)
                job_url = f"https://{HOST}/jobs/{job_id}"
                driver.get(job_url)
                
                # Wait longer for page to fully load (Handshake loads dynamically)
                # Longer wait simulates reading the job description
                logging.info("   Waiting for job page to load...")
                time.sleep(random.uniform(15, 25))
                
                # Check if page loaded correctly
                if "login" in driver.current_url.lower():
                    logging.warning("   Session expired, attempting to re-login...")
                    if try_auto_login(driver, handshake_email, handshake_password):
                        driver.get(job_url)
                        time.sleep(6)
                    else:
                        logging.error(f"   Re-login failed, skipping job {job_id}")
                        results[job_id] = False
                        continue
                
                # Check if we're on the right page
                current_url = driver.current_url
                logging.info(f"   Current URL: {current_url}")
                
                # If redirected to job-search, try navigating directly again
                if "/job-search/" in current_url:
                    logging.info("   Redirected to job search, trying direct navigation again...")
                    driver.get(job_url)
                    time.sleep(6)
                
                # Simulate reading the job description: scroll down slowly, pause, scroll back
                try:
                    driver.execute_script("window.scrollTo(0, 300);")
                    time.sleep(random.uniform(2, 4))
                    driver.execute_script("window.scrollTo(0, 700);")
                    time.sleep(random.uniform(3, 6))
                    driver.execute_script("window.scrollTo(0, 0);")
                    time.sleep(random.uniform(1, 2))
                except Exception:
                    pass
                
                # Try clicking on the job title if we're still on a search page
                try:
                    # Look for a link or heading with the job ID
                    job_links = driver.find_elements(By.XPATH, f"//a[contains(@href,'{job_id}')]")
                    if job_links:
                        for link in job_links:
                            if link.is_displayed():
                                logging.info("   Clicking job link to open detail page...")
                                link.click()
                                time.sleep(5)
                                break
                except Exception as e:
                    logging.debug(f"   Could not click job link: {e}")
                
                # Debug: Log page source snippet for debugging
                logging.info("   Debugging: Looking for Apply button...")
                
                # Look for Apply button (Easy Apply jobs have "Apply" button, external jobs have "Apply externally")
                apply_btn = None
                is_external = False
                
                # Get ALL buttons AND anchor tags on the page for debugging
                try:
                    all_buttons = driver.find_elements(By.TAG_NAME, "button")
                    all_links = driver.find_elements(By.TAG_NAME, "a")
                    logging.info(f"   Found {len(all_buttons)} buttons and {len(all_links)} links on page")
                    
                    # Check buttons
                    for idx, btn in enumerate(all_buttons[:15]):
                        try:
                            if btn.is_displayed():
                                btn_text = btn.text.strip()
                                aria_label = btn.get_attribute("aria-label") or ""
                                logging.info(f"   Button {idx}: text='{btn_text}', aria='{aria_label}'")
                                # Check if this is an Apply button
                                if btn_text.lower() == "apply":
                                    apply_btn = btn
                                    logging.info("   -> Selected as Apply button")
                                    break
                                elif "apply" in btn_text.lower():
                                    if "externally" in btn_text.lower() or "external" in btn_text.lower():
                                        logging.info("   -> External apply detected, skipping")
                                        is_external = True
                                        break
                        except Exception:
                            pass

                    # If not found in buttons, check links
                    if not apply_btn and not is_external:
                        for idx, link in enumerate(all_links[:10]):
                            try:
                                if link.is_displayed():
                                    link_text = link.text.strip()
                                    aria_label = link.get_attribute("aria-label") or ""
                                    if link_text.lower() == "apply":
                                        apply_btn = link
                                        logging.info(f"   -> Found Apply link: text='{link_text}', aria='{aria_label}'")
                                        break
                                    elif "apply" in link_text.lower():
                                        if "externally" in link_text.lower() or "external" in link_text.lower():
                                            logging.info("   -> External apply link detected, skipping")
                                            is_external = True
                                            break
                            except Exception:
                                pass
                                
                except Exception as e:
                    logging.debug(f"   Error listing elements: {e}")
                
                # Skip if external apply
                if is_external:
                    results[job_id] = False
                    continue
                
                # Try additional XPath searches for Apply button
                if not apply_btn:
                    try:
                        # Try aria-label search
                        apply_btn = driver.find_element(By.XPATH, "//button[@aria-label='Apply to job']")
                        if apply_btn and apply_btn.is_displayed():
                            logging.info("   Found Apply button via aria-label")
                    except Exception:
                        pass

                if not apply_btn:
                    try:
                        # Try finding by partial text match (more flexible)
                        apply_btns = driver.find_elements(By.XPATH,
                            "//button[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'apply')]")
                        for btn in apply_btns:
                            if btn.is_displayed():
                                btn_text = btn.text.strip().lower()
                                if btn_text == "apply":
                                    apply_btn = btn
                                    logging.info("   Found Apply button via case-insensitive text match")
                                    break
                                elif "externally" in btn_text:
                                    logging.info("   External apply detected, skipping")
                                    is_external = True
                                    break
                    except Exception:
                        pass
                
                # Skip if external apply
                if is_external:
                    results[job_id] = False
                    continue
                
                if not apply_btn:
                    logging.info(f"   No apply button found for job {job_id}")
                    results[job_id] = False
                    continue
                
                # Get job title
                job_title = "Unknown"
                try:
                    title_el = driver.find_element(By.CSS_SELECTOR, "h1, [data-testid='job-title']")
                    job_title = title_el.text
                except Exception:
                    pass
                
                logging.info(f"   Job: {job_title[:50]}")
                
                if dry_run:
                    logging.info("   [DRY-RUN] Would click Apply")
                    results[job_id] = True  # Mark as success in dry-run
                    continue
                
                # Click Apply button to open the modal
                logging.info("   Clicking Apply...")
                apply_btn.click()
                # Wait longer for React modal to fully render
                time.sleep(random.uniform(4, 6))

                # Check if modal/dialog opened
                modal_found = False
                modal_el = None
                for modal_sel in ["[role='dialog']", "[aria-modal='true']",
                                  "[data-testid*='modal']", ".modal-content"]:
                    try:
                        el = driver.find_element(By.CSS_SELECTOR, modal_sel)
                        if el.is_displayed():
                            modal_found = True
                            modal_el = el
                            logging.info("   Application modal opened")
                            break
                    except Exception:
                        continue

                if not modal_found:
                    logging.info("   No modal — one-click apply or external")

                # Debug: log ALL select elements and comboboxes found in modal/page
                try:
                    all_selects = driver.find_elements(By.TAG_NAME, "select")
                    all_combos = driver.find_elements(By.CSS_SELECTOR,
                        "[role='combobox'], [role='listbox'], [role='option']")
                    logging.info(f"   Debug: {len(all_selects)} <select> elements, "
                                 f"{len(all_combos)} combobox/listbox elements on page")
                    for s in all_selects:
                        try:
                            logging.info(f"   <select> name={s.get_attribute('name')} "
                                         f"id={s.get_attribute('id')} "
                                         f"aria-label={s.get_attribute('aria-label')}")
                            from selenium.webdriver.support.ui import Select as _S
                            opts = _S(s).options
                            for o in opts:
                                logging.info(f"      option value={o.get_attribute('value')!r} text={o.text.strip()!r}")
                        except Exception:
                            pass
                except Exception:
                    pass
                
                # Handle Work Authorization questions if present
                # Look for radio buttons for "legally authorized to work"
                try:
                    # Find "Yes" radio for work authorization
                    work_auth_yes = driver.find_element(By.XPATH,
                        "//label[contains(.,'legally authorized') or contains(.,'Work authorization')]//following::input[@type='radio'][1]"
                        "| //legend[contains(.,'legally authorized')]//following::input[@type='radio'][1]")
                    if work_auth_yes and not work_auth_yes.is_selected():
                        logging.info("   Selecting 'Yes' for work authorization")
                        work_auth_yes.click()
                        time.sleep(0.5)
                except Exception:
                    pass

                # Look for visa sponsorship question - select "No"
                try:
                    # Find radio buttons related to visa/sponsorship
                    sponsorship_radios = driver.find_elements(By.XPATH,
                        "//label[contains(.,'sponsorship') or contains(.,'visa')]//following::input[@type='radio']")
                    if sponsorship_radios:
                        # Try to select "No" option
                        for radio in sponsorship_radios:
                            try:
                                label = radio.find_element(By.XPATH, "following-sibling::label")
                                if label.text.strip().lower() == "no":
                                    if not radio.is_selected():
                                        logging.info("   Selecting 'No' for visa sponsorship")
                                        radio.click()
                                        time.sleep(0.5)
                                    break
                            except Exception:
                                continue
                except Exception:
                    pass
                
                # Handle Resume selection
                job_resume_id = (resume_ids.get(job_id) if resume_ids else None) or resume_id
                if job_resume_id:
                    try:
                        resume_selected = False
                        resume_id_str = str(job_resume_id)

                        def _pick_resume_from_dropdown(resume_id_str):
                            try:
                                WebDriverWait(driver, 4).until(
                                    lambda d: d.find_elements(By.CSS_SELECTOR,
                                        "[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]"))
                            except Exception:
                                pass
                            opts = driver.find_elements(By.CSS_SELECTOR,
                                "[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]")
                            for opt in opts:
                                if not opt.is_displayed():
                                    continue
                                opt_val = (opt.get_attribute("data-value") or
                                           opt.get_attribute("data-id") or
                                           opt.get_attribute("value") or "")
                                if opt_val == resume_id_str:
                                    driver.execute_script("arguments[0].scrollIntoView(true);", opt)
                                    opt.click()
                                    logging.info(f"   ✅ Resume selected: {opt.text.strip()} (ID: {resume_id_str})")
                                    return True
                            # Fallback: pick first visible non-empty option
                            for opt in opts:
                                if opt.is_displayed() and opt.text.strip():
                                    opt.click()
                                    logging.info(f"   ✅ Resume selected (first available): {opt.text.strip()}")
                                    return True
                            return False

                        # Strategy 1: search input placeholder "resume"
                        search_inputs = driver.find_elements(By.CSS_SELECTOR,
                            "input[placeholder*='resume' i], input[placeholder*='Resume']")
                        for inp in search_inputs:
                            try:
                                if not inp.is_displayed():
                                    continue
                                logging.info("   Found resume search input, clicking to open dropdown...")
                                driver.execute_script("arguments[0].scrollIntoView(true);", inp)
                                time.sleep(0.3)
                                inp.click()
                                time.sleep(1.5)
                                if _pick_resume_from_dropdown(resume_id_str):
                                    resume_selected = True
                                    time.sleep(0.5)
                                    break
                            except Exception:
                                continue

                        # Strategy 2: React combobox near "resume" label
                        if not resume_selected:
                            triggers = driver.find_elements(By.CSS_SELECTOR,
                                "[role='combobox'], button[aria-haspopup='listbox'], "
                                "button[aria-haspopup='true'], [aria-expanded]")
                            for trigger in triggers:
                                try:
                                    if not trigger.is_displayed():
                                        continue
                                    parent_text = ""
                                    try:
                                        parent = driver.execute_script(
                                            "return arguments[0].closest('div,section,fieldset')", trigger)
                                        if parent:
                                            parent_text = parent.text.lower()
                                    except Exception:
                                        pass
                                    if "resume" not in parent_text and "resume" not in (trigger.text or "").lower():
                                        continue
                                    logging.info("   Found resume combobox trigger, clicking...")
                                    driver.execute_script("arguments[0].scrollIntoView(true);", trigger)
                                    time.sleep(0.3)
                                    trigger.click()
                                    time.sleep(1.5)
                                    if _pick_resume_from_dropdown(resume_id_str):
                                        resume_selected = True
                                        time.sleep(0.5)
                                        break
                                except Exception:
                                    continue

                        # Strategy 3: hidden <select> with matching value
                        if not resume_selected:
                            from selenium.webdriver.support.ui import Select as _SelR
                            for sel_el in driver.find_elements(By.TAG_NAME, "select"):
                                try:
                                    sel_obj = _SelR(sel_el)
                                    sel_obj.select_by_value(resume_id_str)
                                    logging.info(f"   ✅ Resume selected via hidden <select> (ID: {resume_id_str})")
                                    resume_selected = True
                                    time.sleep(0.5)
                                    break
                                except Exception:
                                    continue

                        if not resume_selected:
                            logging.info("   Resume field not found — using pre-selected default resume")
                    except Exception as _re:
                        logging.debug(f"   Resume selection error: {_re}")

                # Handle Transcript selection
                if transcript_id:
                    try:
                        transcript_selected = False
                        transcript_id_str = str(transcript_id)

                        def _pick_transcript_from_dropdown(transcript_id_str):
                            """After a dropdown is open, find and click the matching transcript option."""
                            try:
                                WebDriverWait(driver, 4).until(
                                    lambda d: d.find_elements(By.CSS_SELECTOR,
                                        "[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]"))
                            except Exception:
                                pass
                            opts = driver.find_elements(By.CSS_SELECTOR,
                                "[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]")
                            for opt in opts:
                                if not opt.is_displayed():
                                    continue
                                opt_text = opt.text.strip()
                                opt_val = (opt.get_attribute("data-value") or
                                           opt.get_attribute("data-id") or
                                           opt.get_attribute("value") or "")
                                if opt_val == transcript_id_str or opt_text:
                                    driver.execute_script("arguments[0].scrollIntoView(true);", opt)
                                    opt.click()
                                    logging.info(f"   ✅ Transcript selected: {opt_text}")
                                    return True
                            return False

                        # Strategy 1 (PRIMARY): search input — "Search your transcripts"
                        search_inputs = driver.find_elements(By.CSS_SELECTOR,
                            "input[placeholder*='transcript' i], input[placeholder*='Transcript']")
                        for inp in search_inputs:
                            try:
                                if not inp.is_displayed():
                                    continue
                                logging.info("   Found transcript search input, clicking to open dropdown...")
                                driver.execute_script("arguments[0].scrollIntoView(true);", inp)
                                time.sleep(0.3)
                                inp.click()
                                time.sleep(1.5)
                                if _pick_transcript_from_dropdown(transcript_id_str):
                                    transcript_selected = True
                                    time.sleep(0.5)
                                    break
                            except Exception:
                                continue

                        # Strategy 2: React combobox near "transcript" label
                        if not transcript_selected:
                            triggers = driver.find_elements(By.CSS_SELECTOR,
                                "[role='combobox'], button[aria-haspopup='listbox'], "
                                "button[aria-haspopup='true'], [aria-expanded]")
                            for trigger in triggers:
                                try:
                                    if not trigger.is_displayed():
                                        continue
                                    parent_text = ""
                                    try:
                                        parent = driver.execute_script(
                                            "return arguments[0].closest('div,section,fieldset')", trigger)
                                        if parent:
                                            parent_text = parent.text.lower()
                                    except Exception:
                                        pass
                                    if "transcript" not in parent_text and "transcript" not in (trigger.text or "").lower():
                                        continue
                                    logging.info("   Found transcript combobox trigger, clicking...")
                                    driver.execute_script("arguments[0].scrollIntoView(true);", trigger)
                                    time.sleep(0.3)
                                    trigger.click()
                                    time.sleep(1.5)
                                    if _pick_transcript_from_dropdown(transcript_id_str):
                                        transcript_selected = True
                                        time.sleep(0.5)
                                        break
                                except Exception:
                                    continue

                        # Strategy 3: hidden React-backing <select>
                        if not transcript_selected:
                            from selenium.webdriver.support.ui import Select as _SelT
                            for sel_el in driver.find_elements(By.TAG_NAME, "select"):
                                try:
                                    sel_obj = _SelT(sel_el)
                                    sel_obj.select_by_value(transcript_id_str)
                                    logging.info("   ✅ Transcript selected via hidden <select>")
                                    transcript_selected = True
                                    time.sleep(0.5)
                                    break
                                except Exception:
                                    continue

                        if not transcript_selected:
                            logging.info("   Transcript field not found on this form (job may not require one)")
                    except Exception as _te:
                        logging.debug(f"   Transcript selection error: {_te}")

                # Handle Cover Letter selection
                if cover_letter_id:
                    try:
                        cover_selected = False
                        cover_id_str = str(cover_letter_id)
                        cover_title_hint = "Prakash"  # matches "Prakash_K_CV.docx"

                        def _pick_from_dropdown(cover_id_str, cover_title_hint):
                            """After a dropdown is open, find and click the matching option."""
                            try:
                                WebDriverWait(driver, 4).until(
                                    lambda d: d.find_elements(By.CSS_SELECTOR,
                                        "[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]"))
                            except Exception:
                                pass
                            opts = driver.find_elements(By.CSS_SELECTOR,
                                "[role='option'], [role='listbox'] li, ul[role='listbox'] li, li[data-value]")
                            # First pass: match by doc ID or title hint
                            for opt in opts:
                                if not opt.is_displayed():
                                    continue
                                opt_text = opt.text.strip()
                                opt_val = (opt.get_attribute("data-value") or
                                           opt.get_attribute("data-id") or
                                           opt.get_attribute("value") or "")
                                if opt_val == cover_id_str or cover_title_hint.lower() in opt_text.lower():
                                    driver.execute_script("arguments[0].scrollIntoView(true);", opt)
                                    opt.click()
                                    logging.info(f"   ✅ Cover Letter selected: {opt_text}")
                                    return True
                            # Second pass: pick first visible non-empty option
                            for opt in opts:
                                if opt.is_displayed() and opt.text.strip():
                                    opt.click()
                                    logging.info(f"   ✅ Cover Letter selected (first available): {opt.text.strip()}")
                                    return True
                            return False

                        # Strategy 1 (PRIMARY): search input — "Search your cover letters"
                        # This is what Handshake actually renders in the apply modal.
                        search_inputs = driver.find_elements(By.CSS_SELECTOR,
                            "input[placeholder*='cover' i], input[placeholder*='Cover']")
                        for inp in search_inputs:
                            try:
                                if not inp.is_displayed():
                                    continue
                                logging.info("   Found cover letter search input, clicking to open dropdown...")
                                driver.execute_script("arguments[0].scrollIntoView(true);", inp)
                                time.sleep(0.3)
                                inp.click()
                                time.sleep(1.5)
                                if _pick_from_dropdown(cover_id_str, cover_title_hint):
                                    cover_selected = True
                                    time.sleep(0.5)
                                    break
                            except Exception:
                                continue

                        # Strategy 2: React combobox button/trigger near "cover" label
                        if not cover_selected:
                            triggers = driver.find_elements(By.CSS_SELECTOR,
                                "[role='combobox'], button[aria-haspopup='listbox'], "
                                "button[aria-haspopup='true'], [aria-expanded]")
                            for trigger in triggers:
                                try:
                                    if not trigger.is_displayed():
                                        continue
                                    parent_text = ""
                                    try:
                                        parent = driver.execute_script(
                                            "return arguments[0].closest('div,section,fieldset')", trigger)
                                        if parent:
                                            parent_text = parent.text.lower()
                                    except Exception:
                                        pass
                                    if "cover" not in parent_text and "cover" not in (trigger.text or "").lower():
                                        continue
                                    logging.info("   Found cover letter combobox trigger, clicking...")
                                    driver.execute_script("arguments[0].scrollIntoView(true);", trigger)
                                    time.sleep(0.3)
                                    trigger.click()
                                    time.sleep(1.5)
                                    if _pick_from_dropdown(cover_id_str, cover_title_hint):
                                        cover_selected = True
                                        time.sleep(0.5)
                                        break
                                except Exception:
                                    continue

                        # Strategy 3: hidden React-backing <select> with the doc ID value
                        if not cover_selected:
                            from selenium.webdriver.support.ui import Select as _Sel
                            for sel_el in driver.find_elements(By.TAG_NAME, "select"):
                                try:
                                    sel_obj = _Sel(sel_el)
                                    sel_obj.select_by_value(cover_id_str)
                                    logging.info("   ✅ Cover Letter selected via hidden <select>")
                                    cover_selected = True
                                    time.sleep(0.5)
                                    break
                                except Exception:
                                    continue

                        if not cover_selected:
                            logging.info("   Cover Letter field not found on this form (job may not require one)")
                    except Exception as _cle:
                        logging.debug(f"   Cover letter selection error: {_cle}")

                # Look for Submit Application button
                submit_selectors = [
                    "button[type='submit']",
                    "button[data-testid*='submit']",
                    "button:contains('Submit Application')",
                    "button:contains('Submit')",
                    "button:contains('Apply')",
                    "[data-testid='submit-application']",
                ]
                
                submit_btn = None
                for selector in submit_selectors:
                    try:
                        if ":contains" in selector:
                            text = selector.split("'")[1]
                            submit_btn = driver.find_element(By.XPATH,
                                f"//button[contains(text(), '{text}')]")
                        else:
                            submit_btn = driver.find_element(By.CSS_SELECTOR, selector)
                        if submit_btn and submit_btn.is_displayed():
                            break
                    except Exception:
                        continue
                
                if submit_btn and submit_btn.is_displayed():
                    logging.info("   Clicking Submit Application...")
                    submit_btn.click()
                    logging.info("   ✅ Successfully applied!")
                    time.sleep(random.uniform(3, 5))
                    results[job_id] = True
                else:
                    logging.warning("   ⚠️ Could not find submit button - job may require external apply")
                    results[job_id] = False
                
                # Human-like delay between applications
                if idx < len(job_ids):
                    delay = random.uniform(90, 120)
                    logging.info(f"   Waiting {delay:.1f}s before next job...")
                    time.sleep(delay)
                    
            except Exception as e:
                logging.error(f"   ❌ Error applying to job {job_id}: {e}")
                results[job_id] = False
                continue
        
        return results
        
    except Exception as e:
        logging.error(f"Browser automation error: {e}", exc_info=True)
        return results
        
    finally:
        if driver and _owned_driver:
            driver.quit()
        # Only delete the profile dir if it was ephemeral (not the persistent session dir)
        try:
            if '_ephemeral_dir' in locals() and _ephemeral_dir and os.path.exists(_ephemeral_dir):
                import shutil
                shutil.rmtree(_ephemeral_dir, ignore_errors=True)
                logging.info("🧹 Cleaned up temporary profile")
        except Exception as e:
            logging.debug(f"Could not cleanup temp profile: {e}")
