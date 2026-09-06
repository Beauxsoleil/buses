import { fetchBuses, fetchFleetSchedules } from '../api.js';
import { computeUrgency, daysUntil, deadlineStatus, deadlineLabel, statusLabel } from '../urgency.js';
import { COMPLIANCE_FIELDS } from '../config.js';
import { initPage, autoRefresh, escapeHtml, formatDate, categoryLabel, vehicleDescription, errorState, emptyState } from '../ui.js';

const content = document.getElementById('content');

const DOCUMENT_STATE = { overdue: 'Expired', 'due-soon': 'Act now', upcoming: 'Plan renewal', ok: 'Current', unscheduled: 'No date' };

function documentRow(entry) {
  return `
    <a class="compliance-row status-${entry.status}" href="bus.html?id=${encodeURIComponent(entry.bus.id)}">
      <div class="planning-bus">BUS ${escapeHtml(entry.bus.bus_number)}</div>
      <div><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.bus.nickname || vehicleDescription(entry.bus))}</span></div>
      <div><strong>${formatDate(entry.date)}</strong><span>${deadlineLabel(entry.days)}</span></div>
      <div class="compliance-state">${DOCUMENT_STATE[entry.status]}</div>
    </a>`;
}

function regulatoryRow({ schedule: s, urgency: u }) {
  return `
    <a class="compliance-row status-${u.status}" href="bus.html?id=${encodeURIComponent(s.bus.id)}">
      <div class="planning-bus">BUS ${escapeHtml(s.bus.bus_number)}</div>
      <div><strong>${escapeHtml(s.item?.name || 'Inspection')}</strong><span>${escapeHtml(categoryLabel(s.item?.category))}${s.bus.status !== 'ACTIVE' ? ` \u00b7 bus ${escapeHtml(categoryLabel(s.bus.status).toLowerCase())}` : ''}</span></div>
      <div><strong>${formatDate(s.next_due_date)}</strong><span>${escapeHtml(u.label)}</span></div>
      <div class="compliance-state">${escapeHtml(statusLabel(u.status))}</div>
    </a>`;
}

async function render() {
  const [allBuses, schedules] = await Promise.all([fetchBuses(), fetchFleetSchedules()]);
  const buses = allBuses.filter((bus) => !['RETIRED', 'SOLD'].includes(bus.status));

  const documents = buses.flatMap((bus) => COMPLIANCE_FIELDS.map(([field, label]) => {
    const date = bus[field];
    const days = daysUntil(date);
    return { bus, label, date, days, status: deadlineStatus(days) };
  })).sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity));

  const regulatory = schedules
    .filter((s) => s.item?.is_regulatory)
    .map((s) => ({ schedule: s, urgency: computeUrgency(s) }))
    .sort((a, b) => (a.urgency.daysRemaining ?? Infinity) - (b.urgency.daysRemaining ?? Infinity));

  const expired = documents.filter((d) => d.status === 'overdue').length;
  const within30 = documents.filter((d) => d.days !== null && d.days >= 0 && d.days <= 30).length;
  const within90 = documents.filter((d) => d.days !== null && d.days > 30 && d.days <= 90).length;
  const missing = documents.filter((d) => d.days === null).length;

  content.innerHTML = `
    <div class="page-intro">
      <div><p class="eyebrow">Regulatory readiness</p><h1>Compliance Tracker</h1><p>Fleet documents, statutory deadlines, and required inspection schedules in one view.</p></div>
      <div class="keyboard-hint">\u2190 \u2192 switch views</div>
    </div>
    <div class="summary-strip compliance-summary">
      <div class="summary-stat"><div class="num">${buses.length}</div><div class="label">Buses tracked</div></div>
      <div class="summary-stat overdue"><div class="num">${expired}</div><div class="label">Expired deadlines</div></div>
      <div class="summary-stat due-soon"><div class="num">${within30}</div><div class="label">Due within 30 days</div></div>
      <div class="summary-stat"><div class="num">${within90}</div><div class="label">Due in 31\u201390 days</div></div>
      <div class="summary-stat"><div class="num">${missing}</div><div class="label">Missing dates</div></div>
    </div>
    <section class="compliance-section">
      <div class="section-heading-row"><div><p class="eyebrow">Vehicle documents</p><h2>Fleet deadlines</h2></div><span>${documents.length} records</span></div>
      <div class="compliance-table-head" aria-hidden="true"><span>Vehicle</span><span>Requirement</span><span>Deadline</span><span>Status</span></div>
      ${documents.map(documentRow).join('') || emptyState('No compliance deadlines found.')}
    </section>
    <section class="compliance-section">
      <div class="section-heading-row"><div><p class="eyebrow">Required maintenance</p><h2>Regulatory inspections</h2></div><span>${regulatory.length} schedules</span></div>
      <div class="compliance-table-head" aria-hidden="true"><span>Vehicle</span><span>Inspection</span><span>Next due</span><span>Status</span></div>
      ${regulatory.map(regulatoryRow).join('') || emptyState('No regulatory maintenance schedules found.')}
    </section>`;
}

await initPage();
autoRefresh(render, { onFirstError: (e) => { content.innerHTML = errorState(`Couldn't load compliance data: ${e.message}`); } });
