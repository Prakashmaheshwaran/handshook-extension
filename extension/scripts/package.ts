/**
 * Package an existing MV3 build for the Chrome Web Store.
 *
 * Usage (Node 22.18+ runs TypeScript directly via type stripping):
 *
 *   npm run package
 *   npm run package -- --build .output/chrome-mv3 --out .output
 *
 * What it does:
 * - requires an existing build (it never runs `wxt build`)
 * - validates manifest.json, version alignment, icons, and entrypoints
 * - refuses to package source maps, dotenv files, secrets, or test fixtures
 * - writes `handshook-<version>-chrome.zip` plus a `sha256sum`-compatible
 *   `.sha256` file into the output directory (default: `.output/`)
 *
 * The ZIP is written with Node's zlib only; no external `zip` binary and no
 * dependency is required.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_BUILD_DIR = path.join(PROJECT_ROOT, '.output', 'chrome-mv3');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.output');

const REQUIRED_ICONS = ['16', '32', '48', '128'] as const;
const KNOWN_PERMISSIONS = new Set(['storage', 'alarms', 'sidePanel']);
const FORBIDDEN_BASENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'package-lock.json',
  'cookies.json',
  'secrets.json',
]);
const FORBIDDEN_EXTENSIONS = new Set([
  '.map',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.har',
  '.ts',
  '.tsx',
]);

interface CliOptions {
  buildDir: string;
  outDir: string;
}

interface FileEntry {
  /** POSIX-style path relative to the build root. */
  name: string;
  absolutePath: string;
  data: Buffer;
  mtime: Date;
}

interface ManifestFile {
  manifest_version?: unknown;
  name?: unknown;
  version?: unknown;
  permissions?: unknown;
  optional_host_permissions?: unknown;
  host_permissions?: unknown;
  icons?: unknown;
  background?: unknown;
  side_panel?: unknown;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { buildDir: DEFAULT_BUILD_DIR, outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build' || arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} needs a directory path.`);
      if (arg === '--build') options.buildDir = path.resolve(value);
      else options.outDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npm run package [-- --build <dir>] [--out <dir>]',
          '',
          `  --build  unpacked extension build (default: ${path.relative(PROJECT_ROOT, DEFAULT_BUILD_DIR)})`,
          `  --out    directory for the zip and checksum (default: ${path.relative(PROJECT_ROOT, DEFAULT_OUT_DIR)})`,
        ].join('\n'),
      );
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function assertInsideProject(target: string, label: string): void {
  const relative = path.relative(PROJECT_ROOT, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(
      `${label} must be inside the extension project (${PROJECT_ROOT}). ` +
        `Refusing to package an unrelated directory.`,
    );
  }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    fail(`Cannot read ${file}.`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${file} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateManifest(
  manifest: Record<string, unknown>,
  packageVersion: string,
  buildDir: string,
): string {
  const parsed = manifest as ManifestFile;
  if (parsed.manifest_version !== 3) fail('manifest.json must declare "manifest_version": 3.');
  if (typeof parsed.name !== 'string' || parsed.name.trim().length === 0) {
    fail('manifest.json is missing a non-empty "name".');
  }
  if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(parsed.version)) {
    fail('manifest.json is missing a valid numeric "version" (expected MAJOR.MINOR.PATCH).');
  }
  if (parsed.version !== packageVersion) {
    fail(
      `Version mismatch: manifest.json says ${parsed.version} but package.json says ${packageVersion}. ` +
        'Rebuild so the store zip and package metadata agree.',
    );
  }

  const background = parsed.background;
  if (
    !background ||
    typeof background !== 'object' ||
    typeof (background as { service_worker?: unknown }).service_worker !== 'string'
  ) {
    fail('manifest.json is missing background.service_worker.');
  }
  const serviceWorker = (background as { service_worker: string }).service_worker;
  if (!existsSync(path.join(buildDir, serviceWorker))) {
    fail(`background.service_worker points at a missing file: ${serviceWorker}`);
  }

  const sidePanel = parsed.side_panel;
  if (!sidePanel || typeof sidePanel !== 'object') {
    fail('manifest.json is missing side_panel.');
  }
  const panelPath = (sidePanel as { default_path?: unknown }).default_path;
  if (typeof panelPath !== 'string' || !existsSync(path.join(buildDir, panelPath))) {
    fail('side_panel.default_path points at a missing file.');
  }

  const icons = parsed.icons;
  if (!icons || typeof icons !== 'object') fail('manifest.json is missing "icons".');
  const iconMap = icons as Record<string, unknown>;
  for (const size of REQUIRED_ICONS) {
    const icon = iconMap[size];
    if (typeof icon !== 'string') fail(`manifest.json is missing the ${size}px icon.`);
    if (!existsSync(path.join(buildDir, icon))) {
      fail(`manifest.json lists a missing ${size}px icon: ${icon}`);
    }
  }

  const permissions = Array.isArray(parsed.permissions) ? parsed.permissions : [];
  const unexpected = permissions.filter(
    (permission): permission is string =>
      typeof permission === 'string' && !KNOWN_PERMISSIONS.has(permission),
  );
  if (unexpected.length > 0) {
    fail(
      `Unexpected permissions in manifest.json: ${unexpected.join(', ')}. ` +
        'Update docs/STORE.md and this allow-list before packaging (store reviews flag permission creep).',
    );
  }
  for (const permission of permissions) {
    if (typeof permission !== 'string') fail('manifest.json permissions must be strings.');
  }

  console.log(
    `✅ manifest.json valid — ${String(parsed.name)} ${parsed.version}, ` +
      `${permissions.join(', ') || 'no API permissions'}`,
  );
  return parsed.version;
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    fail(`Refusing to package an unsafe path: ${relativePath}`);
  }
}

function assertAllowedFile(relativePath: string): void {
  assertSafeRelativePath(relativePath);
  const base = path.posix.basename(relativePath);
  const extension = path.posix.extname(base).toLowerCase();

  if (FORBIDDEN_BASENAMES.has(base)) {
    fail(`Refusing to package ${relativePath}: ${base} must never ship.`);
  }
  if (base === '.env' || base.startsWith('.env.')) {
    fail(`Refusing to package ${relativePath}: dotenv files must never ship.`);
  }
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    fail(
      `Refusing to package ${relativePath}: ${extension} files (source, source map, key, or HAR) must never ship.`,
    );
  }
  if (
    relativePath === '.git' ||
    relativePath.startsWith('.git/') ||
    relativePath === 'node_modules' ||
    relativePath.startsWith('node_modules/') ||
    relativePath.startsWith('tests/') ||
    relativePath.includes('/tests/fixtures/') ||
    relativePath.startsWith('.handoffs/') ||
    relativePath.startsWith('docs/')
  ) {
    fail(`Refusing to package ${relativePath}: development files must never ship.`);
  }
  if (/^secrets?\./i.test(base) || /^credentials?\./i.test(base) || /^cookies?[-_.]/i.test(base)) {
    fail(`Refusing to package ${relativePath}: looks like a credentials file.`);
  }
}

const SECRET_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
];

const SCANNABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.svg']);
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

function assertNoEmbeddedSecrets(entry: FileEntry): void {
  if (entry.data.length > MAX_SCAN_BYTES) return;
  if (!SCANNABLE_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) return;
  const text = entry.data.toString('utf8');
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      fail(`Refusing to package ${entry.name}: it contains a ${label}.`);
    }
  }
}

async function collectFiles(buildDir: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isSymbolicLink()) {
        fail(`Refusing to package symlink: ${relativePath}`);
      }
      const info = await stat(absolutePath);
      if (child.isDirectory()) {
        assertSafeRelativePath(relativePath);
        await walk(absolutePath, relativePath);
        continue;
      }
      assertAllowedFile(relativePath);
      const data = await readFile(absolutePath);
      const entry: FileEntry = { name: relativePath, absolutePath, data, mtime: info.mtime };
      assertNoEmbeddedSecrets(entry);
      entries.push(entry);
    }
  }

  await walk(buildDir, '');
  if (entries.length === 0) fail(`No files found in ${buildDir}.`);
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Minimal ZIP writer (deflate + CRC32)                                       */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { time: dosTime & 0xffff, date: dosDate & 0xffff };
}

function writeZip(entries: readonly FileEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: Unix, ZIP 3.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, 0644
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertInsideProject(options.buildDir, 'Build directory');
  assertInsideProject(options.outDir, 'Output directory');

  if (!existsSync(options.buildDir)) {
    fail(
      `Build not found at ${path.relative(PROJECT_ROOT, options.buildDir)}. ` +
        'Run `npm run build` first (T38 owns the release build); this script never builds.',
    );
  }
  const buildStat = await stat(options.buildDir);
  if (!buildStat.isDirectory()) fail(`Build path is not a directory: ${options.buildDir}`);

  const manifestPath = path.join(options.buildDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail(
      `No manifest.json in ${path.relative(PROJECT_ROOT, options.buildDir)}. ` +
        'That directory is not an unpacked extension build.',
    );
  }

  const packageJson = await readJson(path.join(PROJECT_ROOT, 'package.json'));
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== 'string') {
    fail('package.json is missing "version".');
  }

  const manifest = await readJson(manifestPath);
  const version = validateManifest(manifest, packageVersion, options.buildDir);

  console.log('🔍 Checking build contents…');
  const files = await collectFiles(options.buildDir);

  console.log(`📦 Writing ZIP with ${files.length} files…`);
  const zip = writeZip(files);
  await mkdir(options.outDir, { recursive: true });

  const zipName = `handshook-${version}-chrome.zip`;
  const zipPath = path.join(options.outDir, zipName);
  const checksumPath = `${zipPath}.sha256`;
  const checksum = createHash('sha256').update(zip).digest('hex');

  await writeFile(zipPath, zip);
  await writeFile(checksumPath, `${checksum}  ${zipName}\n`, 'utf8');

  const rawBytes = files.reduce((total, entry) => total + entry.data.length, 0);
  console.log('');
  console.log(`✅ ${zipName}`);
  console.log(`   files:     ${files.length}`);
  console.log(`   raw:       ${(rawBytes / 1024).toFixed(1)} KiB`);
  console.log(`   zip:       ${(zip.length / 1024).toFixed(1)} KiB`);
  console.log(`   sha256:    ${checksum}`);
  console.log(`   zip path:  ${path.relative(PROJECT_ROOT, zipPath)}`);
  console.log(`   checksum:  ${path.relative(PROJECT_ROOT, checksumPath)}`);
  console.log('');
  console.log(`Verify with: (cd "${options.outDir}" && shasum -a 256 -c "${zipName}.sha256")`);
}

await main();
