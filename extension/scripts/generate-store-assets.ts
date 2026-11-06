/**
 * Generate the store asset pack from local, sanitized sources.
 *
 *   npm run build
 *   node scripts/generate-store-assets.ts
 *
 * Outputs:
 * - src/public/icon-{16,32,48,128}.png            (extension + store icon)
 * - src/public/icon-action-{16,32,48}.png         (toolbar/action icon)
 * - store/screenshot-{dashboard,queue,needs,settings}-1280x800.png
 * - store/promo-440x280.png
 * - store/marquee-1400x560.png
 *
 * The production extension runs in a temporary, headless Chromium profile,
 * seeded with fictional demo records. Every network route is intercepted or
 * blocked, with DNS pinned to localhost as a second barrier.
 */

import { readFile, mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const BUILD_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const STORE_DIR = path.join(ROOT, 'store');
const SOURCE_DIR = path.join(STORE_DIR, 'source');
const PUBLIC_DIR = path.join(ROOT, 'src', 'public');

function fail(message) {
  throw new Error(message);
}

async function readSvg(name) {
  return readFile(path.join(SOURCE_DIR, name), 'utf8');
}

async function ensureBuild() {
  try {
    const info = await stat(path.join(BUILD_DIR, 'sidepanel.html'));
    if (!info.isFile()) fail('sidepanel.html is not a file');
  } catch {
    fail('No production build at .output/chrome-mv3. Run "npm run build" first.');
  }
}

async function renderSvg(context, svg, size, outputPath) {
  const page = await context.newPage();
  // A tiny Chromium viewport can repeat raster bands. Render on a stable
  // surface and capture the SVG's exact bounds instead.
  await page.setViewportSize({ width: 512, height: 512 });
  await page.setContent(
    `<!doctype html><html><head><style>
      html, body { margin: 0; padding: 0; background: transparent; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' },
  );
  const buffer = await page.locator('svg').screenshot({
    omitBackground: true,
  });
  await writeFile(outputPath, buffer);
  await page.close();
}

async function capturePanel(page, extensionId) {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'ui.engine.getState',
      requestId: 'store-init',
      protocolVersion: 1,
    });
    if (!response.ok) throw new Error('Production background did not initialize.');
    const at = Date.now();
    const updated = await chrome.runtime.sendMessage({
      type: 'ui.settings.update',
      requestId: 'store-settings',
      protocolVersion: 1,
      patch: {
        onboardingComplete: true,
        mode: 'autopilot',
        ui: { theme: 'light' },
        documents: { defaultResumeId: 'demo-resume' },
        search: {
          savedSearches: [
            {
              id: 'demo-search',
              name: 'Internships',
              url: 'https://app.joinhandshake.com/job-search',
              enabled: true,
              createdAt: at,
              updatedAt: at,
            },
          ],
        },
      },
    });
    if (!updated.ok) throw new Error('Demo settings were rejected.');
    const titles = ['Data Analyst Intern', 'Software Engineering Intern', 'Product Design Intern'];
    const employers = ['Northwind Analytics', 'Contoso Labs', 'Cedar Studio'];
    const jobs = titles.map((title, index) => ({
      id: `demo-${index + 1}`,
      host: 'app.joinhandshake.com',
      title,
      employer: employers[index],
      url: `https://app.joinhandshake.com/jobs/demo-${index + 1}`,
      description: 'Fictional internship for the store preview.',
      location: 'Remote',
      remote: true,
      employmentType: 'Internship',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume'],
      source: 'search',
      discoveredAt: at,
      fitScore: [0.86, 0.78, 0.74][index],
    }));
    const queue = jobs.map((job, index) => ({
      jobId: job.id,
      status: ['queued', 'queued', 'needs_input'][index],
      priority: 90 - index * 10,
      attempts: index === 1 ? 0 : 1,
      addedAt: at,
      updatedAt: at,
    }));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('handshook');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['jobs', 'queue', 'documents', 'meta'], 'readwrite');
      for (const job of jobs) tx.objectStore('jobs').put(job);
      for (const item of queue) tx.objectStore('queue').put(item);
      tx.objectStore('documents').put({
        id: 'demo-resume',
        type: 'resume',
        title: 'Resume — Product & Data',
        filename: 'demo-resume.pdf',
        updatedAt: at,
      });
      tx.objectStore('meta').put({
        key: 'needs:demo-3',
        value: {
          reason: 'questions',
          questions: [{ id: 'portfolio', label: 'Portfolio URL', type: 'text', required: true }],
          missingDocumentTypes: [],
        },
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await chrome.storage.local.set({
      'handshook.engine.v1': {
        ...response.data,
        status: 'idle',
        mode: 'autopilot',
        currentJobId: undefined,
        currentPhase: undefined,
        message: undefined,
        updatedAt: at,
      },
      'handshook.onboarding.v1': {
        version: 1,
        step: 'done',
        sessionStatus: 'logged_in',
        completedAt: at,
      },
    });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('Applications today').first().waitFor({ timeout: 15_000 });

  const shots = [];
  const take = async (name) => {
    await page.locator('.animate-pulse').waitFor({ state: 'hidden' });
    const invalid = await page.evaluate(() => {
      const main = document.querySelector('main');
      return main && main.scrollWidth > main.clientWidth + 1;
    });
    if (invalid) fail(`${name}: panel has horizontal overflow`);
    if (await page.getByText('Demo', { exact: true }).count()) fail('Demo UI leaked into capture');
    shots.push({ name, png: await page.screenshot(), ...page.viewportSize() });
  };

  await take('dashboard');

  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await page.getByRole('heading', { name: 'Queue', exact: true }).waitFor();
  await page.getByText('Data Analyst Intern').first().waitFor({ timeout: 15_000 });
  await take('queue');

  await page.getByRole('button', { name: /^Needs/ }).click();
  await page.getByRole('heading', { name: 'Needs you', exact: true }).waitFor();
  await page.getByText('Product Design Intern').first().waitFor();
  // Lead with the answer card so its controls are fully visible in the store asset.
  await page.getByText('Product Design Intern', { exact: true }).scrollIntoViewIfNeeded();
  await take('needs');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page
    .getByText(/Run mode and safety/i)
    .first()
    .waitFor();
  // Fit the complete safety section, ending in the gap before Search. This
  // avoids cutting a setting's explanation at the scroll viewport edge.
  await page.setViewportSize({ width: 500, height: 1200 });
  const settingsHeight = await page.evaluate(() =>
    Math.ceil(
      document.querySelector('#safety').getBoundingClientRect().bottom +
        document.querySelector('footer').getBoundingClientRect().height +
        8,
    ),
  );
  await page.setViewportSize({ width: 500, height: settingsHeight });
  await take('settings');

  return shots;
}

const MOCK_SEARCH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job search — Career Center (mock)</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #172033; background: #f5f6f8; }
  .topbar { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 28px; background: #fff; border-bottom: 1px solid #e2e6ec; }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
  .mark { width: 26px; height: 26px; border-radius: 8px; background: #243b53; color: #fff; display: grid; place-items: center; font-size: 12px; }
  .nav { display: flex; gap: 22px; font-size: 13px; color: #5a6577; }
  .nav strong { color: #172033; }
  .account { border: 1px solid #d5dbe4; background: #fff; border-radius: 999px; padding: 6px 13px; font: inherit; font-size: 12px; }
  main { max-width: 860px; margin: 0 auto; padding: 30px 24px 40px; }
  h1 { margin: 0 0 4px; font-size: 27px; letter-spacing: -0.02em; }
  .sub { margin: 0 0 20px; color: #667185; font-size: 13px; }
  .search { display: flex; gap: 8px; margin-bottom: 22px; }
  .search input { flex: 1; padding: 11px 13px; border: 1px solid #d5dbe4; border-radius: 10px; font: inherit; font-size: 13px; background: #fff; color: #172033; }
  .search button { padding: 11px 20px; border: 0; border-radius: 10px; background: #243b53; color: #fff; font: inherit; font-size: 13px; font-weight: 600; }
  .filters { display: flex; gap: 7px; margin-bottom: 18px; }
  .chip { border: 1px solid #d5dbe4; background: #fff; border-radius: 999px; padding: 5px 11px; font-size: 11.5px; color: #4d596b; }
  .chip.on { background: #e9f0f9; border-color: #bcd0e8; color: #1f4f7a; font-weight: 600; }
  .jobs { display: grid; gap: 11px; }
  .job { background: #fff; border: 1px solid #e2e6ec; border-radius: 13px; padding: 16px 18px; display: flex; justify-content: space-between; gap: 18px; }
  .job h2 { margin: 0 0 4px; font-size: 16px; letter-spacing: -0.01em; }
  .employer { margin: 0; font-size: 12.5px; color: #40506b; font-weight: 600; }
  .meta { margin: 7px 0 0; font-size: 12px; color: #71809a; }
  .tags { display: flex; gap: 6px; margin-top: 9px; }
  .tag { font-size: 10.5px; background: #f1f4f8; border-radius: 6px; padding: 2px 7px; color: #526079; }
  .side { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; min-width: 96px; }
  .match { font-size: 11px; font-weight: 700; color: #1c664b; background: #e4f0e9; border-radius: 999px; padding: 4px 9px; }
  .apply { font-size: 12px; font-weight: 600; color: #243b53; border: 1px solid #d5dbe4; border-radius: 8px; padding: 6px 12px; background: #fff; }
  .pager { margin-top: 24px; text-align: right; font-size: 12px; color: #5a6577; }
</style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="mark">CC</span>Career Center</div>
    <nav class="nav"><span>Jobs</span><span>Employers</span><span>Events</span><strong>My applications</strong></nav>
    <button class="account" type="button">Account</button>
  </header>
  <main>
    <h1>Job search</h1>
    <p class="sub">Internships and early-career roles matched to your profile.</p>
    <div class="search"><input value="software intern" aria-label="Keywords"><button type="button">Search</button></div>
    <div class="filters"><span class="chip on">Internship</span><span class="chip">Remote</span><span class="chip">Full-time</span><span class="chip">Posted this week</span></div>
    <div class="jobs">
      <article class="job"><div><h2>Software Engineering Intern</h2><p class="employer">Northwind Labs</p><p class="meta">Remote · Internship · $32/hour</p><div class="tags"><span class="tag">Python</span><span class="tag">Platform</span><span class="tag">Summer 2027</span></div></div><div class="side"><span class="match">91% match</span><span class="apply">Quick Apply</span></div></article>
      <article class="job"><div><h2>Data Analyst Intern</h2><p class="employer">Contoso Analytics</p><p class="meta">New York, NY · Internship · $28/hour</p><div class="tags"><span class="tag">SQL</span><span class="tag">Dashboards</span></div></div><div class="side"><span class="match">78% match</span><span class="apply">Apply</span></div></article>
      <article class="job"><div><h2>Backend Developer Co-op</h2><p class="employer">Initech Systems</p><p class="meta">Austin, TX · Co-op · $30/hour</p><div class="tags"><span class="tag">Go</span><span class="tag">APIs</span></div></div><div class="side"><span class="match">86% match</span><span class="apply">Apply</span></div></article>
    </div>
    <p class="pager">1–3 of 42 results</p>
  </main>
</body>
</html>`;

async function captureMockSearch(context) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto('https://app.joinhandshake.com/job-search', { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'Job search' }).waitFor();
  await page.waitForTimeout(250);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1000, height: 760 } });
  await page.close();
  return png;
}

function dataUrl(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}

const CAPTIONS = {
  dashboard: {
    title: 'Click Start. Handshook applies for you.',
    sub: 'Autopilot fills and submits Handshake applications, then checks for the confirmation.',
  },
  queue: {
    title: 'Every job in one queue.',
    sub: 'Matched to your saved search, ranked by fit, deduplicated locally.',
  },
  needs: {
    title: 'Missing answers wait for you.',
    sub: 'A required question with no saved answer goes to Needs you instead of being guessed.',
  },
  settings: {
    title: 'Every switch stays yours.',
    sub: 'Review before submit, Dry run, sensitive answers and AI can each be turned on or off.',
  },
};

function compositionHtml({ panelPng, panelWidth, panelHeight, searchPng, caption, captionSub }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background:
      radial-gradient(900px 520px at 18% 8%, #ffffff 0%, rgba(255,255,255,0) 68%),
      radial-gradient(760px 600px at 92% 96%, #dfece5 0%, rgba(223,236,229,0) 62%),
      #f1efe8;
    color: #14231c;
    position: relative;
  }
  .grain { position: absolute; inset: 0; opacity: .35;
    background-image: radial-gradient(#b9c8bf 0.6px, transparent 0.6px); background-size: 22px 22px; }
  .caption { position: absolute; left: 54px; top: 34px; width: 710px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase; color: #1c664b; }
  .eyebrow .dot { width: 7px; height: 7px; border-radius: 999px; background: #1c664b; }
  h1 { margin: 9px 0 5px; font-size: 30px; line-height: 1.12; letter-spacing: -0.028em; font-weight: 700; }
  .caption p { margin: 0; color: #55635b; font-size: 14px; line-height: 1.45; }
  .browser { position: absolute; left: 54px; top: 132px; width: 748px; height: 628px;
    border-radius: 18px; background: #fff; overflow: hidden;
    box-shadow: 0 2px 3px rgba(20,35,28,.06), 0 30px 60px -28px rgba(20,35,28,.42);
    border: 1px solid rgba(20,35,28,.12); }
  .chrome { height: 42px; display: flex; align-items: center; gap: 7px; padding: 0 15px;
    background: #f7f7f4; border-bottom: 1px solid #e4e2da; }
  .lights { display: flex; gap: 6px; }
  .light { width: 9px; height: 9px; border-radius: 999px; background: #d5d3ca; }
  .light:nth-child(1) { background: #e8b3a8; } .light:nth-child(2) { background: #e8d3a0; } .light:nth-child(3) { background: #b6d6bf; }
  .url { flex: 1; margin-left: 8px; height: 24px; border-radius: 7px; background: #fff;
    border: 1px solid #e4e2da; display: flex; align-items: center; padding: 0 10px;
    font-size: 10.5px; color: #6c7770; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .url b { color: #3f4c44; font-weight: 600; }
  .shot { width: 100%; height: calc(100% - 42px); object-fit: cover; object-position: top center; display: block; }
  .veil { position: absolute; left: 54px; top: 132px; width: 748px; height: 628px; border-radius: 18px;
    background: linear-gradient(120deg, rgba(20,35,28,.06), rgba(20,35,28,.16)); pointer-events: none; }
  .panel { position: absolute; right: 52px; top: 24px; width: ${Math.round((752 * panelWidth) / panelHeight)}px; height: 752px;
    border-radius: 22px; overflow: hidden; background: #fff;
    border: 1px solid rgba(20,35,28,.14);
    box-shadow: 0 2px 4px rgba(20,35,28,.08), 0 44px 80px -34px rgba(20,35,28,.55); }
  .panel img { width: 100%; height: 100%; object-fit: contain; object-position: top center; display: block; }
  .caption { z-index: 2; }
</style></head>
<body>
  <div class="grain"></div>
  <div class="caption">
    <span class="eyebrow"><span class="dot"></span>Handshook · Autopilot</span>
    <h1>${caption}</h1>
    <p>${captionSub}</p>
  </div>
  <div class="browser">
    <div class="chrome">
      <span class="lights"><span class="light"></span><span class="light"></span><span class="light"></span></span>
      <span class="url"><b>app.joinhandshake.com</b>/job-search</span>
    </div>
    <img class="shot" src="${dataUrl(searchPng)}" alt="">
  </div>
  <div class="veil"></div>
  <div class="panel"><img src="${dataUrl(panelPng)}" alt="Handshook side panel"></div>
</body></html>`;
}

async function renderComposition(page, html, width, height, outputPath) {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(120);
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  await writeFile(outputPath, buffer);
}

function promoHtml(iconDataUrl) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 440px; height: 280px; overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { background:
      radial-gradient(360px 220px at 82% 20%, rgba(143,212,179,.35), rgba(143,212,179,0) 70%),
      radial-gradient(420px 300px at 8% 100%, rgba(28,102,75,.9), rgba(28,102,75,0) 70%),
      #123e2e; color: #fff; position: relative; }
  .dots { position: absolute; inset: 0; opacity: .16;
    background-image: radial-gradient(#cfe6da 0.7px, transparent 0.7px); background-size: 18px 18px; }
  .content { position: absolute; inset: 0; padding: 36px 34px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .icon { width: 82px; height: 82px; border-radius: 20px; box-shadow: 0 16px 34px -14px rgba(0,0,0,.6); }
  h1 { margin: 0; font-size: 38px; line-height: 1; letter-spacing: -0.035em; font-weight: 700; }
  .tag { margin: 7px 0 0; font-size: 14.5px; color: #cfe6da; letter-spacing: -0.005em; }
  .row { display: flex; gap: 8px; }
  .pill { font-size: 11px; font-weight: 600; color: #eaf6ef; border: 1px solid rgba(207,230,218,.32);
    background: rgba(255,255,255,.07); border-radius: 999px; padding: 5px 10px; }
  .fine { font-size: 9.5px; color: rgba(207,230,218,.65); }
</style></head>
<body>
  <div class="dots"></div>
  <div class="content">
    <div class="brand">
      <img class="icon" src="${iconDataUrl}" alt="">
      <div><h1>Handshook</h1><p class="tag">Automated Handshake applications</p></div>
    </div>
    <div>
      <div class="row"><span class="pill">Autopilot by default</span><span class="pill">Local-first</span><span class="pill">No telemetry</span></div>
      <p class="fine" style="margin-top:9px">Not affiliated with Handshake.</p>
    </div>
  </div>
</body></html>`;
}

function marqueeHtml(iconDataUrl, panelPng) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1400px; height: 560px; overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { background:
      radial-gradient(900px 620px at 76% 12%, rgba(143,212,179,.28), rgba(143,212,179,0) 68%),
      radial-gradient(1000px 700px at 0% 100%, rgba(28,102,75,.86), rgba(28,102,75,0) 62%),
      #123e2e; color: #fff; position: relative; }
  .dots { position: absolute; inset: 0; opacity: .14;
    background-image: radial-gradient(#cfe6da 0.8px, transparent 0.8px); background-size: 22px 22px; }
  .copy { position: absolute; left: 74px; top: 66px; width: 720px; }
  .brand { display: flex; align-items: center; gap: 22px; }
  .icon { width: 104px; height: 104px; border-radius: 26px; box-shadow: 0 22px 44px -18px rgba(0,0,0,.65); }
  h1 { margin: 0; font-size: 60px; line-height: .95; letter-spacing: -0.04em; font-weight: 700; }
  .tag { margin: 8px 0 0; font-size: 19px; color: #cfe6da; }
  h2 { margin: 42px 0 14px; font-size: 31px; line-height: 1.15; letter-spacing: -0.028em; font-weight: 650; }
  .points { display: grid; gap: 11px; }
  .point { display: flex; align-items: center; gap: 11px; font-size: 15.5px; color: #dceee4; }
  .check { width: 21px; height: 21px; border-radius: 999px; background: #8fd4b3; color: #0c1f16;
    display: grid; place-items: center; font-size: 12px; font-weight: 900; flex: none; }
  .fine { position: absolute; left: 74px; bottom: 40px; font-size: 11.5px; color: rgba(207,230,218,.6); }
  .panel { position: absolute; right: 115px; top: 34px; width: 258px; height: 492px; border-radius: 20px;
    overflow: hidden; transform: rotate(2.2deg); background: #fff; border: 1px solid rgba(255,255,255,.25);
    box-shadow: 0 3px 6px rgba(0,0,0,.16), 0 44px 70px -22px rgba(0,0,0,.62); }
  .panel img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
</style></head>
<body>
  <div class="dots"></div>
  <div class="copy">
    <div class="brand"><img class="icon" src="${iconDataUrl}" alt=""><div><h1>Handshook</h1><p class="tag">Automated Handshake applications</p></div></div>
    <h2>Apply on Handshake automatically.<br>Stay in control.</h2>
    <div class="points">
      <div class="point"><span class="check">✓</span>Fills and submits applications for you</div>
      <div class="point"><span class="check">✓</span>Uses the session already in your browser</div>
      <div class="point"><span class="check">✓</span>Local-first data. No developer telemetry</div>
      <div class="point"><span class="check">✓</span>Daily cap, pacing, and a Stop button</div>
    </div>
  </div>
  <div class="panel"><img src="${dataUrl(panelPng)}" alt="Handshook side panel"></div>
  <p class="fine">Not affiliated with Handshake. Works with Handshake in Chrome.</p>
</body></html>`;
}

async function main() {
  await ensureBuild();
  await mkdir(STORE_DIR, { recursive: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  const iconSvg = await readSvg('icon.svg');
  const actionSvg = await readSvg('icon-action.svg');

  const profile = await mkdtemp(path.join(tmpdir(), 'handshook-store-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${BUILD_DIR}`,
      `--load-extension=${BUILD_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
    ],
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.href === 'https://app.joinhandshake.com/job-search') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_SEARCH_HTML });
    }
    return route.abort();
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).hostname;
    for (const size of [16, 32, 48, 128]) {
      await renderSvg(context, iconSvg, size, path.join(PUBLIC_DIR, `icon-${size}.png`));
    }
    for (const size of [16, 32, 48]) {
      await renderSvg(context, actionSvg, size, path.join(PUBLIC_DIR, `icon-action-${size}.png`));
    }
    await writeFile(
      path.join(STORE_DIR, 'icon-128.png'),
      await readFile(path.join(PUBLIC_DIR, 'icon-128.png')),
    );

    const panelPage = await context.newPage();
    const panels = await capturePanel(panelPage, extensionId);
    const searchPng = await captureMockSearch(context);
    // Compositions render in a normal document, outside extension CSP.
    const compositionPage = await context.newPage();

    for (const shot of panels) {
      const caption = CAPTIONS[shot.name];
      await renderComposition(
        compositionPage,
        compositionHtml({
          panelPng: shot.png,
          panelWidth: shot.width,
          panelHeight: shot.height,
          searchPng,
          caption: caption.title,
          captionSub: caption.sub,
        }),
        1280,
        800,
        path.join(STORE_DIR, `screenshot-${shot.name}-1280x800.png`),
      );
    }

    const iconDataUrl = dataUrl(await readFile(path.join(PUBLIC_DIR, 'icon-128.png')));
    const dashboard = panels.find((shot) => shot.name === 'dashboard');
    if (!dashboard) fail('Dashboard screenshot was not captured.');

    await renderComposition(
      compositionPage,
      promoHtml(iconDataUrl),
      440,
      280,
      path.join(STORE_DIR, 'promo-440x280.png'),
    );
    await renderComposition(
      compositionPage,
      marqueeHtml(iconDataUrl, dashboard.png),
      1400,
      560,
      path.join(STORE_DIR, 'marquee-1400x560.png'),
    );

    console.log('Generated icons in src/public:');
    console.log('  icon-16/32/48/128.png, icon-action-16/32/48.png');
    console.log('Generated store assets in store/:');
    for (const shot of panels) console.log(`  screenshot-${shot.name}-1280x800.png`);
    console.log('  promo-440x280.png');
    console.log('  marquee-1400x560.png');
    console.log('  icon-128.png');
    if (errors.length) fail(`Page errors during capture: ${errors.join('; ')}`);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

await main();
