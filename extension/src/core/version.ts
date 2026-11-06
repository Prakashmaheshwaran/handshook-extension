import { browser } from 'wxt/browser';

/**
 * The running extension's manifest version.
 *
 * Tests and the mock bridge may not provide `runtime.getManifest`, so fall back
 * to the release version instead of throwing inside diagnostics.
 */
export function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '1.1.4';
  }
}
