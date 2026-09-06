import {
  fetchBuses,
  fetchFleetSchedules,
  computeUrgency,
  startClock,
  autoRefresh,
  highlightActiveNav,
  daysUntil,
  formatDate,
  escapeHtml,
  categoryLabel,
} from './dashboard.js';

const content = document.getElementById('content');
highlightActiveNav();
startClock(document.getElementById('clock'));

function deadlineStatus(days) {
  if (days === null) return 'unscheduled';
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due-soon';
  if (days <= 90) return 'upcoming';
  return 'ok';
}

function deadlineLabel(days) {
  if (days === null) return 'No date';
  if (days < 0) return `${Math.abs(days)} days expired`;
  if (days === 0) return 'Due today';
  return `${days} days remaining`;
}

function documentRow(entry) {
  return `
    <a class="compliance-row status-${entry.status}" href="bus.html?id=${encodeURIComponent(entry.bus.id)}">
      <div class="planning-bus">BUS ${escapeHtml(entry.bus.bus_number)}</div>
      <div><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.bus.nickname || [entry.bus.year, entry.bus.make, entry.bus.model].filter(Boolean).join(' '))}</span></div>
      <div><strong>${formatDate(entry.date)}</strong><span>${deadlineLabel(entry.days)}</span></div>
      <div class="compliance-state">${entry.status === 'overdue' ? 'Expired' : entry.status === 'due-soon' ? 'Act now' : entry.status === 'upcoming' ? 'Plan renewal' : 'Current'}</div>
    </a>`;
}

function regulatoryRow(entry) {
  const { schedule: s, urgency: u } = entry;
  return `
    <a class="compliance-row status-${u.status}" href="bus.html?id=${encodeURIComponent(s.bus.id)}">
      <div class="planning-bus">BUS ${escapeHtml(s.bus.bus_number)}</div>
      <div><strong>${escapeHtml(s.item.name)}</strong><span>${escapeHtml(categoryLabel(s.item.category))}</span></div>
      <div><strong>${formatDate(s.next_due_date)}</strong><span>${escapeHtml(u.label)}</span></div>
      <div class="compliance-state">${u.status === 'overdue' ? 'Overdue' : u.status === 'due-soon' ? 'Due soon' : u.status === 'upcoming' ? 'Upcoming' : 'Current'}</div>
    </a>`;
}

async function render() {
  const [allBuses, schedules] = await Promise.all([fetchBuses(), fetchFleetSchedules()]);
  const buses = allBuses.filter((bus) => !['RETIRED', 'SOLD'].includes(bus.status));
  const fields = [
    ['dot_inspection_due_date', 'DOT annual inspection'],
    ['insurance_expiration_date', 'Insurance'],
    ['registration_expiration_date', 'Registration'],
    ['license_plate_expiration', 'License plate'],
  ];
  const documents = buses.flatMap((bus) => fields.map(([field, label]) => {
    const date = bus[field];
    const days = daysUntil(date);
    return { bus, label, date, days, status: deadlineStatus(days) };
  })).sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity));
  const regulatory = schedules
    .filter((schedule) => schedule.item?.is_regulatory)
    .map((schedule) => ({ schedule, urgency: computeUrgency(schedule) }))
    .sort((a, b) => (a.urgency.daysRemaining ?? Infinity) - (b.urgency.daysRemaining ?? Infinity));

  const expired = documents.filter((entry) => entry.status === 'overdue').length;
  const within30 = documents.filter((entry) => entry.days !== null && entry.days >= 0 && entry.days <= 30).length;
  const within90 = documents.filter((entry) => entry.days !== null && entry.days > 30 && entry.days <= 90).length;
  const missing = documents.filter((entry) => entry.days === null).length;

  content.innerHTML = `
    <div class="page-intro">
      <div><p class="eyebrow">Regulatory readiness</p><h1>Compliance Tracker</h1><p>Fleet documents, statutory deadlines, and required inspection schedules in one view.</p></div>
      <div class="keyboard-hint">← → switch views</div>
    </div>
    <div class="summary-strip compliance-summary">
      <div class="summary-stat"><div class="num">${buses.length}</div><div class="label">Buses tracked</div></div>
      <div class="summary-stat overdue"><div class="num">${expired}</div><div class="label">Expired deadlines</div></div>
      <div class="summary-stat due-soon"><div class="num">${within30}</div><div class="label">Due within 30 days</div></div>
      <div class="summary-stat"><div class="num">${within90}</div><div class="label">Due in 31–90 days</div></div>
      <div class="summary-stat"><div class="num">${missing}</div><div class="label">Missing dates</div></div>
    </div>
    <section class="compliance-section">
      <div class="section-heading-row"><div><p class="eyebrow">Vehicle documents</p><h2>Fleet deadlines</h2></div><span>${documents.length} records</span></div>
      <div class="compliance-table-head"><span>Vehicle</span><span>Requirement</span><span>Deadline</span><span>Status</span></div>
      ${documents.map(documentRow).join('') || '<div class="empty-state">No compliance deadlines found.</div>'}
    </section>
    <section class="compliance-section">
      <div class="section-heading-row"><div><p class="eyebrow">Required maintenance</p><h2>Regulatory inspections</h2></div><span>${regulatory.length} schedules</span></div>
      <div class="compliance-table-head"><span>Vehicle</span><span>Inspection</span><span>Next due</span><span>Status</span></div>
      ${regulatory.map(regulatoryRow).join('') || '<div class="empty-state">No regulatory maintenance schedules found.</div>'}
    </section>`;
}

autoRefresh(() => render().catch((error) => {
  content.innerHTML = `<div class="empty-state error-state">Couldn't load compliance data: ${escapeHtml(error.message)}</div>`;
}), 60);
