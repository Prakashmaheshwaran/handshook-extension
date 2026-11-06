export const OPENROUTER_ORIGIN = 'https://openrouter.ai/*';

/** CORS is not consent: require the optional extension permission explicitly. */
export async function hasOpenRouterHostPermission(): Promise<boolean> {
  type Permissions = { contains?: (value: { origins: string[] }) => Promise<boolean> };
  const scope = globalThis as unknown as {
    browser?: { permissions?: Permissions };
    chrome?: { permissions?: Permissions };
  };
  try {
    const permissions = scope.browser?.permissions ?? scope.chrome?.permissions;
    return (await permissions?.contains?.({ origins: [OPENROUTER_ORIGIN] })) === true;
  } catch {
    return false;
  }
}
