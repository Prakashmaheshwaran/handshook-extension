/**
 * Secret-key detection for legacy imports.
 *
 * Python `conf.json` historically carried cookies, and users sometimes paste
 * API keys or passwords next to the real settings. Imports are allowlist-based,
 * so values are never stored; this helper only decides which *key names* to
 * report so the UI can say what was skipped. It never inspects values.
 */

const SECRET_KEY_PATTERN =
  /cookie|passw|secret|token|api[-_]?key|apikey|credential|authorization|csrf|xsrf|private[-_]?key|(^|[^a-z])session([^a-z]|$)|(^|[^a-z])auth([^a-z]|$)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key.trim());
}

/** Comment/placeholder keys from the template (`_comment`, `__note`, ...). */
export function isCommentKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed === '' || trimmed.startsWith('_');
}
