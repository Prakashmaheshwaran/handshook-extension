/**
 * Console entry point for the Handshook live-DOM capture.
 *
 * This file is concatenated into `scripts/capture-page.js` by
 * `scripts/capture/build-snippet.mjs`. It only reads the page, triggers one
 * detached download, and copies the same JSON to the clipboard.
 *
 * Optional flags: set `window.HANDSHOOK_CAPTURE_OPTIONS = { anonymizeEmployers:
 * true }` before pasting the snippet to replace employer names with
 * `Employer A`, `Employer B`, ...
 */

/* global window, document, location, performance, navigator, Blob, URL, console */

import { collectCapture } from './collect.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestamp(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function downloadJson(json, filename) {
  const blob = new Blob([json], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}

async function copyJson(json) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(json);
      return 'copied';
    }
  } catch {
    /* Clipboard permission can be denied on unfocused tabs; use the fallback. */
  }

  try {
    const area = document.createElement('textarea');
    area.value = json;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied ? 'copied (fallback)' : 'failed';
  } catch {
    return 'failed';
  }
}

function printSummary(capture, filename, clipboardStatus) {
  const redactions = capture.sanitization.redactions;
  const modal =
    capture.dom.dialogCount > 0 ? `${capture.dom.dialogCount} open dialog(s)` : 'no open dialog';
  console.log('');
  console.log('Handshook live capture complete');
  console.log(`  Page type : ${capture.pageType}`);
  console.log(`  URL       : ${capture.url}`);
  console.log(`  File      : ${filename}`);
  console.log(`  Clipboard : ${clipboardStatus}`);
  console.log(
    `  Collected : ${capture.buttons.length} buttons, ${capture.formControls.length} controls, ` +
      `${capture.screeningQuestions.length} questions, ${capture.documents.length} documents`,
  );
  console.log(
    `  Redacted  : ${redactions.emails} email(s), ${redactions.phones} phone(s), ` +
      `${redactions.sensitiveValues} token(s), ${redactions.names} name(s), ${redactions.files} file(s)`,
  );
  console.log(`  Modal     : ${modal}`);
  if (capture.dom.portals.length > 0) {
    console.log(`  Portal    : ${capture.dom.portals.length} dialog(s) outside the app root`);
  }
  if (capture.dom.shadowRoots.length > 0) {
    console.log(`  Shadow DOM: ${capture.dom.shadowRoots.length} open shadow root(s)`);
  }
  if (capture.dom.iframes.length > 0) {
    console.log(`  Iframes   : ${capture.dom.iframes.length} iframe(s)`);
  }
  for (const warning of capture.sanitization.warnings) {
    console.log(`  Warning   : ${warning}`);
  }
  if (clipboardStatus === 'failed') {
    console.log('  Clipboard was unavailable; the downloaded JSON is still complete.');
  }
  console.log('  No clicks, submissions, or navigation were performed.');
  console.log('');
}

async function main() {
  const configured =
    typeof window.HANDSHOOK_CAPTURE_OPTIONS === 'object' && window.HANDSHOOK_CAPTURE_OPTIONS
      ? window.HANDSHOOK_CAPTURE_OPTIONS
      : {};
  const options = {
    anonymizeEmployers: configured.anonymizeEmployers === true,
    maxLength: configured.maxLength,
  };

  const capture = collectCapture(document, location, performance, options);
  const filename = `handshook-capture-${capture.pageType}-${timestamp(new Date())}.json`;
  const json = JSON.stringify(capture, null, 2);

  downloadJson(json, filename);
  const clipboardStatus = await copyJson(json);
  printSummary(capture, filename, clipboardStatus);
}

void main().catch((error) => {
  console.error('[handshook-capture] Capture failed:', error);
});
