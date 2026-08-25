/**
 * End-to-end verification: loads the built extension (dist/) into real Chromium
 * via Playwright, then exercises the actual pipeline through the background
 * service worker: detect -> fill -> DOM verification, plus the side panel UI.
 * Run: npm run build && npm run e2e
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
const PORT = 8899;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

/* ---- static server for dist/ ---- */
const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/test/form-a.html' : req.url.split('?')[0];
  try {
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

/* ---- launch Chromium with the extension (persistent context is required for extensions) ---- */
// Branded headless Chrome ignores --load-extension; headed Chromium-family honors it.
// NOTE: Chrome 137+ STABLE ignores --load-extension entirely (anti-malware policy) —
// the sanctioned "real Chrome" for automation is Chrome for Testing (same engine).
// AF_BROWSER=chrome → Chrome for Testing; default: Brave, then Chromium.
function findChrome() {
  const direct = process.env.AF_BROWSER === 'chrome'
    ? ['/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
    : [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
  for (const p of direct) if (existsSync(p)) return p;
  // Fallback: Playwright cache — newest chromium-* dir with Chrome for Testing
  // inside (same engine as stable Chrome; honors --load-extension).
  const cacheRoot = `${process.env.HOME}/Library/Caches/ms-playwright`;
  try {
    const dirs = readdirSync(cacheRoot)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const bin = `${cacheRoot}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
      if (existsSync(bin)) return bin;
    }
  } catch { /* no cache */ }
  return undefined;
}
const executablePath = findChrome();
if (!executablePath) {
  console.error('No Chromium-based browser found for e2e.');
  process.exit(1);
}
const context = await chromium.launchPersistentContext('', {
  executablePath,
  headless: false, // extensions require headed mode in Playwright
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
  ],
});

// Wait for the MV3 service worker to register.
let swWorker = null;
try {
  swWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
} catch {
  const existing = context.serviceWorkers().find((w) => w.url().includes('background.js'));
  swWorker = existing ?? null;
}
if (!swWorker || !swWorker.url().includes('background.js')) {
  const found = context.serviceWorkers().find((w) => w.url().includes('background.js'));
  swWorker = found ?? null;
}
check(`background service worker started (${executablePath})`, Boolean(swWorker));

const extId = swWorker ? new URL(swWorker.url()).host : '';

/** Evaluate a function in the background service worker. */
const swEval = (fn, ...args) => swWorker.evaluate(fn, ...args);

/* ---- open the test page and detect through the real messaging pipeline ---- */
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/test/form-a.html`, { waitUntil: 'load' });

async function detect(url) {
  return swEval(async (u) => {
    for (let i = 0; i < 40; i++) {
      const [tab] = await chrome.tabs.query({ url: u });
      if (tab) {
        try {
          return { tabId: tab.id, res: await chrome.tabs.sendMessage(tab.id, { type: 'AF_DETECT' }) };
        } catch {
          /* content script not ready yet */
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { tabId: null, res: null };
  }, url);
}

const { res: detected, tabId: formATabId } = await detect(`http://localhost:${PORT}/test/form-a.html`);
check('content script responds to AF_DETECT', Boolean(detected));
const fields = detected?.fields ?? [];
check('detects a rich set of fields', fields.length >= 17, `${fields.length} fields`);

const byLabel = (needle) => fields.find((f) => f.label.toLowerCase().includes(needle.toLowerCase()));
check('email field found', Boolean(byLabel('Email')));
check('radio group found with options', fields.some((f) => f.type === 'radio' && f.options.length === 2));
check('select options captured', fields.some((f) => f.type === 'select' && f.options.includes('B.Tech')));
check('checkbox group captured', fields.some((f) => f.type === 'checkbox-group' && f.options.length === 3));
check('password field present (for safety check)', fields.some((f) => f.type === 'password'));

/* ---- seed profile via chrome.storage (the same store the UI writes) ---- */
await swEval(async () => {
  const profile = {
    personal: { firstName: 'Testy', lastName: 'McTest', fullName: '', preferredName: '' },
    contact: { email: 'testy@example.com', phone: '+91 90000 00000', linkedin: 'linkedin.com/in/testy', github: '', website: '' },
    education: [{ institution: 'IIT', degree: 'B.Tech', field: 'CS', startYear: '2016', endYear: '2020' }],
    experience: [{ company: 'Acme', title: 'Engineer', startDate: '2020-07', endDate: 'Present', description: '', technologies: '' }],
    skills: ['Python', 'TypeScript'],
    preferences: { relocate: 'Yes', workMode: 'Remote', locations: '' },
    standardAnswers: [{ question: 'Why are you interested in this role?', answer: 'I love building tools.' }],
  };
  await chrome.storage.local.set({ profile });
});
check('profile persisted to chrome.storage', true);

const stored = await swEval(async () => {
  const { profile } = await chrome.storage.local.get('profile');
  return profile;
});
check('profile reads back correctly', stored?.personal?.firstName === 'Testy');

/* ---- dynamic field appears at 2s — fresh detect must see it with stable ids ---- */
await new Promise((r) => setTimeout(r, 2500));
const redetect = await detect(`http://localhost:${PORT}/test/form-a.html`);
const dynField = redetect.res?.fields.find((f) => /notice period/i.test(f.label));
check('dynamically inserted field found on re-analyze', Boolean(dynField), `now ${redetect.res.fields.length} fields`);
check('existing ids stayed stable after DOM mutation', redetect.res.fields.find((f) => f.label === 'First Name')?.id === fields.find((f) => f.label === 'First Name')?.id);

/* ---- fill a batch of fields through the real pipeline ---- */
const pick = (pred) => fields.find(pred);
const fillValues = [];
const add = (f, v) => f && fillValues.push({ fieldId: f.id, value: v });
add(pick((f) => f.label === 'First Name'), 'Testy');
add(byLabel('Email'), 'testy@example.com');
add(byLabel('Mobile'), '+91 90000 00000');
add(fields.find((f) => f.type === 'select'), 'B.Tech');
add(fields.find((f) => f.type === 'radio' && f.options.includes('Yes')), 'Yes');
add(fields.find((f) => f.type === 'checkbox-group'), 'Python, TypeScript');
add(byLabel('years of professional experience'), '5');
add(byLabel('interested in this role'), 'I love building tools.');
add(byLabel('Expected Salary'), ''); // blank → must be skipped

const fillRes = await swEval(async ({ tabId, values }) => {
  return chrome.tabs.sendMessage(tabId, { type: 'AF_FILL', values });
}, { tabId: formATabId, values: fillValues });
check('fill round-trips through messaging', fillRes.results.length === fillValues.length);

/* ---- read the real DOM state back via scripting.executeScript ---- */
const domState = await swEval(async (tabId) => {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      firstName: document.getElementById('first_name')?.value,
      email: document.getElementById('email')?.value,
      phone: document.getElementById('phone')?.value,
      edu: document.getElementById('edu')?.value,
      relocate: document.querySelector('input[name=relocate]:checked')?.value,
      tech: [...document.querySelectorAll('input[name=tech]:checked')].map((b) => b.value),
      yoe: document.getElementById('yoe')?.value,
      why: document.getElementById('why')?.value,
      salary: document.getElementById('salary')?.value,
      password: document.getElementById('pass')?.value,
      pan: document.getElementById('pan')?.value,
    }),
  });
  return res.result;
}, formATabId);

if (process.env.AF_DEBUG) console.log('  [debug] domState:', JSON.stringify(domState));

check('first name filled', domState.firstName === 'Testy');
check('email filled', domState.email === 'testy@example.com');
check('phone filled', domState.phone === '+91 90000 00000');
// Text-only scope: select/radio/checkbox fills are refused as 'manual'.
check('select NOT filled (manual scope)', domState.edu !== 'B.Tech');
check('radio NOT filled (manual scope)', domState.relocate === undefined);
check('checkbox group NOT filled (manual scope)', domState.tech.join(',') === '');
check('textarea filled', domState.why === 'I love building tools.');
check('blank value not filled', domState.salary === '');
check('password never touched', domState.password === '');
check('government ID never touched', domState.pan === '');

/* ---- side panel page renders as an extension page ---- */
const uiPage = await context.newPage();
await uiPage.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
const title = await uiPage.$eval('.header-title', (el) => el.textContent).catch(() => null);
check('side panel React app renders', title === 'AI Form Assistant');
const tabsCount = await uiPage.$$eval('.tabs button', (els) => els.length);
check('side panel tabs render', tabsCount === 3);

/* ---- profile editor saves through the real UI ---- */
await uiPage.evaluate(() => {
  const btns = [...document.querySelectorAll('.tabs button')];
  (btns.find((b) => b.textContent === 'Profile') ?? btns[1]).click();
});
await uiPage.waitForSelector('.profile input');
const inputs = await uiPage.$$('.profile input');
// React-controlled input: set through the native setter so onChange fires.
await inputs[0].evaluate((el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'UiTesty');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await uiPage.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save profile').click());
await page.waitForTimeout(500);
const savedName = await swEval(async () => {
  const { profile } = await chrome.storage.local.get('profile');
  return profile?.personal?.firstName;
});
check('profile editor persists edits from the UI', savedName === 'UiTesty', String(savedName));

/* ---- form B: ARIA / table layout ---- */
await page.goto(`http://localhost:${PORT}/test/form-b.html`, { waitUntil: 'load' });
const b = await detect(`http://localhost:${PORT}/test/form-b.html`).then((r) => r.res);
check('form B detected', b.fields.length >= 7, `${b.fields.length} fields`);
check('form B resolves table-header labels', b.fields.some((f) => /given name/i.test(f.label)));
check(
  'form B resolves aria-labelledby + describedby',
  b.fields.some((f) => f.label === 'Professional background' && /professional experience/i.test(f.context)),
);
check('form B resolves aria-label', b.fields.some((f) => /preferred locations/i.test(f.label)));

/* ---- form C: shadow DOM (Workday-style widgets) ---- */
await page.goto(`http://localhost:${PORT}/test/form-shadow.html`, { waitUntil: 'load' });
const sh = await detect(`http://localhost:${PORT}/test/form-shadow.html`).then((r) => r.res);
const shadowFields = sh?.fields ?? [];
check('shadow DOM fields detected', shadowFields.length >= 3, `${shadowFields.length} fields`);
check('nested shadow roots pierced (select inside widget-in-widget)',
  shadowFields.some((f) => f.type === 'select' && f.options.includes('B.Tech')));
const shName = shadowFields.find((f) => f.label === 'First Name');
check('shadow field found for fill', Boolean(shName));
// Fill via a frame-scoped sendMessage (the shadow page is the current page).
await swEval(async ({ url, id }) => {
  const [tab] = await chrome.tabs.query({ url });
  await chrome.tabs.sendMessage(tab.id, { type: 'AF_FILL', values: [{ fieldId: id, value: 'Shadowy' }] }, { frameId: 0 });
}, { url: `http://localhost:${PORT}/test/form-shadow.html`, id: shName?.id });
const shadowVal = await page.evaluate(() => document.querySelector('workday-style-form')?.shadowRoot?.querySelector('#s-name')?.value);
check('shadow DOM input filled', shadowVal === 'Shadowy', String(shadowVal));

/* ---- form D: iframe-embedded application with colliding labels ---- */
await page.goto(`http://localhost:${PORT}/test/form-iframe.html`, { waitUntil: 'load' });
await page.waitForTimeout(500); // let the child frame's content script register

// Enumerate real Chrome frameIds the way api.ts does — via an allFrames injection.
const iframeTab = await swEval(async (url) => {
  const [tab] = await chrome.tabs.query({ url });
  return tab.id;
}, `http://localhost:${PORT}/test/form-iframe.html`);
const realFrameIds = await swEval(async (tabId) => {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => 'af-probe',
  });
  return injections.map((r) => r.frameId);
}, iframeTab);
check('both frames enumerated', realFrameIds.length === 2, JSON.stringify(realFrameIds));

// Detect per-frame and namespace ids exactly like sidepanel/api.ts.
const perFrame = await swEval(async ({ tabId, frameIds }) => {
  const out = [];
  for (const frameId of frameIds) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'AF_DETECT' }, { frameId });
      out.push({ frameId, fields: res.fields });
    } catch {
      out.push({ frameId, fields: [] });
    }
  }
  return out;
}, { tabId: iframeTab, frameIds: realFrameIds });
const allIframeFields = perFrame.flatMap((fr) => fr.fields.map((f) => ({ ...f, id: `g${fr.frameId}:${f.id}` })));
check('iframe child fields detected', allIframeFields.filter((f) => f.label === 'Email').length === 1);
const firstNames = allIframeFields.filter((f) => f.label === 'First Name');
check('colliding labels got distinct namespaced ids', firstNames.length === 2 && firstNames[0].id !== firstNames[1].id,
      firstNames.map((f) => f.id).join(' vs '));

// Fill BOTH First Name fields to different values through the namespaced pipeline.
for (const [i, f] of firstNames.entries()) {
  const frameId = Number(f.id.match(/^g(\d+):/)[1]);
  const fid = f.id.slice(f.id.indexOf(':') + 1); // strip per-frame namespace
  const fr = await swEval(async ({ tabId, frameId, fid, v }) => {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'AF_FILL', values: [{ fieldId: fid, value: v }] }, { frameId });
    } catch (e) {
      return { error: e.message };
    }
  }, { tabId: iframeTab, frameId, fid, v: i === 0 ? 'TopFrame' : 'ChildFrame' });
}
await page.waitForTimeout(300);
const topVal = await page.evaluate(() => document.getElementById('t-first')?.value);
const childVal = await page.frames().find((f) => f.url().includes('form-embed'))?.inputValue('#e-first');
check('top-frame field routed correctly', topVal === 'TopFrame', String(topVal));
check('iframe field routed correctly (no cross-wire)', childVal === 'ChildFrame', String(childVal));

/* ---- form E: file inputs are never touched (user attaches manually) ---- */
await page.goto(`http://localhost:${PORT}/test/form-upload.html`, { waitUntil: 'load' });
const up = await detect(`http://localhost:${PORT}/test/form-upload.html`).then((r) => r.res);
const cvField = up.fields.find((f) => f.type === 'file' && /resume/i.test(f.label));
const ppField = up.fields.find((f) => f.type === 'file' && /passport/i.test(f.label));
check('both file inputs detected', Boolean(cvField && ppField), `${up.fields.length} fields total`);
await swEval(async ({ url, cvId, ppId }) => {
  const [tab] = await chrome.tabs.query({ url });
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'AF_FILL', values: [
    { fieldId: cvId, value: 'test-resume.pdf' }, { fieldId: ppId, value: 'test-resume.pdf' },
  ] });
  return r.results;
}, { url: `http://localhost:${PORT}/test/form-upload.html`, cvId: cvField?.id, ppId: ppField?.id })
  .then((results) => check('file fields reported as manual',
    results.every((x) => x.status === 'manual'), JSON.stringify(results)));
const uploadState = await swEval(async (tabId) => {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      cv: document.getElementById('cv')?.files?.length ?? 0,
      pp: document.getElementById('pp')?.files?.length ?? 0,
    }),
  });
  return res.result;
}, await swEval(async (url) => (await chrome.tabs.query({ url }))[0].id, `http://localhost:${PORT}/test/form-upload.html`));
check('resume upload field untouched', uploadState.cv === 0);
check('passport upload field untouched', uploadState.pp === 0);

/* ---- form F: text-only scope — selects/radios/checkboxes report manual ----
 * The extension's contract is now: fill TEXT fields, leave controls to the
 * user. Verify select/radio/checkbox fills are refused as 'manual'. */
await page.goto(`http://localhost:${PORT}/test/form-a.html`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2500)); // let the dynamic field insert settle
const fa = await detect(`http://localhost:${PORT}/test/form-a.html`).then((r) => r.res);
const selField = fa.fields.find((f) => f.type === 'select');
const radioField = fa.fields.find((f) => f.type === 'radio');
const checkField = fa.fields.find((f) => f.type === 'checkbox-group');
check('control fields detected', Boolean(selField && radioField && checkField));
{
  const tabId = await swEval(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `http://localhost:${PORT}/test/form-a.html`);
  const res = await swEval(async ({ tabId, ids }) => {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'AF_FILL', values: [
      { fieldId: ids.sel, value: 'B.Tech' }, { fieldId: ids.radio, value: 'Yes' }, { fieldId: ids.check, value: 'Python' },
    ] });
    return Object.fromEntries(r.results.map((x) => [x.fieldId, x.status]));
  }, { tabId, ids: { sel: selField.id, radio: radioField.id, check: checkField.id } });
  check('select reported manual', res[selField.id] === 'manual', String(res[selField.id]));
  check('radio reported manual', res[radioField.id] === 'manual', String(res[radioField.id]));
  check('checkbox-group reported manual', res[checkField.id] === 'manual', String(res[checkField.id]));
}

/* ---- form F (known limitation): frameworks that only accept TRUSTED input ----
 * CDP trusted-input retyping was REMOVED by user decision (didn't hold up on a
 * real portal). On such pages the DOM fills but the framework state stays
 * empty — if submit complains about required fields, delete-and-retype one
 * character per field. This check documents the behavior honestly. */
await page.goto(`http://localhost:${PORT}/test/form-react.html`, { waitUntil: 'load' });
const rf = await detect(`http://localhost:${PORT}/test/form-react.html`).then((r) => r.res);
const rFirst = rf.fields.find((f) => f.label === 'First Name');
const rEmail = rf.fields.find((f) => /email/i.test(f.label));
const rNotes = rf.fields.find((f) => f.type === 'textarea');
check('trusted-only form detected', Boolean(rFirst && rEmail && rNotes), `${rf.fields.length} fields`);
{
  const tabId = await swEval(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `http://localhost:${PORT}/test/form-react.html`);
  const res = await swEval(async ({ tabId, values }) => {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'AF_FILL', values });
    return Object.fromEntries(r.results.map((x) => [x.fieldId, x.status]));
  }, { tabId, values: [
    { fieldId: rFirst.id, value: 'Testy' },
    { fieldId: rEmail.id, value: 'testy@example.com' },
    { fieldId: rNotes.id, value: 'I love building tools.' },
  ] });
  check('text fields still fill on trusted-only pages (DOM-level)',
    res[rFirst.id] === 'filled' && res[rEmail.id] === 'filled' && res[rNotes.id] === 'filled',
    JSON.stringify(res));
}
const fwState = await page.evaluate(() => window.__getFrameworkState());
check('documented limitation: trusted-only framework state is empty', fwState.firstName === '' && fwState.email === '' && fwState.notes === '', JSON.stringify(fwState));



await context.close();
server.close();
console.log(failures === 0 ? '\nAll E2E checks passed.' : `\n${failures} E2E checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
