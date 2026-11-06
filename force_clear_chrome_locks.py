"""
Force clear Chrome locks
Run this before handshake.py if you get DevToolsActivePort errors
"""
import os
import glob
import subprocess
import time

def force_clear_locks():
    # Get Chrome user data directory from environment or use default
    user_data_dir = os.environ.get('CHROME_USER_DATA',
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data"))
    profile_name = os.environ.get('CHROME_PROFILE', 'Default')
    profile_path = os.path.join(user_data_dir, profile_name)
    
    print("=" * 60)
    print(f"FORCE CLEARING CHROME LOCKS FOR {profile_name}")
    print("=" * 60)
    
    # Kill all Chrome processes
    print("\n1. Killing all Chrome processes...")
    try:
        subprocess.run(['taskkill', '/F', '/IM', 'chrome.exe'],
                      capture_output=True, check=False)
        subprocess.run(['taskkill', '/F', '/IM', 'chromedriver.exe'],
                      capture_output=True, check=False)
        print("   Done")
    except Exception as e:
        print(f"   Error: {e}")
    
    time.sleep(2)
    
    # Remove Singleton lock files
    print("\n2. Removing Singleton lock files...")
    lock_patterns = [
        os.path.join(profile_path, "Singleton*"),
        os.path.join(user_data_dir, "Singleton*"),
    ]
    for pattern in lock_patterns:
        for lock_file in glob.glob(pattern):
            try:
                os.remove(lock_file)
                print(f"   Removed: {os.path.basename(lock_file)}")
            except Exception as e:
                print(f"   Could not remove {lock_file}: {e}")
    
    # Remove LOCK file
    print("\n3. Removing LOCK file...")
    lock_file = os.path.join(profile_path, "LOCK")
    if os.path.exists(lock_file):
        try:
            os.remove(lock_file)
            print("   Removed: LOCK")
        except Exception as e:
            print(f"   Could not remove LOCK: {e}")
    else:
        print("   LOCK file not found (good)")
    
    # Clear Preferences exit state
    print("\n4. Clearing Preferences crash state...")
    pref_file = os.path.join(profile_path, "Preferences")
    if os.path.exists(pref_file):
        try:
            import json
            with open(pref_file, 'r', encoding='utf-8') as f:
                prefs = json.load(f)
            if 'profile' in prefs:
                prefs['profile']['exit_type'] = 'Normal'
                prefs['profile']['exited_cleanly'] = True
            with open(pref_file, 'w', encoding='utf-8') as f:
                json.dump(prefs, f)
            print("   Done")
        except Exception as e:
            print(f"   Error: {e}")
    
    # Remove Crashpad metadata
    print("\n5. Removing Crashpad metadata...")
    crashpad = os.path.join(profile_path, "Crashpad", "metadata")
    if os.path.exists(crashpad):
        try:
            os.remove(crashpad)
            print("   Removed")
        except Exception as e:
            print(f"   Error: {e}")
    
    print("\n" + "=" * 60)
    print("LOCK CLEARING COMPLETE")
    print("=" * 60)
    print("\nYou can now run: python handshake.py --dry-run")

if __name__ == "__main__":
    force_clear_locks()
