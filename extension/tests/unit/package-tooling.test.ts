// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
};
let fixture: string;
let build: string;
let output: string;

async function writeManifest(version: string): Promise<void> {
  await writeFile(
    path.join(build, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Packaging test fixture',
      version,
      permissions: ['storage', 'alarms', 'sidePanel'],
      background: { service_worker: 'background.js' },
      side_panel: { default_path: 'sidepanel.html' },
      icons: Object.fromEntries(['16', '32', '48', '128'].map((size) => [size, 'icon.png'])),
    }),
  );
}

function runPackage() {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts/package.ts'), '--build', build, '--out', output],
    { cwd: root, encoding: 'utf8', timeout: 10_000 },
  );
}

beforeEach(async () => {
  await mkdir(path.join(root, '.output'), { recursive: true });
  fixture = await mkdtemp(path.join(root, '.output', 'package-test-'));
  build = path.join(fixture, 'build');
  output = path.join(fixture, 'dist');
  await mkdir(build);
  await mkdir(output);
  await writeManifest(packageJson.version);
  await writeFile(path.join(build, 'background.js'), '// fixture service worker\n');
  await writeFile(path.join(build, 'sidepanel.html'), '<!doctype html><title>Fixture</title>');
  await writeFile(path.join(build, 'icon.png'), Buffer.from('fixture icon'));
});

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('release package CLI', () => {
  it('rejects mismatched versions without writing a ZIP', async () => {
    const mismatch = packageJson.version === '0.0.0' ? '0.0.1' : '0.0.0';
    await writeManifest(mismatch);
    const result = runPackage();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Version mismatch: manifest.json says ${mismatch} but package.json says ${packageJson.version}`,
    );
    expect(await readdir(output)).toEqual([]);
  });

  it('writes a ZIP and matching SHA-256 sidecar and prints the checksum', async () => {
    const result = runPackage();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const zipName = `handshook-${packageJson.version}-chrome.zip`;
    const zip = await readFile(path.join(output, zipName));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const checksum = createHash('sha256').update(zip).digest('hex');
    expect(await readFile(path.join(output, `${zipName}.sha256`), 'utf8')).toBe(
      `${checksum}  ${zipName}\n`,
    );
    expect(result.stdout).toContain(`sha256:    ${checksum}`);
  });

  it('refuses credentials in the build before writing release artifacts', async () => {
    await writeFile(path.join(build, 'secrets.json'), '{}');
    const result = runPackage();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('secrets.json must never ship');
    expect(await readdir(output)).toEqual([]);
  });
});
