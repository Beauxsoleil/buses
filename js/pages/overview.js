import { fetchBuses, fetchActiveSchedules, fetchDefects } from '../api.js';
import { computeUrgency, statusForBus, statusLabel, compareUrgency } from '../urgency.js';
import { initPage, autoRefresh, escapeHtml, formatNumber, vehicleDescription, titleCase, errorState, emptyState, pluralize } from '../ui.js';

const grid = document.getElementById('bus-grid');
const summary = document.getElementById('summary-strip');
const viewBar = document.getElementById('fleet-view-bar');
const showArchived = new URLSearchParams(location.search).has('archived');

function busCard(bus, schedules, openDefects) {
  const health = statusForBus(bus, schedules);
  const urgencies = schedules.map((s) => ({ s, u: computeUrgency(s) })).sort(compareUrgency);
  const overdue = urgencies.filter((x) => x.u.status === 'overdue').length;
  const dueWeek = urgencies.filter((x) => x.u.status !== 'overdue' && x.u.daysRemaining !== null && x.u.daysRemaining <= 7).length;
  const unsafe = openDefects.some((d) => d.is_bus_safe_to_operate === false);
  const next = urgencies[0];

  return `
    <a class="bus-card status-${health}" href="bus.html?id=${encodeURIComponent(bus.id)}" aria-label="Bus ${escapeHtml(bus.bus_number)}, ${escapeHtml(statusLabel(health))}">
      <div class="bus-card-head">
        <div class="bus-number">${escapeHtml(bus.bus_number)}</div>
        <div class="bus-status-badge">${escapeHtml(titleCase(bus.status))}</div>
      </div>
      ${bus.nickname ? `<div class="bus-nickname">\u201c${escapeHtml(bus.nickname)}\u201d</div>` : ''}
      <div class="bus-meta">${escapeHtml(vehicleDescription(bus) || 'No vehicle details')} \u00b7 ${formatNumber(bus.current_mileage)} mi</div>
      <div class="bus-next-due">
        <span class="dot status-${next ? next.u.status : 'unscheduled'}" aria-hidden="true"></span>
        ${next
          ? `<span class="item-name">${escapeHtml(next.s.item?.name || 'Maintenance')}</span><span class="text-dim"> \u2014 ${escapeHtml(next.u.label)}</span>`
          : '<span class="text-dim">No maintenance scheduled</span>'}
      </div>
      <div class="badge-row">
        <span class="bus-health-label">${escapeHtml(statusLabel(health))}</span>
        ${unsafe ? '<span class="count-badge overdue">Not safe to operate</span>' : ''}
        ${overdue ? `<span class="count-badge overdue">${overdue} overdue</span>` : ''}
        ${dueWeek ? `<span class="count-badge due-soon">${dueWeek} due this week</span>` : ''}
        ${openDefects.length ? `<span class="count-badge">${pluralize(openDefects.length, 'open defect')}</span>` : ''}
      </div>
    </a>`;
}

async function render() {
  const [allBuses, schedules, defects] = await Promise.all([fetchBuses(), fetchActiveSchedules(), fetchDefects()]);
  const archived = allBuses.filter((b) => ['RETIRED', 'SOLD'].includes(b.status));
  const current = allBuses.filter((b) => !['RETIRED', 'SOLD'].includes(b.status));
  const buses = showArchived ? archived : current;

  const schedulesByBus = new Map();
  schedules.forEach((s) => schedulesByBus.set(s.bus_id, [...(schedulesByBus.get(s.bus_id) || []), s]));
  const defectsByBus = new Map();
  defects.forEach((d) => defectsByBus.set(d.bus_id, [...(defectsByBus.get(d.bus_id) || []), d]));

  const urgencies = schedules.map((s) => computeUrgency(s));
  const overdueCount = urgencies.filter((u) => u.status === 'overdue').length;
  const weekCount = urgencies.filter((u) => u.status !== 'overdue' && u.daysRemaining !== null && u.daysRemaining <= 7).length;
  const activeCount = current.filter((b) => b.status === 'ACTIVE').length;
  const oosCount = current.filter((b) => b.status === 'OUT_OF_SERVICE').length;
  const unsafeCount = new Set(defects.filter((d) => d.is_bus_safe_to_operate === false).map((d) => d.bus_id)).size;

  summary.innerHTML = `
    <div class="summary-stat"><div class="num mono-num">${current.length}</div><div class="label">Current vehicles</div></div>
    <div class="summary-stat"><div class="num mono-num">${activeCount}</div><div class="label">Active</div></div>
    <div class="summary-stat${unsafeCount ? ' overdue' : ''}"><div class="num mono-num">${oosCount}${unsafeCount ? ` <small class="text-dim" style="font-size:.45em">+${unsafeCount} unsafe</small>` : ''}</div><div class="label">Out of service</div></div>
    <div class="summary-stat overdue"><div class="num mono-num">${overdueCount}</div><div class="label">Items overdue</div></div>
    <div class="summary-stat due-soon"><div class="num mono-num">${weekCount}</div><div class="label">Due within 7 days</div></div>`;

  viewBar.innerHTML = showArchived
    ? `<div><strong>Archived vehicles</strong><span>${pluralize(archived.length, 'record')}</span></div><a class="button secondary small" href="index.html">Back to current fleet</a>`
    : `<div><strong>Current fleet</strong><span>Retired and sold vehicles are kept with their service history.</span></div>${archived.length ? `<a class="button secondary small" href="index.html?archived">View archived (${archived.length})</a>` : ''}`;

  if (!buses.length) {
    grid.innerHTML = emptyState(showArchived ? 'No archived vehicles.' : 'No current vehicles. Sign in to the Admin page to add one.');
    return;
  }

  const ordered = [...buses].sort((a, b) => String(a.bus_number).localeCompare(String(b.bus_number), undefined, { numeric: true }));
  grid.innerHTML = ordered.map((bus) => busCard(bus, schedulesByBus.get(bus.id) || [], defectsByBus.get(bus.id) || [])).join('');
}

await initPage();
autoRefresh(render, { onFirstError: (e) => { grid.innerHTML = errorState(`Couldn't load fleet data: ${e.message}`); } });
