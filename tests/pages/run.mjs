#!/usr/bin/env node
// Renders every HTML page in jsdom against fixture data and asserts on the
// output. This is the closest we get to a browser without one: it catches
// broken imports, runtime exceptions, missing element ids, unescaped HTML and
// the classification rules (overdue / due today / due this week ...).
//
//   npm run test:pages        (needs `npm install --no-save jsdom`)

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, register } from 'node:module';
import { createFakeSupabase } from './fake-supabase.js';

// Deterministic clock: the fleet runs on Mountain time.
process.env.TZ = 'America/Denver';
register('./loader-hooks.mjs', import.meta.url);
import * as fx from './fixtures.js';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error('jsdom is not installed. Run: npm install --no-save jsdom');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
let failed = 0;
let runCounter = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

// Loads <file>.html in jsdom, injects the fake supabase global and imports the
// page's module script. Resolves once the module has finished its first render.
async function loadPage(file, { query = '', fake = createFakeSupabase(), chart = false, now = fx.today } = {}) {
  const html = readFileSync(resolve(root, file), 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    url: `http://localhost/${file}${query}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  // Modules call the bare `console`, which is Node's — capture it too.
  const savedConsoleError = console.error;
  const savedConsoleWarn = console.warn;
  console.error = window.console.error = (...args) => errors.push(args.map((a) => a?.message || String(a)).join(' '));
  console.warn = window.console.warn = () => {};
  window.supabase = fake;
  if (chart) {
    // Chart.js needs a real canvas; record the configs instead so we can assert on them.
    window.Chart = class FakeChart {
      constructor(canvas, config) { this.canvas = canvas; this.config = config; FakeChart.instances.push(this); }
      destroy() { this.destroyed = true; }
      static instances = [];
      static defaults = { font: {}, plugins: { legend: { labels: {} } } };
    };
  }
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLAnchorElement.prototype.click = function click() { window.__downloaded = this.download; };
  // Freeze "now" so date buckets are deterministic.
  const RealDate = window.Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  window.Date = FrozenDate;

  // Expose a Node-side global environment matching the window for the modules.
  const globals = ['window', 'document', 'location', 'history', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'HTMLAnchorElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'FormData', 'Blob', 'URL', 'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'localStorage', 'sessionStorage'];
  const saved = {};
  for (const key of globals) { saved[key] = globalThis[key]; try { globalThis[key] = window[key]; } catch { /* read-only */ } }
  const savedDate = globalThis.Date;
  const savedSupabase = globalThis.supabase;
  const savedChart = globalThis.Chart;
  globalThis.Date = FrozenDate;
  globalThis.supabase = fake;
  globalThis.Chart = window.Chart;
  const savedSetInterval = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { const id = savedSetInterval(fn, Math.max(ms, 1e9)); intervals.push(id); return id; };

  const script = [...window.document.querySelectorAll('script[type="module"]')].pop();
  const modulePath = resolve(root, script.getAttribute('src'));
  let moduleError = null;
  try {
    // Cache-bust so each page gets a fresh module instance with fresh globals.
    await import(`${pathToFileURL(modulePath).href}?run=${++runCounter}`);
  } catch (error) {
    moduleError = error;
  }
  // Let autoRefresh's first render and any follow-up promises settle.
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));

  const cleanup = () => {
    intervals.forEach(clearInterval);
    for (const key of globals) { try { globalThis[key] = saved[key]; } catch { /* ignore */ } }
    globalThis.Date = savedDate;
    globalThis.supabase = savedSupabase;
    globalThis.Chart = savedChart;
    globalThis.setInterval = savedSetInterval;
    console.error = savedConsoleError;
    console.warn = savedConsoleWarn;
    window.close();
  };
  return { window, document: window.document, errors, moduleError, fake, cleanup, text: () => window.document.body.textContent.replace(/\s+/g, ' ') };
}

const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];

/* ---------------------------------------------------------------------
 * Chrome (shared by every page)
 * ------------------------------------------------------------------- */
for (const file of ['index.html', 'today.html', '30day.html', '60day.html', '90day.html', 'compliance.html', 'costs.html', 'history.html', 'bus.html', 'admin.html']) {
  const raw = readFileSync(resolve(root, file), 'utf8');
  check(`${file}: has CSP meta`, raw.includes('Content-Security-Policy'));
  check(`${file}: no literal \\u escapes in markup`, !/\\u20\d\d/.test(raw));
  check(`${file}: no inline scripts`, !/<script(?![^>]*src=)[^>]*>[^<]*\S[^<]*<\/script>/.test(raw));
  check(`${file}: loads vendored supabase`, raw.includes('vendor/supabase.js'));
  check(`${file}: references an existing module`, existsSync(resolve(root, raw.match(/type="module" src="([^"]+)"/)[1])));
  check(`${file}: favicon`, raw.includes('favicon.svg'));
}

/* ---------------------------------------------------------------------
 * Overview
 * ------------------------------------------------------------------- */
{
  const page = await loadPage('index.html');
  check('overview: module loaded', !page.moduleError, page.moduleError?.stack);
  check('overview: chrome rendered with nav', $$(page.document, 'nav.nav a').length >= 9);
  check('overview: active nav item', $(page.document, 'nav.nav a[aria-current="page"]')?.getAttribute('href') === 'index.html');
  check('overview: admin link in nav', $$(page.document, 'nav.nav a').some((a) => a.getAttribute('href') === 'admin.html'));
  const cards = $$(page.document, '.bus-card');
  check('overview: one card per bus', cards.length === fx.buses.length, `got ${cards.length}`);
  check('overview: nickname is escaped', !page.document.querySelector('script[data-x]') && page.document.body.innerHTML.includes('&lt;script&gt;'));
  const card101 = cards.find((c) => c.textContent.includes('101'));
  check('overview: bus 101 is overdue', card101?.classList.contains('status-overdue'), card101?.className);
  const card106 = cards.find((c) => c.querySelector('.bus-number')?.textContent === '106');
  check('overview: zero-schedule bus is unscheduled, not ok', card106?.classList.contains('status-unscheduled'), card106?.className);
  const card104 = cards.find((c) => c.querySelector('.bus-number')?.textContent === '104');
  check('overview: out-of-service bus shows unsafe badge', card104?.textContent.includes('Not safe to operate'));
  check('overview: summary strip', page.text().includes('Items overdue'));
  check('overview: no console errors', page.errors.length === 0, page.errors.join('; '));
  page.cleanup();
}

/* ---------------------------------------------------------------------
 * Today
 * ------------------------------------------------------------------- */
{
  const page = await loadPage('today.html');
  check('today: module loaded', !page.moduleError, page.moduleError?.stack);
  const sectionText = (title) => {
    const h = $$(page.document, 'h2').find((el) => el.textContent.trim().startsWith(title));
    let text = '';
    for (let el = h?.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) text += el.textContent;
    return text;
  };
  check('today: overdue lists 101 oil (both triggers overdue)', sectionText('Overdue').includes('Engine Oil'));
  check('today: overdue excludes out-of-service bus 104', !sectionText('Overdue').includes('104'));
  check('today: due today lists brake inspection', sectionText('Due today').includes('Brake Inspection'));
  check('today: due this week lists tire rotation (4 days)', sectionText('Due this week').includes('Tire Inspection'));
  check('today: due this week excludes 20-day DOT (was leaking in before)', !sectionText('Due this week').includes('Annual DOT Inspection'));
  check('today: mileage watch lists 102 brakes (400 mi left)', sectionText('Approaching by mileage').includes('Brake Inspection'));
  check('today: open defects listed', sectionText('Open defects').includes('window seal'));
  check('today: in progress listed', sectionText('In progress').includes('Transmission'));
  check('today: task rows use grid layout class', $$(page.document, '.task-row').length >= 3);
  check('today: no console errors', page.errors.length === 0, page.errors.join('; '));
  page.cleanup();
}

/* ---------------------------------------------------------------------
 * Horizon pages
 * ------------------------------------------------------------------- */
for (const [file, days] of [['30day.html', 30], ['60day.html', 60], ['90day.html', 90]]) {
  const page = await loadPage(file);
  check(`${file}: module loaded`, !page.moduleError, page.moduleError?.stack);
  check(`${file}: horizon read from data attribute`, page.text().includes(`Next ${days} Days`), page.text().slice(0, 200));
  check(`${file}: overdue carryover shown`, page.text().includes('Overdue'));
  check(`${file}: week groups rendered`, $$(page.document, '.week-group').length >= 1);
  const included20 = page.text().includes('Annual DOT Inspection');
  check(`${file}: 20-day DOT inspection appears`, included20);
  // Bus 103's oil change is 80 days out: only the 90-day plan should list it in a week group.
  const weekText = $$(page.document, '.week-group').map((el) => el.textContent).join(' ');
  const included80 = weekText.includes('103') && weekText.includes('Engine Oil');
  check(`${file}: 80-day oil change ${days >= 90 ? 'appears' : 'is excluded'}`, days >= 90 ? included80 : !included80);
  check(`${file}: no console errors`, page.errors.length === 0, page.errors.join('; '));
  page.cleanup();
}

/* ---------------------------------------------------------------------
 * Compliance
 * ------------------------------------------------------------------- */
{
  const page = await loadPage('compliance.html');
  check('compliance: module loaded', !page.moduleError, page.moduleError?.stack);
  check('compliance: expired 102 DOT date listed', page.text().includes('102') && page.text().toLowerCase().includes('expired'));
  check('compliance: includes out-of-service bus 104 (still in fleet)', page.text().includes('104'));
  check('compliance: missing dates for 106 flagged', /missing|not set|not recorded/i.test(page.text()));
  check('compliance: regulatory schedules included', page.text().includes('Fire Extinguisher'));
  check('compliance: no console errors', page.errors.length === 0, page.errors.join('; '));
  page.cleanup();
}

/* ---------------------------------------------------------------------
 * Costs (charts stubbed)
 * ------------------------------------------------------------------- */
{
  const page = await loadPage('costs.html', { chart: true });
  check('costs: module loaded', !page.moduleError, page.moduleError?.stack);
  const charts = page.window.Chart.instances;
  check('costs: three charts mounted', charts.length === 3, `got ${charts.length}`);
  check('costs: trend chart has 12 months', charts.some((c) => c.config.data.labels.length === 12));
  check('costs: total shown', page.text().includes('$6,983') || page.text().includes('6,983'), page.text().slice(0, 300));
  check('costs: ranking includes cost per mile', /Cost \/ mile/i.test(page.text()) && $$(page.document, '.cost-row').length === fx.buses.length, `${$$(page.document, '.cost-row').length}`);
  check('costs: no console errors', page.errors.length === 0, page.errors.join('; '));
  page.cleanup();
}

/* ---------------------------------------------------------------------
 * History
 * ------------------------------------------------------------------- */
{
  const page = await loadPage('history.html');
  check('history: module loaded', !page.moduleError, page.moduleError?.stack);
  check('history: all rows listed', $$(page.document, '.history-row').length === fx.maintenanceLogs.length, `${$$(page.document, '.history-row').length}`);
  check('history: bus filter populated', $$(page.document, '#history-bus option').length === fx.buses.length + 1);
  check('history: page status', /1.*of.*1|4 (records|entries)/i.test($(page.document, '#page-status').textContent + page.text()));

  const search = $(page.document, '#history-search');
  search.value = 'transmission';
  search.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  check('history: search filters rows', $$(page.document, '.history-row').length === 1, `${$$(page.document, '.history-row').length}`);

  $(page.document, '#export-csv').click();
  await new Promise((r) => setTimeout(r, 20));
  check('history: CSV download triggered', typeof page.window.__downloaded === 'string' && page.window.__downloaded.endsWith('.csv'), String(page.window.__downloaded));

  $(page.document, '#clear-filters').click();
  await new Promise((r) => setTimeout(r, 400));
  check('history: clear restores rows', $$(page.document, '.history-row').length === fx.maintenanceLogs.length);
  check('history: no console errors', page.errors.length === 0, page.errors.join('; '));
  page.cleanup();

  const preselected = await loadPage('history.html', { query: `?bus=${fx.buses[1].id}` });
  check('history: ?bus= preselects the bus filter', $(preselected.document, '#history-bus').value === fx.buses[1].id);
  check('history: ?bus= filters rows', $$(preselected.document, '.history-row').length === 1);
  preselected.cleanup();
}

/* ---------------------------------------------------------------------
 * Bus detail
 * ------------------------------------------------------------------- */
{
  const page = await loadPage('bus.html', { query: `?id=${fx.buses[0].id}`, chart: true });
  check('bus: module loaded', !page.moduleError, page.moduleError?.stack);
  check('bus: hero shows bus number', $(page.document, 'h1')?.textContent.includes('101'));
  check('bus: overdue schedule listed', page.text().includes('Engine Oil'));
  check('bus: mileage chart mounted', page.window.Chart.instances.length === 1);
  check('bus: compliance fields rendered', page.text().includes('DOT annual inspection') && page.text().includes('Registration'));
  check('bus: admin action links', $$(page.document, 'a[href^="admin.html?bus="]').length >= 3);
  check('bus: maintenance timeline', page.text().includes('Valley Fleet Shop'));
  check('bus: no console errors', page.errors.length === 0, page.errors.join('; '));
  page.cleanup();

  const missing = await loadPage('bus.html', { query: '?id=not-a-uuid' });
  check('bus: invalid id shows picker', /Select a bus/i.test(missing.text()) && $$(missing.document, 'a[href^="bus.html?id="]').length === fx.buses.length, missing.text().slice(0, 200));
  missing.cleanup();

  const noId = await loadPage('bus.html');
  check('bus: no id shows picker', /Select a bus/i.test(noId.text()) && $$(noId.document, 'a[href^="bus.html?id="]').length === fx.buses.length);
  noId.cleanup();
}

/* ---------------------------------------------------------------------
 * Error handling: a failed refresh keeps the last good render
 * ------------------------------------------------------------------- */
{
  const fake = createFakeSupabase({ failTables: new Set(['buses']) });
  const page = await loadPage('index.html', { fake });
  check('overview: first failure shows error state', $(page.document, '.error-state') !== null);
  check('overview: freshness shows offline/error', /offline|error|failed/i.test($(page.document, '#freshness')?.textContent || ''), $(page.document, '#freshness')?.textContent);
  page.cleanup();
}

/* ---------------------------------------------------------------------
 * Admin: gate, wizard, RLS-safe behaviour
 * ------------------------------------------------------------------- */
{
  // Signed out -> sign-in card, no data forms.
  const anon = await loadPage('admin.html');
  check('admin: module loaded', !anon.moduleError, anon.moduleError?.stack);
  check('admin: signed-out shows sign-in form', $(anon.document, '#signin-form') !== null);
  check('admin: signed-out has no write forms', $$(anon.document, '.action-tile').length === 0);
  check('admin: dashboards nav still present', $$(anon.document, 'nav.nav a').length >= 9);
  anon.cleanup();

  // Signed in but not on the allow-list -> not authorised.
  const stranger = await loadPage('admin.html', { fake: createFakeSupabase({ session: { user: { id: 'u2', email: 'x@y.z' } }, admin: false }) });
  check('admin: non-admin sees not-authorised screen', /not authori[sz]ed|no admin access|not an admin/i.test(stranger.text()), stranger.text().slice(0, 200));
  check('admin: non-admin gets no action tiles', $$(stranger.document, '.action-tile').length === 0);
  stranger.cleanup();

  // Admin hub.
  const adminSession = { user: { id: 'u1', email: 'admin@example.com' } };
  const hub = await loadPage('admin.html', { fake: createFakeSupabase({ session: adminSession, admin: true }) });
  check('admin: hub shows action tiles', $$(hub.document, '.action-tile').length >= 6);
  check('admin: hub warns about unscheduled bus 106', hub.text().includes('106') && /no maintenance templates/i.test(hub.text()));
  hub.cleanup();

  // Wizard: full walk-through with a fake RPC.
  let rpcPayload = null;
  const fake = createFakeSupabase({
    session: adminSession,
    admin: true,
    rpcHandlers: {
      create_bus_with_schedules: (args) => {
        rpcPayload = args;
        return { data: { bus: { id: 'new-bus', bus_number: args.p_bus.bus_number }, schedules: args.p_schedules.length }, error: null };
      },
    },
  });
  const wiz = await loadPage('admin.html', { query: '?action=add-bus', fake });
  const doc = wiz.document;
  const submit = async () => {
    $(doc, '#step-form')?.dispatchEvent(new wiz.window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
  };
  const set = (name, value) => { const el = $(doc, `[name="${name}"]`); if (el) el.value = value; else check(`wizard: field ${name} present`, false, wiz.text().slice(0, 300)); };

  check('wizard: step 1 renders vehicle form', $(doc, '[name="bus_number"]') !== null);
  check('wizard: progress indicator', $$(doc, '.wizard-steps li').length === 4);

  // Duplicate bus number is rejected client-side.
  set('bus_number', '101');
  await submit();
  check('wizard: duplicate bus number blocked', /already|duplicate|in use/i.test($(doc, '.field.invalid .error, .error')?.textContent || ''), $(doc, '.error')?.textContent);
  check('wizard: stays on step 1 after error', $(doc, '[name="bus_number"]') !== null);

  // Case/whitespace-insensitive duplicate.
  set('bus_number', ' 101 ');
  await submit();
  check('wizard: trimmed duplicate blocked', $(doc, '[name="bus_number"]') !== null && /already|duplicate|in use/i.test($(doc, '.error')?.textContent || ''));

  set('bus_number', '107');
  set('vin', 'ABC');
  await submit();
  check('wizard: invalid VIN blocked', /17 characters/.test($$(doc, '.error').map((e) => e.textContent).join(' ')), $$(doc, '.error').map((e) => e.textContent).join(' | '));
  set('vin', '1BAANKCL1JF999999');
  set('nickname', 'Test Bus');
  set('year', '2024');
  set('make', 'Blue Bird');
  set('model', 'Vision');
  await submit();
  check('wizard: advances to odometer step', $(doc, '[name="current_mileage"]') !== null);

  // Negative mileage blocked, then valid.
  set('current_mileage', '-5');
  await submit();
  check('wizard: negative mileage blocked', $(doc, '[name="current_mileage"]') !== null && /zero or more/i.test($(doc, '.error')?.textContent || ''), $(doc, '.error')?.textContent);
  set('current_mileage', '12000');
  set('date_recorded', '2026-09-05');
  await submit();
  check('wizard: advances to templates step', $(doc, '.template-row') !== null);
  check('wizard: regulatory templates pre-selected', $(doc, `[name="sel-${fx.items[1].id}"]`)?.checked === true);
  check('wizard: low-priority template not pre-selected', $(doc, `[name="sel-${fx.items[5].id}"]`)?.checked === false);

  // Last-done mileage above odometer is rejected.
  const oil = fx.items[0].id;
  if ($(doc, `[name="lmiles-${oil}"]`)) $(doc, `[name="lmiles-${oil}"]`).value = '15000';
  await submit();
  check('wizard: last-done above odometer blocked', /above the starting odometer/i.test(wiz.text()), wiz.text().slice(0, 300));
  if ($(doc, `[name="lmiles-${oil}"]`)) $(doc, `[name="lmiles-${oil}"]`).value = '';
  await submit();
  check('wizard: review step reached', /Review and create/i.test(wiz.text()));
  check('wizard: review projects oil due 2026-12-04 @ 17,000', /Dec 4, 2026/.test(wiz.text()) && /17,000/.test(wiz.text()), wiz.text().slice(0, 600));
  check('wizard: review projects DOT 365 days out', /Sep 5, 2027/.test(wiz.text()));

  await submit();
  check('wizard: RPC called once with bus + mileage + schedules', rpcPayload !== null && rpcPayload.p_bus.bus_number === '107' && rpcPayload.p_bus.current_mileage === 12000 && Array.isArray(rpcPayload.p_schedules));
  check('wizard: schedules include next_due values', rpcPayload?.p_schedules.every((s) => s.maintenance_item_id && (s.next_due_date || s.next_due_mileage)));
  check('wizard: mileage payload dated', typeof rpcPayload?.p_mileage.date_recorded === 'string' && rpcPayload.p_mileage.date_recorded.startsWith('2026-09-05'));
  check('wizard: success screen', /Bus 107 added/.test(wiz.text()), wiz.text().slice(0, 300));
  check('wizard: no console errors', wiz.errors.length === 0, wiz.errors.join('; '));
  wiz.cleanup();

  // Server rejection (e.g. RLS) is surfaced, not swallowed.
  const rejecting = createFakeSupabase({ session: adminSession, admin: true, rpcHandlers: { create_bus_with_schedules: () => ({ data: null, error: { message: 'Bus number "108" already exists', code: 'P0001' } }) } });
  const wiz2 = await loadPage('admin.html', { query: '?action=add-bus', fake: rejecting });
  const d2 = wiz2.document;
  const go = async () => { $(d2, '#step-form').dispatchEvent(new wiz2.window.Event('submit', { bubbles: true, cancelable: true })); for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5)); };
  if ($(d2, '[name="bus_number"]')) $(d2, '[name="bus_number"]').value = '108';
  await go();
  if ($(d2, '[name="current_mileage"]')) $(d2, '[name="current_mileage"]').value = '0';
  await go();
  await go();
  await go();
  check('wizard: server error shown', /Not saved/.test(wiz2.text()) && /already exists/.test(wiz2.text()), wiz2.text().slice(0, 400));
  check('wizard: stays on review after server error', /Review and create/.test(wiz2.text()));
  wiz2.cleanup();

  // Mileage form: decreasing reading blocked client-side.
  const mil = await loadPage('admin.html', { query: `?action=mileage&bus=${fx.buses[0].id}`, fake: createFakeSupabase({ session: adminSession, admin: true }) });
  check('mileage form: renders for deep-linked bus', $(mil.document, '[name="bus_id"]')?.value === fx.buses[0].id);
  if ($(mil.document, '[name="mileage"]')) $(mil.document, '[name="mileage"]').value = '1000';
  $(mil.document, '#form')?.dispatchEvent(new mil.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 50));
  check('mileage form: decreasing reading blocked', /lower than|below|cannot decrease|current reading/i.test($(mil.document, '.error')?.textContent || mil.text()), $(mil.document, '.error')?.textContent);
  mil.cleanup();
}

/* ---------------------------------------------------------------------
 * Admin: the remaining forms render and submit through api.js
 * ------------------------------------------------------------------- */
{
  const adminSession = { user: { id: 'u1', email: 'admin@example.com' } };
  const bus = fx.buses[0];
  const rpcs = [];
  const mk = () => createFakeSupabase({
    session: adminSession,
    admin: true,
    rpcHandlers: {
      record_mileage: (args) => { rpcs.push(['record_mileage', args]); return { data: { ...bus, current_mileage: args.p_mileage }, error: null }; },
      log_maintenance: (args) => { rpcs.push(['log_maintenance', args]); return { data: { id: 'log-new', ...args.p_log }, error: null }; },
      assign_schedules: (args) => { rpcs.push(['assign_schedules', args]); return { data: args.p_schedules.map((s, i) => ({ id: `s-new-${i}`, ...s })), error: null }; },
    },
  });
  const submitForm = async (page) => {
    $(page.document, '#form')?.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
  };

  // Mileage: valid higher reading goes through the RPC.
  const mil = await loadPage('admin.html', { query: `?action=mileage&bus=${bus.id}`, fake: mk() });
  $(mil.document, '[name="mileage"]').value = String(bus.current_mileage + 120);
  await submitForm(mil);
  check('mileage form: higher reading submitted via record_mileage', rpcs.some(([n, a]) => n === 'record_mileage' && a.p_bus_id === bus.id && a.p_mileage === bus.current_mileage + 120), JSON.stringify(rpcs));
  check('mileage form: success notice', /recorded|saved|updated/i.test(mil.text()), mil.text().slice(-300));
  check('mileage form: no console errors', mil.errors.length === 0, mil.errors.join('; '));
  mil.cleanup();

  // Maintenance: schedule select offers the bus's active schedules; submit calls log_maintenance.
  const mnt = await loadPage('admin.html', { query: `?action=maintenance&bus=${bus.id}`, fake: mk() });
  check('maintenance form: renders', $(mnt.document, '#form') !== null, mnt.text().slice(0, 200));
  const scheduleSelect = $(mnt.document, '[name="bus_maintenance_schedule_id"], [name="schedule_id"]');
  check('maintenance form: lists this bus\'s schedules', scheduleSelect !== null && scheduleSelect.options.length >= 4, `${scheduleSelect?.options.length}`);
  const dateField = $(mnt.document, '[name="date_performed"]');
  check('maintenance form: date defaults to today', dateField?.value === '2026-09-05', dateField?.value);
  const mileageField = $(mnt.document, '[name="mileage_at_service"]');
  if (mileageField) mileageField.value = String(bus.current_mileage);
  const performedBy = $(mnt.document, '[name="performed_by"]');
  if (performedBy) performedBy.value = 'Test Mechanic';
  const costField = $(mnt.document, '[name="parts_cost"]');
  if (costField) costField.value = '120';
  const laborField = $(mnt.document, '[name="labor_cost"]');
  if (laborField) laborField.value = '80';
  const descField = $(mnt.document, '#form [name="description"]');
  if (descField) descField.value = 'Oil and filter';
  if (scheduleSelect) scheduleSelect.value = fx.schedules[0].id;
  await submitForm(mnt);
  const logCall = rpcs.find(([n]) => n === 'log_maintenance');
  check('maintenance form: log_maintenance called with bus + schedule', logCall && logCall[1].p_log.bus_id === bus.id && logCall[1].p_log.bus_maintenance_schedule_id === fx.schedules[0].id, JSON.stringify(logCall) + ' ' + mnt.text().slice(-300));
  check('maintenance form: no console errors', mnt.errors.length === 0, mnt.errors.join('; '));
  mnt.cleanup();

  // Defect report.
  const def = await loadPage('admin.html', { query: `?action=defect&bus=${bus.id}`, fake: mk() });
  check('defect form: renders severity + category selects', $(def.document, '[name="severity"]') !== null && $(def.document, '[name="category"]') !== null);
  // Scope to the form: <meta name="description"> in <head> also matches [name="description"].
  $(def.document, '#form [name="description"]').value = 'Wiper motor intermittent';
  const reporter = $(def.document, '[name="reported_by"]');
  if (reporter) reporter.value = 'Driver';
  await submitForm(def);
  check('defect form: insert went through the client', def.fake.client.calls.some((c) => c.table === 'defect_reports' && c.mutation === 'insert'), JSON.stringify(def.fake.client.calls.filter((c) => c.mutation !== 'select')) + def.text().slice(-200));
  check('defect form: no console errors', def.errors.length === 0, def.errors.join('; '));
  def.cleanup();

  // Open defects list.
  const list = await loadPage('admin.html', { query: '?action=defects', fake: mk() });
  check('defect list: shows every open defect', $$(list.document, 'form[data-defect]').length === fx.defects.length, `${$$(list.document, 'form[data-defect]').length}`);
  check('defect list: unsafe defect flagged', /not safe/i.test(list.text()));
  list.cleanup();

  // Edit bus.
  const edit = await loadPage('admin.html', { query: `?action=edit&bus=${bus.id}`, fake: mk() });
  check('edit form: prefilled with bus data', $(edit.document, '[name="nickname"]')?.value === 'Big Blue', $(edit.document, '[name="nickname"]')?.value);
  check('edit form: status options', $$(edit.document, '[name="status"] option').length === 4);
  $(edit.document, '[name="nickname"]').value = 'Bigger Blue';
  await submitForm(edit);
  check('edit form: update went through the client', edit.fake.client.calls.some((c) => c.table === 'buses' && c.mutation === 'update'), edit.text().slice(-200));
  check('edit form: no console errors', edit.errors.length === 0, edit.errors.join('; '));
  edit.cleanup();

  // Assign templates: only templates not yet assigned are offered.
  const assign = await loadPage('admin.html', { query: `?action=schedules&bus=${bus.id}`, fake: mk() });
  const offered = $$(assign.document, '.template-row');
  check('assign form: offers only unassigned templates', offered.length === fx.items.length - 4, `${offered.length}`);
  const firstBox = $(assign.document, '.template-row input[type="checkbox"]');
  firstBox.checked = true;
  firstBox.dispatchEvent(new assign.window.Event('change', { bubbles: true }));
  await submitForm(assign);
  const assignCall = rpcs.find(([n]) => n === 'assign_schedules');
  check('assign form: assign_schedules called for the bus', assignCall && assignCall[1].p_bus_id === bus.id && assignCall[1].p_schedules.length === 1, JSON.stringify(assignCall) + assign.text().slice(-200));
  check('assign form: no console errors', assign.errors.length === 0, assign.errors.join('; '));
  assign.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
// Pages leave long idle/refresh timers behind; exit explicitly.
process.exit(failed ? 1 : 0);
