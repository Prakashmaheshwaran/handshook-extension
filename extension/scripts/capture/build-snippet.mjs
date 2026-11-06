/**
 * Build the self-contained DevTools snippet and bookmarklet from the source
 * modules in this folder.
 *
 * Run from anywhere:
 *   node scripts/capture/build-snippet.mjs
 *
 * The generated files are committed so users never need a build step.
 */

/* global console */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = resolve(HERE, '../..');
const SOURCES = ['sanitize.js', 'collect.js', 'run.js'];

function stripModule(source) {
  return source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^import\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+function|function|const|let|var|class)\b)/gm, '')
    .replace(/^[ \t]*\/\* global .*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function buildSource() {
  const body = SOURCES.map((name) =>
    stripModule(readFileSync(resolve(HERE, name), 'utf8')).trim(),
  ).join('\n\n');

  return `/*
 * Handshook live-DOM capture snippet (generated).
 *
 * Paste this entire file into the DevTools Console on a logged-in Handshake
 * page. It reads the page, downloads sanitized JSON, and copies the same JSON
 * to the clipboard. It never clicks, submits, or navigates.
 *
 * Source: scripts/capture/*.js — rebuild with
 *   node scripts/capture/build-snippet.mjs
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
/* global window, document, location, performance, navigator, Blob, URL, URLSearchParams, console */

(function () {
  'use strict';

${body}
})();
`;
}

function buildBookmarklet(source) {
  const compact = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (/\b(?:import|export)\s/.test(compact)) {
    throw new Error('Bookmarklet still contains module syntax');
  }
  return `javascript:${encodeURIComponent(compact)}`;
}

async function main() {
  const config = JSON.parse(readFileSync(resolve(EXTENSION_ROOT, '.prettierrc'), 'utf8'));
  const source = buildSource();
  const formatted = await prettier.format(source, { ...config, parser: 'babel' });
  const bookmarklet = buildBookmarklet(formatted);

  writeFileSync(resolve(EXTENSION_ROOT, 'scripts/capture-page.js'), formatted, 'utf8');
  writeFileSync(
    resolve(EXTENSION_ROOT, 'scripts/capture-page.bookmarklet.txt'),
    `${bookmarklet}\n`,
    'utf8',
  );

  console.log(`Wrote scripts/capture-page.js (${formatted.length} chars)`);
  console.log(`Wrote scripts/capture-page.bookmarklet.txt (${bookmarklet.length} chars)`);
}

await main();
