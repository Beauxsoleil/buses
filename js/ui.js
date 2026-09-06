// Shared page chrome and DOM helpers. Every page calls initPage() first,
// which renders the header + nav (so there is one copy, not ten), wires
// keyboard/swipe navigation and the clock, and returns the settings map.

import { APP_NAME, DASHBOARD_PAGES, ADMIN_PAGE, DEFAULT_SETTINGS } from './config.js';
import { fetchSettings } from './api.js';

/* ---------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------- */

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function categoryLabel(value) {
  return String(value || '').replace(/_/g, ' ');
}

export function titleCase(value) {
  return categoryLabel(value).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatDate(dateString, options = {}) {
  if (!dateString) return '\u2014';
  const date = new Date(`${String(dateString).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '\u2014';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...options });
}

// For timestamptz columns: format in the fleet's timezone, not the browser's.
export function formatDateTime(isoString, timezone = currentSettings.timezone, options = {}) {
  if (!isoString) return '\u2014';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '\u2014';
  return date.toLocaleString('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric', ...options });
}

export function formatTimestampDate(isoString, timezone = currentSettings.timezone) {
  return formatDateTime(isoString, timezone);
}

export function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatNumber(value, fallback = '\u2014') {
  if (value === null || value === undefined || value === '') return fallback;
  return Number(value).toLocaleString('en-US');
}

export function formatMiles(value) {
  return value === null || value === undefined ? '\u2014' : `${formatNumber(value)} mi`;
}

export function vehicleDescription(bus) {
  return [bus.year, bus.make, bus.model].filter(Boolean).join(' ');
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/* ---------------------------------------------------------------------
 * Page chrome
 * ------------------------------------------------------------------- */

export let currentSettings = { ...DEFAULT_SETTINGS };

function currentPage() {
  return location.pathname.split('/').pop() || 'index.html';
}

export function isKioskMode() {
  return new URLSearchParams(location.search).has('kiosk');
}

export function renderChrome({ active = currentPage(), showAdmin = true } = {}) {
  const pages = showAdmin ? [...DASHBOARD_PAGES, ADMIN_PAGE] : DASHBOARD_PAGES;
  const kiosk = isKioskMode() ? '?kiosk' : '';
  const header = `
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="topbar">
      <a class="brand" href="index.html${kiosk}" aria-label="${escapeAttr(APP_NAME)} home">
        <span class="brand-mark">FLEET</span>
        <span class="brand-sub">Maintenance Tracker</span>
      </a>
      <div class="topbar-status">
        <span class="freshness" id="freshness" role="status" aria-live="polite"></span>
        <time class="topbar-clock" id="clock"></time>
      </div>
    </header>
    <nav class="nav" aria-label="Dashboard views">
      ${pages.map((p) => `<a href="${p.href}${p.href === ADMIN_PAGE.href ? '' : kiosk}"${p.href === active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(p.label)}</a>`).join('')}
    </nav>`;
  const mount = document.getElementById('chrome');
  if (mount) mount.outerHTML = header;
  else document.body.insertAdjacentHTML('afterbegin', header);
}

export function startClock(el = document.getElementById('clock')) {
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.dateTime = now.toISOString();
    el.textContent = now.toLocaleString('en-US', {
      timeZone: currentSettings.timezone,
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  };
  tick();
  setInterval(tick, 15_000);
}

// Arrow keys and horizontal swipes step through DASHBOARD_PAGES. Swipes are
// ignored when they start inside the scrollable nav or a form control, and
// when the gesture is mostly vertical (i.e. the user was scrolling).
export function enableDashboardNavigation(active = currentPage()) {
  const index = DASHBOARD_PAGES.findIndex((p) => p.href === active);
  if (index < 0) return;
  const kiosk = isKioskMode() ? '?kiosk' : '';
  const go = (offset) => {
    const target = DASHBOARD_PAGES[(index + offset + DASHBOARD_PAGES.length) % DASHBOARD_PAGES.length];
    location.href = target.href + kiosk;
  };

  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.key === 'ArrowRight') go(1);
    if (event.key === 'ArrowLeft') go(-1);
  });

  let start = null;
  document.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    const insideInteractive = event.target.closest('.nav, input, select, textarea, button, canvas, [data-no-swipe]');
    start = touch && !insideInteractive ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    if (!start) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= 80 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  return go;
}

// Kiosk mode (?kiosk in the URL) advances to the next dashboard page every
// dashboard_auto_rotate_seconds so a wall display cycles unattended.
function startKioskRotation(go) {
  if (!isKioskMode() || !go) return;
  document.body.classList.add('kiosk');
  const seconds = Number(currentSettings.dashboard_auto_rotate_seconds) || DEFAULT_SETTINGS.dashboard_auto_rotate_seconds;
  setTimeout(() => go(1), seconds * 1000);
}

/* ---------------------------------------------------------------------
 * Data freshness + resilient refresh
 * ------------------------------------------------------------------- */

let lastGoodRender = null;
let lastError = null;

function paintFreshness() {
  const el = document.getElementById('freshness');
  if (!el) return;
  if (lastError && lastGoodRender) {
    el.className = 'freshness stale';
    el.textContent = `Data as of ${lastGoodRender.toLocaleTimeString('en-US', { timeZone: currentSettings.timezone, hour: 'numeric', minute: '2-digit' })} \u00b7 retrying`;
    el.title = lastError;
  } else if (lastError) {
    el.className = 'freshness stale';
    el.textContent = 'Offline';
    el.title = lastError;
  } else if (lastGoodRender) {
    el.className = 'freshness';
    el.textContent = `Updated ${lastGoodRender.toLocaleTimeString('en-US', { timeZone: currentSettings.timezone, hour: 'numeric', minute: '2-digit' })}`;
    el.title = '';
  }
}

// Runs `render` now and every N seconds. A failed refresh keeps the last good
// screen on the wall and only flags the header as stale; only a failure with
// nothing rendered yet shows a full error state. Overlapping renders are
// prevented and the page refreshes immediately when its tab regains focus.
export function autoRefresh(render, { seconds, onFirstError } = {}) {
  const interval = (seconds ?? Number(currentSettings.dashboard_auto_refresh_seconds) ?? DEFAULT_SETTINGS.dashboard_auto_refresh_seconds) * 1000;
  let inFlight = false;

  const run = async () => {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
      await render();
      lastGoodRender = new Date();
      lastError = null;
    } catch (error) {
      console.error(error);
      lastError = error?.message || String(error);
      if (!lastGoodRender && onFirstError) onFirstError(error);
    } finally {
      inFlight = false;
      paintFreshness();
    }
  };

  run();
  setInterval(run, interval);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  window.addEventListener('online', run);
  return run;
}

export function errorState(message) {
  return `<div class="empty-state error-state" role="alert">${escapeHtml(message)}</div>`;
}

export function emptyState(message, large = false) {
  return `<div class="empty-state${large ? ' large' : ''}">${escapeHtml(message)}</div>`;
}

/* ---------------------------------------------------------------------
 * Bootstrap
 * ------------------------------------------------------------------- */

export async function loadSettings() {
  try {
    const remote = await fetchSettings();
    currentSettings = { ...DEFAULT_SETTINGS, ...remote };
  } catch (error) {
    console.warn('Using default settings:', error?.message || error);
  }
  return currentSettings;
}

// Standard page start: chrome, clock, keyboard/swipe navigation, kiosk
// rotation and remote settings. Settings load first so the clock and refresh
// cadence honour the fleet's configured timezone/intervals.
export async function initPage({ active = currentPage(), navigation = true, showAdmin = true } = {}) {
  renderChrome({ active, showAdmin });
  await loadSettings();
  startClock();
  const go = navigation ? enableDashboardNavigation(active) : null;
  startKioskRotation(go);
  return currentSettings;
}
