import { fetchActiveSchedules } from '../api.js';
import { computeUrgency, daysUntil, isoLocal, addDays, statusLabel } from '../urgency.js';
import { initPage, autoRefresh, escapeHtml, formatDate, categoryLabel, errorState, emptyState, pluralize } from '../ui.js';

const horizonDays = Number(document.body.dataset.horizon || 30);
const content = document.getElementById('content');

function weekStart(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const distanceFromMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - distanceFromMonday);
  return isoLocal(date);
}

function weekLabel(startString) {
  const start = new Date(`${startString}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = end.toLocaleDateString('en-US', { month: start.getMonth() === end.getMonth() ? undefined : 'short', day: 'numeric' });
  return `${startLabel}\u2013${endLabel}`;
}

function scheduleRow({ s, u, days }) {
  const priority = s.item?.priority || 'MEDIUM';
  const isPlanningFocus = horizonDays === 90 && (s.item?.is_regulatory || ['HIGH', 'CRITICAL'].includes(priority));
  const dateHeading = days === null ? 'Mileage' : formatDate(s.next_due_date, { month: 'short', day: 'numeric', year: undefined });
  const dateSubheading = days === null ? 'No calendar date' : days === 0 ? 'Today' : days < 0 ? `${Math.abs(days)} days ago` : `${days} days`;
  return `
    <a class="planning-row status-${u.status}${isPlanningFocus ? ' planning-focus' : ''}" href="bus.html?id=${encodeURIComponent(s.bus.id)}">
      <div class="planning-date"><strong>${dateHeading}</strong><span>${dateSubheading}</span></div>
      <div class="planning-bus">BUS ${escapeHtml(s.bus.bus_number)}</div>
      <div class="planning-item"><strong>${escapeHtml(s.item?.name || 'Maintenance item')}</strong><span>${escapeHtml(categoryLabel(s.item?.category))}</span></div>
      <div class="planning-flags">
        ${s.item?.is_regulatory ? '<span class="tag regulatory">Regulatory</span>' : ''}
        <span class="tag">${escapeHtml(priority)}</span>
      </div>
      <div class="planning-due"><strong>${escapeHtml(statusLabel(u.status))}</strong><span>${escapeHtml(u.label)}</span></div>
    </a>`;
}

function workload(groups) {
  if (!groups.length) return emptyState('No scheduled workload in this window.');
  const peak = Math.max(...groups.map((group) => group.entries.length), 1);
  return `<div class="workload-grid">${groups.map((group) => {
    const minutes = group.entries.reduce((sum, entry) => sum + Number(entry.s.item?.estimated_duration_minutes || 0), 0);
    const load = Math.round((group.entries.length / peak) * 100);
    return `
      <div class="workload-week">
        <div><strong>${weekLabel(group.key)}</strong><span>${pluralize(group.entries.length, 'item')}${minutes ? ` \u00b7 ${(minutes / 60).toFixed(1)} hr` : ''}</span></div>
        <div class="load-track" role="img" aria-label="${load}% of peak workload"><span style="width:${load}%"></span></div>
      </div>`;
  }).join('')}</div>`;
}

async function render() {
  const schedules = await fetchActiveSchedules();
  const entries = schedules.map((s) => ({ s, u: computeUrgency(s), days: daysUntil(s.next_due_date) }));
  const overdue = entries.filter((e) => e.u.status === 'overdue').sort((a, b) => (a.days ?? 99999) - (b.days ?? 99999));
  const planned = entries
    .filter((e) => e.u.status !== 'overdue' && e.days !== null && e.days >= 0 && e.days <= horizonDays)
    .sort((a, b) => a.days - b.days || String(a.s.bus.bus_number).localeCompare(String(b.s.bus.bus_number), undefined, { numeric: true }));
  const mileageWatch = entries
    .filter((e) => e.u.status !== 'overdue' && (e.days === null || e.days > horizonDays) && ['due-soon', 'upcoming'].includes(e.u.status) && e.u.milesRemaining !== null)
    .sort((a, b) => (a.u.milesRemaining ?? Infinity) - (b.u.milesRemaining ?? Infinity));

  const groupMap = new Map();
  planned.forEach((entry) => {
    const key = weekStart(entry.s.next_due_date);
    groupMap.set(key, [...(groupMap.get(key) || []), entry]);
  });
  const groups = [...groupMap.entries()].map(([key, groupEntries]) => ({ key, entries: groupEntries }));
  const regulatoryCount = planned.filter((e) => e.s.item?.is_regulatory).length;
  const estimatedMinutes = planned.reduce((sum, e) => sum + Number(e.s.item?.estimated_duration_minutes || 0), 0);
  const peakCount = groups.length ? Math.max(...groups.map((g) => g.entries.length)) : 0;
  const horizonEnd = addDays(isoLocal(new Date()), horizonDays);

  content.innerHTML = `
    <div class="page-intro">
      <div><p class="eyebrow">Planning horizon</p><h1>Next ${horizonDays} Days</h1><p>Preventive maintenance and inspections due through ${formatDate(horizonEnd)}.</p></div>
      <div class="keyboard-hint">\u2190 \u2192 switch views</div>
    </div>
    <div class="summary-strip horizon-summary">
      <div class="summary-stat"><div class="num">${planned.length}</div><div class="label">Scheduled items</div></div>
      <div class="summary-stat overdue"><div class="num">${overdue.length}</div><div class="label">Already overdue</div></div>
      <div class="summary-stat due-soon"><div class="num">${regulatoryCount}</div><div class="label">Regulatory items</div></div>
      <div class="summary-stat"><div class="num">${estimatedMinutes ? (estimatedMinutes / 60).toFixed(1) : '\u2014'}</div><div class="label">Estimated shop hours</div></div>
      <div class="summary-stat"><div class="num">${peakCount}</div><div class="label">Peak weekly load</div></div>
    </div>
    <section class="panel workload-panel"><div class="panel-title"><h2>Workload by week</h2><span>Relative to the busiest week</span></div>${workload(groups)}</section>
    ${overdue.length ? `<section class="week-group overdue-carryover"><div class="week-heading"><h2>Overdue carryover</h2><span>Resolve before future work</span></div>${overdue.map(scheduleRow).join('')}</section>` : ''}
    ${groups.map((group) => `
      <section class="week-group">
        <div class="week-heading"><h2>Week of ${weekLabel(group.key)}</h2><span>${group.entries.length} scheduled</span></div>
        ${group.entries.map(scheduleRow).join('')}
      </section>`).join('') || emptyState('Nothing is scheduled in this planning window.', true)}
    ${mileageWatch.length ? `<section class="week-group"><div class="week-heading"><h2>Mileage watch</h2><span>Approaching a mileage limit before their calendar date</span></div>${mileageWatch.map(scheduleRow).join('')}</section>` : ''}`;
}

await initPage();
autoRefresh(render, { onFirstError: (e) => { content.innerHTML = errorState(`Couldn't load the ${horizonDays}-day plan: ${e.message}`); } });
