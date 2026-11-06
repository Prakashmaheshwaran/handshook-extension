/**
 * Side-panel helper for AI setup that must run in the panel itself: the
 * optional OpenRouter host permission request (it needs the user's click).
 */

import { browser as wxtBrowser } from 'wxt/browser';
import { OPENROUTER_ORIGIN } from '@/ai/permissions';

export { OPENROUTER_ORIGIN } from '@/ai/permissions';

export type PermissionOutcome = 'granted' | 'denied' | 'unavailable';

interface PermissionsApi {
  request?: (permissions: { origins?: string[] }) => Promise<boolean>;
}

/** Request directly from the click, before saving a key or making a cloud request. */
export async function requestOpenRouterHostPermission(): Promise<PermissionOutcome> {
  const scope = globalThis as unknown as {
    browser?: { permissions?: PermissionsApi };
  };
  const permissions =
    (wxtBrowser as unknown as { permissions?: PermissionsApi } | undefined)?.permissions ??
    scope.browser?.permissions;
  if (!permissions?.request) return 'unavailable';
  try {
    const granted = await permissions.request({ origins: [OPENROUTER_ORIGIN] });
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}
