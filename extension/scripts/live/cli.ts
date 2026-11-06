/**
 * Drive the running live harness.
 *
 *   npm run live -- status
 *   npm run live -- open url=https://app.joinhandshake.com/job-search
 *   npm run live -- sidepanel
 *   npm run live -- snapshot tab=sidepanel
 *   npm run live -- click tab=sidepanel "selector=role=button[name='Scan']"
 *   npm run live -- shot tab=handshake        # prints a PNG path; open it with the Read tool
 *   npm run live -- logs kind=pageerror limit=20
 *   npm run live -- eval tab=sw "expr=chrome.runtime.getManifest().version"
 *   npm run live -- reload                     # rebuild + reload extension + Handshake tabs
 *   npm run live -- stop
 *
 * Arguments are `key=value`; values that parse as JSON (numbers, booleans) are typed.
 * Tabs: an index from `tabs`, `last` (default), `sidepanel`, `handshake`, or `sw` for eval.
 */

import { readSession } from './common.ts';

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) {
  console.error('Usage: npm run live -- <command> [key=value ...]');
  process.exit(2);
}

const input: Record<string, unknown> = { cmd };
for (const arg of rest) {
  const eq = arg.indexOf('=');
  if (eq < 0) throw new Error(`Expected key=value, got "${arg}"`);
  const key = arg.slice(0, eq);
  const raw = arg.slice(eq + 1);
  let value: unknown = raw;
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(raw)) value = JSON.parse(raw) as unknown;
  input[key] = value;
}

const session = readSession();
if (!session) {
  console.error(
    'No live harness is running. Start one with "npm run live:start" (login first with "npm run live:login").',
  );
  process.exit(3);
}

const response = await fetch(`${session.controlUrl}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(input),
});
const payload = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
if (!payload.ok) {
  console.error(`❌ ${payload.error ?? 'unknown error'}`);
  process.exit(1);
}
const result = payload.result as Record<string, unknown> | undefined;
if (result && typeof result.snapshot === 'string') {
  console.log(`# ${String(result.url)}\n${result.snapshot}`);
} else if (result && typeof result.text === 'string') {
  console.log(result.text);
} else {
  console.log(JSON.stringify(result, null, 2));
}
