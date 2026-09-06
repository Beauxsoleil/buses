import { supabase } from './supabaseClient.js';

/* ---------------------------------------------------------------------
 * Data fetching
 * ------------------------------------------------------------------- */

export async function fetchBuses() {
  const { data, error } = await supabase
    .from('buses')
    .select('*')
    .order('bus_number');
  if (error) throw error;
  return data;
}

// All active schedules, joined with their bus and maintenance item, so
// urgency can be computed client-side without extra round trips.
export async function fetchActiveSchedules() {
  const { data, error } = await supabase
    .from('bus_maintenance_schedules')
    .select('*, bus:buses(*), item:maintenance_items(*)')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).filter((s) => s.bus && s.bus.status === 'ACTIVE');
}

// All enabled schedules for buses that are still part of the fleet. This is
// intentionally broader than fetchActiveSchedules so compliance deadlines do
// not disappear while a bus is temporarily out of service.
export async function fetchFleetSchedules() {
  const { data, error } = await supabase
    .from('bus_maintenance_schedules')
    .select('*, bus:buses(*), item:maintenance_items(*)')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).filter((s) => s.bus && !['RETIRED', 'SOLD'].includes(s.bus.status));
}

export async function fetchDefects({ status } = {}) {
  let q = supabase.from('defect_reports').select('*, bus:buses(*)').order('reported_date', { ascending: false });
  if (status) q = q.in('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function fetchSettings() {
  const { data, error } = await supabase.from('app_settings').select('key, value');
  if (error) throw error;
  const map = {};
  (data || []).forEach((row) => { map[row.key] = row.value; });
  return map;
}

/* ---------------------------------------------------------------------
 * Urgency calculation
 *
 * A schedule is judged on whichever axis (time or mileage) is closer to
 * its limit. Green/yellow/orange/red thresholds follow the spec:
 *   green:  >30 days away AND >75% of interval remaining
 *   yellow: within 30 days OR 25-75% of interval remaining
 *   orange: within 7 days OR <25% of interval remaining
 *   red:    overdue on either axis
 * ------------------------------------------------------------------- */

const STATUS_RANK = { overdue: 4, 'due-soon': 3, upcoming: 2, ok: 1, unscheduled: 0, inactive: -1 };

export function computeUrgency(schedule) {
  const item = schedule.item || {};
  const bus = schedule.bus || {};
  const intervalDays = schedule.custom_interval_days ?? item.default_interval_days ?? null;
  const intervalMiles = schedule.custom_interval_miles ?? item.default_interval_miles ?? null;
  const intervalEngineHours = schedule.custom_interval_engine_hours ?? item.default_interval_engine_hours ?? null;

  let daysRemaining = null;
  let pctDaysRemaining = null;
  if (schedule.next_due_date) {
    const due = new Date(schedule.next_due_date + 'T00:00:00');
    const today = new Date(new Date().toDateString());
    daysRemaining = Math.round((due - today) / 86400000);
    if (intervalDays) pctDaysRemaining = daysRemaining / intervalDays;
  }

  let milesRemaining = null;
  let pctMilesRemaining = null;
  if (schedule.next_due_mileage != null && bus.current_mileage != null) {
    milesRemaining = schedule.next_due_mileage - bus.current_mileage;
    if (intervalMiles) pctMilesRemaining = milesRemaining / intervalMiles;
  }

  let engineHoursRemaining = null;
  let pctEngineHoursRemaining = null;
  if (schedule.next_due_engine_hours != null && bus.engine_hours != null) {
    engineHoursRemaining = Number(schedule.next_due_engine_hours) - Number(bus.engine_hours);
    if (intervalEngineHours) pctEngineHoursRemaining = engineHoursRemaining / intervalEngineHours;
  }

  if (daysRemaining === null && milesRemaining === null && engineHoursRemaining === null) {
    return { status: 'unscheduled', daysRemaining, milesRemaining, engineHoursRemaining, label: 'Not yet scheduled' };
  }

  const pctCandidates = [pctDaysRemaining, pctMilesRemaining, pctEngineHoursRemaining].filter((v) => v !== null);
  const pctRemaining = pctCandidates.length ? Math.min(...pctCandidates) : null;

  const isOverdue = (daysRemaining !== null && daysRemaining < 0) ||
    (milesRemaining !== null && milesRemaining < 0) ||
    (engineHoursRemaining !== null && engineHoursRemaining < 0);
  const isOrange = (daysRemaining !== null && daysRemaining <= 7) || (pctRemaining !== null && pctRemaining < 0.25);
  const isYellow = (daysRemaining !== null && daysRemaining <= 30) || (pctRemaining !== null && pctRemaining < 0.75);

  let status = 'ok';
  if (isOverdue) status = 'overdue';
  else if (isOrange) status = 'due-soon';
  else if (isYellow) status = 'upcoming';

  return {
    status,
    daysRemaining,
    milesRemaining,
    engineHoursRemaining,
    label: formatDueLabel(daysRemaining, milesRemaining, engineHoursRemaining),
  };
}

function formatDueLabel(daysRemaining, milesRemaining, engineHoursRemaining) {
  const parts = [];
  if (daysRemaining !== null) {
    parts.push(daysRemaining < 0 ? `${Math.abs(daysRemaining)}d overdue` : daysRemaining === 0 ? 'due today' : `${daysRemaining}d left`);
  }
  if (milesRemaining !== null) {
    parts.push(milesRemaining < 0 ? `${Math.abs(milesRemaining).toLocaleString()} mi overdue` : `${milesRemaining.toLocaleString()} mi left`);
  }
  if (engineHoursRemaining !== null) {
    const hours = Math.abs(engineHoursRemaining).toLocaleString(undefined, { maximumFractionDigits: 1 });
    parts.push(engineHoursRemaining < 0 ? `${hours} hr overdue` : `${hours} hr left`);
  }
  return parts.join(' \u00b7 ') || '\u2014';
}

export function worstStatus(statuses) {
  if (!statuses.length) return 'ok';
  return statuses.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), 'unscheduled');
}

export function statusForBus(bus, schedulesForBus) {
  if (bus.status !== 'ACTIVE') return 'inactive';
  const urgencies = schedulesForBus.map((s) => computeUrgency(s).status);
  return worstStatus(urgencies.length ? urgencies : ['ok']);
}

/* ---------------------------------------------------------------------
 * UI helpers shared across pages
 * ------------------------------------------------------------------- */

export function startClock(el) {
  const settings = { timezone: 'America/Denver' };
  function tick() {
    const now = new Date();
    el.textContent = now.toLocaleString('en-US', {
      timeZone: settings.timezone,
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }
  tick();
  setInterval(tick, 15000);
}

export function autoRefresh(callback, seconds = 60) {
  callback();
  setInterval(callback, seconds * 1000);
}

export function highlightActiveNav() {
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
  enableDashboardNavigation();
}

export function enableDashboardNavigation() {
  const links = [...document.querySelectorAll('.nav a')]
    .filter((a) => !['admin.html', 'bus.html'].includes(a.getAttribute('href')));
  const current = links.findIndex((a) => a.classList.contains('active'));
  if (current < 0) return;

  const go = (offset) => {
    const target = links[(current + offset + links.length) % links.length];
    if (target) location.href = target.href;
  };

  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.key === 'ArrowRight') go(1);
    if (event.key === 'ArrowLeft') go(-1);
  });

  let touchStartX = null;
  document.addEventListener('touchstart', (event) => {
    touchStartX = event.changedTouches[0]?.clientX ?? null;
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    if (touchStartX === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
    touchStartX = null;
    if (Math.abs(delta) >= 80) go(delta < 0 ? 1 : -1);
  }, { passive: true });
}

export function daysUntil(dateString) {
  if (!dateString) return null;
  const due = new Date(`${dateString}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

export function formatDate(dateString, options = {}) {
  if (!dateString) return '\u2014';
  return new Date(`${dateString}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', ...options,
  });
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function categoryLabel(cat) {
  return (cat || '').replace(/_/g, ' ');
}
