import {
  fetchBus,
  fetchSchedulesForBus,
  fetchMaintenanceLogs,
  fetchMileageLogs,
  fetchDefects,
  computeUrgency,
  statusForBus,
  startClock,
  highlightActiveNav,
  escapeHtml,
  formatDate,
  formatMoney,
  categoryLabel,
} from './dashboard.js';

const content = document.getElementById('content');
const busId = new URLSearchParams(location.search).get('id');
let mileageChart = null;

highlightActiveNav();
startClock(document.getElementById('clock'));

function detail(label, value) {
  return `<div class="detail-field"><span>${label}</span><strong>${escapeHtml(value || '—')}</strong></div>`;
}

function scheduleRow(schedule) {
  const urgency = computeUrgency(schedule);
  return `
    <div class="detail-schedule status-${urgency.status}">
      <span class="dot status-${urgency.status}"></span>
      <div><strong>${escapeHtml(schedule.item?.name || 'Maintenance item')}</strong><span>${escapeHtml(categoryLabel(schedule.item?.category))}</span></div>
      <div><strong>${formatDate(schedule.next_due_date)}</strong><span>${escapeHtml(urgency.label)}</span></div>
      <div><strong>${schedule.next_due_mileage == null ? '—' : Number(schedule.next_due_mileage).toLocaleString() + ' mi'}</strong><span>${schedule.next_due_engine_hours == null ? '' : Number(schedule.next_due_engine_hours).toLocaleString() + ' hr'}</span></div>
      <span class="tag${schedule.item?.is_regulatory ? ' regulatory' : ''}">${escapeHtml(schedule.item?.priority || 'MEDIUM')}</span>
    </div>`;
}

function defectCard(defect) {
  const unsafe = !defect.is_bus_safe_to_operate;
  return `
    <article class="defect-card${unsafe ? ' unsafe' : ''}">
      <div><span class="tag">${escapeHtml(defect.severity.replace(/_/g, ' '))}</span><span class="tag">${escapeHtml(defect.status.replace(/_/g, ' '))}</span></div>
      <h3>${escapeHtml(defect.description)}</h3>
      <p>${formatDate(defect.reported_date.slice(0, 10))} · Reported by ${escapeHtml(defect.reported_by || 'field')}</p>
      ${unsafe ? '<strong class="unsafe-label">NOT SAFE TO OPERATE</strong>' : ''}
    </article>`;
}

async function render() {
  if (!busId || !/^[0-9a-f-]{36}$/i.test(busId)) {
    content.innerHTML = '<div class="empty-state error-state">A valid bus ID is required. <a href="index.html">Return to Fleet Overview</a>.</div>';
    return;
  }
  const [bus, schedules, logs, mileage, defects] = await Promise.all([
    fetchBus(busId),
    fetchSchedulesForBus(busId),
    fetchMaintenanceLogs({ busId }),
    fetchMileageLogs({ busId }),
    fetchDefects({ busId, status: ['REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DEFERRED'] }),
  ]);
  if (!bus) {
    content.innerHTML = '<div class="empty-state error-state">Bus not found. <a href="index.html">Return to Fleet Overview</a>.</div>';
    return;
  }

  document.title = `Bus ${bus.bus_number} — Bus Maintenance Tracker`;
  const health = statusForBus(bus, schedules);
  const totalCost = logs.reduce((sum, log) => sum + Number(log.cost || 0), 0);
  const currentYear = new Date().getFullYear();
  const yearCost = logs.filter((log) => Number(log.date_performed.slice(0, 4)) === currentYear).reduce((sum, log) => sum + Number(log.cost || 0), 0);
  const trackedMiles = mileage.length > 1 ? mileage.at(-1).mileage - mileage[0].mileage : 0;
  const overdueCount = schedules.filter((schedule) => computeUrgency(schedule).status === 'overdue').length;

  content.innerHTML = `
    <div class="bus-detail-hero status-${health}">
      <div><a class="back-link" href="index.html">← Fleet Overview</a><p class="eyebrow">Vehicle record</p><h1>BUS ${escapeHtml(bus.bus_number)}</h1><p>${escapeHtml(bus.nickname || [bus.year, bus.make, bus.model].filter(Boolean).join(' '))}</p></div>
      <div class="bus-health"><span class="dot status-${health}"></span><strong>${escapeHtml(health.replace(/-/g, ' ').toUpperCase())}</strong><span>${overdueCount} overdue item${overdueCount === 1 ? '' : 's'}</span></div>
    </div>
    <div class="detail-actions">
      <a class="button" href="admin.html?bus=${encodeURIComponent(bus.id)}&action=mileage">Update mileage</a>
      <a class="button" href="admin.html?bus=${encodeURIComponent(bus.id)}&action=maintenance">Log maintenance</a>
      <a class="button secondary" href="admin.html?bus=${encodeURIComponent(bus.id)}&action=defect">Report defect</a>
      <a class="button secondary" href="admin.html?bus=${encodeURIComponent(bus.id)}&action=status">Change status</a>
    </div>
    <div class="detail-layout">
      <section class="panel detail-information"><div class="panel-title"><h2>Vehicle information</h2><span>${escapeHtml(bus.status.replace(/_/g, ' '))}</span></div>
        <div class="detail-grid">
          ${detail('Year / Make / Model', [bus.year, bus.make, bus.model].filter(Boolean).join(' '))}
          ${detail('VIN', bus.vin)}${detail('License plate', bus.license_plate)}${detail('Current mileage', `${Number(bus.current_mileage || 0).toLocaleString()} mi`)}
          ${detail('Engine hours', bus.engine_hours == null ? '—' : `${Number(bus.engine_hours).toLocaleString()} hr`)}${detail('Acquired', formatDate(bus.date_acquired))}
          ${detail('DOT inspection', formatDate(bus.dot_inspection_due_date))}${detail('Insurance', formatDate(bus.insurance_expiration_date))}
          ${detail('Registration', formatDate(bus.registration_expiration_date))}${detail('License plate renewal', formatDate(bus.license_plate_expiration))}
        </div>
        ${bus.notes ? `<div class="detail-notes"><span>Notes</span><p>${escapeHtml(bus.notes)}</p></div>` : ''}
      </section>
      <section class="panel detail-costs"><div class="panel-title"><h2>Cost summary</h2><span>Recorded history</span></div>
        <div class="detail-kpis"><div><strong>${formatMoney(yearCost)}</strong><span>This year</span></div><div><strong>${formatMoney(totalCost)}</strong><span>Lifetime logged</span></div><div><strong>${trackedMiles ? formatMoney(totalCost / trackedMiles) : '—'}</strong><span>Cost / tracked mile</span></div></div>
      </section>
      <section class="panel mileage-panel"><div class="panel-title"><h2>Mileage history</h2><span>${mileage.length} readings</span></div>${mileage.length ? '<div class="chart-wrap"><canvas id="mileage-chart" aria-label="Mileage history line chart"></canvas></div>' : '<div class="empty-state">No mileage history recorded.</div>'}</section>
    </div>
    <section class="detail-section"><div class="section-heading-row"><div><p class="eyebrow">Preventive maintenance</p><h2>Active schedule</h2></div><span>${schedules.length} items</span></div>
      <div class="detail-schedule-head"><span></span><span>Maintenance</span><span>Due date</span><span>Meter trigger</span><span>Priority</span></div>
      ${schedules.map(scheduleRow).join('') || '<div class="empty-state">No maintenance schedules assigned.</div>'}
    </section>
    <section class="detail-section"><div class="section-heading-row"><div><p class="eyebrow">Open issues</p><h2>Active defects</h2></div><span>${defects.length} reports</span></div>
      <div class="defect-grid">${defects.map(defectCard).join('') || '<div class="empty-state">No active defects.</div>'}</div>
    </section>
    <section class="detail-section"><div class="section-heading-row"><div><p class="eyebrow">Completed work</p><h2>Recent maintenance</h2></div><a href="history.html">View full history →</a></div>
      <div class="maintenance-timeline">${logs.slice(0, 8).map((log) => `
        <article><time datetime="${escapeHtml(log.date_performed)}">${formatDate(log.date_performed)}</time><div><strong>${escapeHtml(log.item?.name || 'Unscheduled repair')}</strong><span>${escapeHtml(log.description || '')}</span></div><div><strong>${formatMoney(log.cost)}</strong><span>${escapeHtml(log.vendor || log.performed_by || '')}</span></div></article>`).join('') || '<div class="empty-state">No completed maintenance logged.</div>'}</div>
    </section>`;

  if (mileageChart) mileageChart.destroy();
  if (mileage.length && window.Chart) {
    window.Chart.defaults.color = '#9AA3AC';
    window.Chart.defaults.borderColor = '#363C41';
    mileageChart = new window.Chart(document.getElementById('mileage-chart'), {
      type: 'line',
      data: { labels: mileage.map((reading) => new Date(reading.date_recorded).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })), datasets: [{ label: 'Odometer', data: mileage.map((reading) => reading.mileage), borderColor: '#F2A900', backgroundColor: 'rgba(242,169,0,.14)', fill: true, tension: .25, pointRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 350 }, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (value) => Number(value).toLocaleString() } } } },
    });
  }
}

render().catch((error) => { content.innerHTML = `<div class="empty-state error-state">Couldn't load bus details: ${escapeHtml(error.message)}</div>`; });
setInterval(() => render().catch(() => {}), 60000);
