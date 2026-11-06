/** Load the distributable ZIP in a fresh profile, never .output/chrome-mv3. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXTENSION_ROOT, launchExtension, test as base, expect } from './extension';

export const test = base.extend<{ browserLocalHour: number }, { packagedExtensionPath: string }>({
  browserLocalHour: [12, { option: true }],
  packagedExtensionPath: [
    // Playwright requires destructuring for fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // Package the current build once per worker so the ordinary build → E2E
      // workflow also exercises a fresh archive, never a stale release ZIP.
      execFileSync(process.execPath, ['scripts/package.ts'], { cwd: EXTENSION_ROOT });
      const metadata = JSON.parse(
        readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8'),
      ) as { version: string };
      const archive = path.join(
        EXTENSION_ROOT,
        '.output',
        `handshook-${metadata.version}-chrome.zip`,
      );
      const checksum = readFileSync(`${archive}.sha256`, 'utf8').split(/\s/)[0];
      expect(createHash('sha256').update(readFileSync(archive)).digest('hex')).toBe(checksum);
      const directory = mkdtempSync(path.join(tmpdir(), 'handshook-release-walkthrough-'));
      try {
        execFileSync('unzip', ['-q', archive, '-d', directory]);
        const manifest = JSON.parse(
          readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
        ) as {
          version: string;
          minimum_chrome_version: string;
          side_panel: { default_path: string };
        };
        expect(manifest.version).toBe(metadata.version);
        expect(manifest.minimum_chrome_version).toBe('120');
        expect(manifest.side_panel.default_path).toBe('sidepanel.html');
        await use(directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
  context: async ({ packagedExtensionPath, browserLocalHour }, use) => {
    // Keep real Date/timers and all product settings. Shift only this browser's
    // timezone so daytime and night-time runs do not depend on when CI starts.
    // Etc/GMT signs are inverted; normalize to the supported -12..+11 offsets.
    const offsetHours = ((browserLocalHour - new Date().getUTCHours() + 36) % 24) - 12;
    const timezoneId = `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`;
    const launched = await launchExtension({ extensionPath: packagedExtensionPath, timezoneId });
    try {
      // Page emulation alone may leave the MV3 worker on the host's timezone.
      // Verify the engine's realm too, rather than assuming TZ reached Chromium.
      expect(await launched.serviceWorker.evaluate(() => new Date().getTimezoneOffset())).toBe(
        0 - offsetHours * 60,
      );
      await use(launched.context);
    } finally {
      await launched.close();
    }
  },
});

export { expect };
