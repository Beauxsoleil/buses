import { fetchBus, fetchBuses, fetchSchedulesForBus, fetchMaintenanceLogs, fetchMileageLogs, fetchDefects, getSession } from '../api.js';
import { computeUrgency, statusForBus, statusLabel, daysUntil, deadlineStatus, deadlineLabel } from '../urgency.js';
import { COMPLIANCE_FIELDS, DEFECT_STATUSES } from '../config.js';
import { initPage, autoRefresh, escapeHtml, formatDate, formatTimestampDate, formatMoney, formatNumber, categoryLabel, titleCase, vehicleDescription, errorState, emptyState, pluralize } from '../ui.js';
import { mountChart, destroyCharts, chartTheme, chartsAvailable, integer } from '../charts.js';

const content = document.getElementById('content');
const busId = new URLSearchParams(location.search).get('id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detail(label, value, status) {
  return `<div class="detail-field${status ? ` status-${status}` : ''}"><span>${label}</span><strong>${escapeHtml(value || '\u2014')}${status && status !== 'ok' && status !== 'unscheduled' ? ` <span class="dot status-${status}" aria-hidden="true" style="margin-left:6px"></span>` : ''}</strong></div>`;
}

function scheduleRow(schedule) {
  const urgency = computeUrgency(schedule);
  return `
    <div class="detail-schedule status-${urgency.status}">
      <span class="dot status-${urgency.status}" role="img" aria-label="${escapeHtml(statusLabel(urgency.status))}"></span>
      <div><strong>${escapeHtml(schedule.item?.name || 'Maintenance item')}</strong><span>${escapeHtml(categoryLabel(schedule.item?.category))}${schedule.last_completed_date ? ` \u00b7 last done ${formatDate(schedule.last_completed_date)}` : ' \u00b7 never done'}</span></div>
      <div><strong>${formatDate(schedule.next_due_date)}</strong><span>${escapeHtml(urgency.label)}</span></div>
      <div><strong>${schedule.next_due_mileage == null ? '\u2014' : `${formatNumber(schedule.next_due_mileage)} mi`}</strong><span>${schedule.next_due_engine_hours == null ? '' : `${formatNumber(schedule.next_due_engine_hours)} hr`}</span></div>
      <span class="tag${schedule.item?.is_regulatory ? ' regulatory' : ''}">${escapeHtml(schedule.item?.priority || 'MEDIUM')}</span>
    </div>`;
}

function defectCard(defect) {
  const unsafe = defect.is_bus_safe_to_operate === false;
  return `
    <article class="defect-card${unsafe ? ' unsafe' : ''}">
      <div><span class="tag">${escapeHtml(titleCase(defect.severity))}</span><span class="tag">${escapeHtml(titleCase(defect.status))}</span></div>
      <h3>${escapeHtml(defect.description)}</h3>
      <p>${formatTimestampDate(defect.reported_date)} \u00b7 Reported by ${escapeHtml(defect.reported_by || 'field')}</p>
      ${unsafe ? '<strong class="unsafe-label">NOT SAFE TO OPERATE</strong>' : ''}
    </article>`;
}

// No (or a malformed) id: offer the fleet list instead of a dead end.
async function renderPicker() {
  const buses = await fetchBuses();
  content.innerHTML = `
    <div class="page-intro"><div><p class="eyebrow">Vehicle record</p><h1>Select a bus</h1><p>${busId ? 'That link did not include a valid bus ID. ' : ''}Choose a vehicle to open its record.</p></div></div>
    ${buses.length ? `<div class="bus-picker">${buses.map((b) => `<a class="button secondary" href="bus.html?id=${encodeURIComponent(b.id)}">Bus ${escapeHtml(b.bus_number)}${b.nickname ? ` \u00b7 ${escapeHtml(b.nickname)}` : ''}</a>`).join('')}</div>` : emptyState('No buses yet.')}
    <p><a class="back-link" href="index.html">\u2190 Fleet Overview</a></p>`;
}

async function render() {
  if (!busId || !UUID.test(busId)) {
    await renderPicker();
    return;
  }
  const [bus, schedules, logs, mileage, defects, session] = await Promise.all([
    fetchBus(busId),
    fetchSchedulesForBus(busId),
    fetchMaintenanceLogs({ busId }),
    fetchMileageLogs({ busId }),
    fetchDefects({ busId, status: DEFECT_STATUSES.filter((s) => s !== 'RESOLVED') }),
    getSession().catch(() => null),
  ]);
  if (!bus) {
    content.innerHTML = errorState('Bus not found.') + '<p><a href="index.html">Return to Fleet Overview</a></p>';
    return;
  }

  document.title = `Bus ${bus.bus_number} \u2014 Bus Maintenance Tracker`;
  const health = statusForBus(bus, schedules);
  const totalCost = logs.reduce((sum, log) => sum + Number(log.cost || 0), 0);
  const currentYear = new Date().getFullYear();
  const yearCost = logs.filter((log) => String(log.date_performed).startsWith(String(currentYear))).reduce((sum, log) => sum + Number(log.cost || 0), 0);
  const trackedMiles = mileage.length > 1 ? Math.max(0, mileage.at(-1).mileage - mileage[0].mileage) : 0;
  const overdueCount = schedules.filter((s) => computeUrgency(s).status === 'overdue').length;
  const lastReading = mileage.at(-1);
  const staleDays = lastReading ? -daysUntil(lastReading.date_recorded) : null;
  const complianceFields = COMPLIANCE_FIELDS.map(([field, label]) => ({ field, label, days: daysUntil(bus[field]) }));
  const adminLink = (action) => `admin.html?bus=${encodeURIComponent(bus.id)}&action=${action}`;

  destroyCharts();
  content.innerHTML = `
    <div class="bus-detail-hero status-${health}">
      <div><a class="back-link" href="index.html">\u2190 Fleet Overview</a><p class="eyebrow">Vehicle record</p><h1>BUS ${escapeHtml(bus.bus_number)}</h1><p>${escapeHtml(bus.nickname ? `\u201c${bus.nickname}\u201d \u00b7 ${vehicleDescription(bus)}` : vehicleDescription(bus) || 'No vehicle details on file')}</p></div>
      <div class="bus-health"><span class="dot status-${health}" aria-hidden="true"></span><strong>${escapeHtml(statusLabel(health).toUpperCase())}</strong><span>${pluralize(overdueCount, 'overdue item')}${staleDays !== null && staleDays > 14 ? ` \u00b7 odometer ${staleDays} days old` : ''}</span></div>
    </div>
    <div class="detail-actions">
      <a class="button" href="${adminLink('mileage')}">Update mileage</a>
      <a class="button" href="${adminLink('maintenance')}">Log maintenance</a>
      <a class="button secondary" href="${adminLink('defect')}">Report defect</a>
      <a class="button secondary" href="${adminLink('schedules')}">Assign templates</a>
      <a class="button secondary" href="${adminLink('edit')}">Edit details</a>
      ${session ? '' : '<span class="text-dim" style="align-self:center;font-size:12px">Changes require admin sign-in</span>'}
    </div>
    <div class="detail-layout">
      <section class="panel detail-information"><div class="panel-title"><h2>Vehicle information</h2><span>${escapeHtml(titleCase(bus.status))}</span></div>
        <div class="detail-grid">
          ${detail('Year / Make / Model', vehicleDescription(bus))}
          ${detail('VIN', bus.vin)}${detail('License plate', bus.license_plate)}${detail('Current mileage', `${formatNumber(bus.current_mileage || 0)} mi`)}
          ${detail('Engine hours', bus.engine_hours == null ? '\u2014' : `${formatNumber(bus.engine_hours)} hr`)}${detail('Acquired', formatDate(bus.date_acquired))}
          ${complianceFields.map(({ field, label, days }) => detail(label, bus[field] ? `${formatDate(bus[field])} \u00b7 ${deadlineLabel(days)}` : '\u2014', deadlineStatus(days))).join('')}
        </div>
        ${bus.notes ? `<div class="detail-notes"><span>Notes</span><p>${escapeHtml(bus.notes)}</p></div>` : ''}
      </section>
      <section class="panel detail-costs"><div class="panel-title"><h2>Cost summary</h2><span>Recorded history</span></div>
        <div class="detail-kpis"><div><strong>${formatMoney(yearCost)}</strong><span>This year</span></div><div><strong>${formatMoney(totalCost)}</strong><span>Lifetime logged</span></div><div><strong>${trackedMiles ? formatMoney(totalCost / trackedMiles) : '\u2014'}</strong><span>Cost / tracked mile (${formatNumber(trackedMiles)} mi)</span></div></div>
      </section>
      <section class="panel mileage-panel"><div class="panel-title"><h2>Mileage history</h2><span>${pluralize(mileage.length, 'reading')}${lastReading ? ` \u00b7 last ${formatTimestampDate(lastReading.date_recorded)}` : ''}</span></div>${mileage.length ? `<div class="chart-wrap"><canvas id="mileage-chart" role="img" aria-label="Odometer readings from ${formatNumber(mileage[0].mileage)} to ${formatNumber(lastReading.mileage)} miles"></canvas></div>` : emptyState('No mileage history recorded.')}</section>
    </div>
    <section class="detail-section"><div class="section-heading-row"><div><p class="eyebrow">Preventive maintenance</p><h2>Active schedule</h2></div><span>${pluralize(schedules.length, 'item')}</span></div>
      <div class="detail-schedule-head" aria-hidden="true"><span></span><span>Maintenance</span><span>Due date</span><span>Meter trigger</span><span>Priority</span></div>
      ${schedules.map(scheduleRow).join('') || emptyState('No maintenance templates assigned. Use "Assign templates" to add them.')}
    </section>
    <section class="detail-section"><div class="section-heading-row"><div><p class="eyebrow">Open issues</p><h2>Active defects</h2></div><span>${pluralize(defects.length, 'report')}</span></div>
      <div class="defect-grid">${defects.map(defectCard).join('') || emptyState('No active defects.')}</div>
    </section>
    <section class="detail-section"><div class="section-heading-row"><div><p class="eyebrow">Completed work</p><h2>Recent maintenance</h2></div><a href="history.html?bus=${encodeURIComponent(bus.id)}">View full history \u2192</a></div>
      <div class="maintenance-timeline">${logs.slice(0, 8).map((log) => `
        <article><time datetime="${escapeHtml(log.date_performed)}">${formatDate(log.date_performed)}</time><div><strong>${escapeHtml(log.item?.name || 'Unscheduled repair')}</strong><span>${escapeHtml(log.description || '')}${log.mileage_at_service ? ` \u00b7 ${formatNumber(log.mileage_at_service)} mi` : ''}</span></div><div><strong>${formatMoney(log.cost)}</strong><span>${escapeHtml(log.vendor || log.performed_by || '')}</span></div></article>`).join('') || emptyState('No completed maintenance logged.')}</div>
    </section>`;

  if (mileage.length && chartsAvailable()) {
    mountChart('mileage-chart', {
      type: 'line',
      data: {
        labels: mileage.map((r) => formatTimestampDate(r.date_recorded, undefined, { year: undefined })),
        datasets: [{ label: 'Odometer', data: mileage.map((r) => r.mileage), borderColor: chartTheme.accent, backgroundColor: chartTheme.accentFill, fill: true, tension: .25, pointRadius: 3 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: integer } } } },
    });
  }
}

await initPage({ navigation: false });
autoRefresh(render, { onFirstError: (e) => { content.innerHTML = errorState(`Couldn't load bus details: ${e.message}`); } });
