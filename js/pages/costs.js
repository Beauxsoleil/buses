import { fetchBuses, fetchMaintenanceLogs, fetchMileageLogs } from '../api.js';
import { parseLocalDate } from '../urgency.js';
import { initPage, autoRefresh, escapeHtml, formatMoney, formatNumber, errorState, emptyState } from '../ui.js';
import { mountChart, destroyCharts, chartTheme, chartsAvailable, money } from '../charts.js';

const content = document.getElementById('content');

const inRange = (log, start, end) => {
  const date = parseLocalDate(log.date_performed);
  return date && date >= start && date <= end;
};
const sumCost = (logs) => logs.reduce((sum, log) => sum + Number(log.cost || 0), 0);
const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

async function render() {
  const [buses, logs, mileage] = await Promise.all([fetchBuses(), fetchMaintenanceLogs(), fetchMileageLogs()]);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const yearLogs = logs.filter((log) => inRange(log, yearStart, now));

  // Miles this year per bus, from odometer readings inside the year (falling
  // back to the earliest reading when the log starts mid-year).
  const busCosts = buses.filter((bus) => !['SOLD'].includes(bus.status)).map((bus) => {
    const busLogs = yearLogs.filter((log) => log.bus_id === bus.id);
    const readings = mileage.filter((r) => r.bus_id === bus.id);
    const yearReadings = readings.filter((r) => new Date(r.date_recorded) >= yearStart);
    const first = yearReadings[0] || readings.at(-1);
    const last = yearReadings.at(-1) || readings.at(-1);
    const miles = first && last && last !== first ? Math.max(0, last.mileage - first.mileage) : 0;
    const total = sumCost(busLogs);
    return { bus, total, jobs: busLogs.length, miles, costPerMile: miles > 0 ? total / miles : null };
  }).sort((a, b) => b.total - a.total);

  const activeSpend = busCosts.filter((b) => b.total > 0);
  const fleetAverage = activeSpend.length ? activeSpend.reduce((sum, b) => sum + b.total, 0) / activeSpend.length : 0;

  const categoryMap = new Map();
  yearLogs.forEach((log) => {
    const category = (log.item?.category || 'UNSCHEDULED REPAIR').replace(/_/g, ' ');
    categoryMap.set(category, (categoryMap.get(category) || 0) + Number(log.cost || 0));
  });
  const categories = [...categoryMap.entries()].sort((a, b) => b[1] - a[1]);

  const months = [];
  for (let offset = 11; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push({ key: monthKey(date), label: date.toLocaleDateString('en-US', { month: 'short', year: offset === 11 || date.getMonth() === 0 ? '2-digit' : undefined }) });
  }
  const monthTotals = months.map(({ key }) => sumCost(logs.filter((log) => String(log.date_performed).startsWith(key))));
  const partsTotals = months.map(({ key }) => logs.filter((log) => String(log.date_performed).startsWith(key)).reduce((s, l) => s + Number(l.parts_cost || 0), 0));
  const laborTotals = months.map(({ key }) => logs.filter((log) => String(log.date_performed).startsWith(key)).reduce((s, l) => s + Number(l.labor_cost || 0), 0));

  destroyCharts();
  content.innerHTML = `
    <div class="page-intro">
      <div><p class="eyebrow">Total cost of ownership</p><h1>Costs &amp; Analytics</h1><p>Maintenance spend, cost drivers, and vehicle-level operating signals.</p></div>
      <div class="keyboard-hint">\u2190 \u2192 switch views</div>
    </div>
    <div class="summary-strip cost-summary">
      <div class="summary-stat"><div class="num money-num">${formatMoney(sumCost(logs.filter((log) => inRange(log, monthStart, now))))}</div><div class="label">This month</div></div>
      <div class="summary-stat"><div class="num money-num">${formatMoney(sumCost(logs.filter((log) => inRange(log, quarterStart, now))))}</div><div class="label">This quarter</div></div>
      <div class="summary-stat"><div class="num money-num">${formatMoney(sumCost(yearLogs))}</div><div class="label">This year</div></div>
      <div class="summary-stat"><div class="num">${yearLogs.length}</div><div class="label">Services this year</div></div>
      <div class="summary-stat due-soon"><div class="num money-num">${formatMoney(fleetAverage)}</div><div class="label">Average per bus (with spend)</div></div>
    </div>
    ${logs.length ? `
      <div class="analytics-grid">
        <section class="panel chart-panel chart-wide"><div class="panel-title"><h2>12-month spend trend</h2><span>Parts vs. labor, completed maintenance</span></div><div class="chart-wrap"><canvas id="trend-chart" role="img" aria-label="Monthly maintenance spend for the last 12 months: ${months.map((m, i) => `${m.label} ${formatMoney(monthTotals[i])}`).join(', ')}"></canvas></div></section>
        <section class="panel chart-panel"><div class="panel-title"><h2>Cost by bus</h2><span>Current year</span></div><div class="chart-wrap"><canvas id="bus-cost-chart" role="img" aria-label="Maintenance cost by bus this year"></canvas></div></section>
        <section class="panel chart-panel"><div class="panel-title"><h2>Cost by category</h2><span>Current year</span></div><div class="chart-wrap"><canvas id="category-chart" role="img" aria-label="Maintenance cost by category: ${categories.map(([c, v]) => `${c} ${formatMoney(v)}`).join(', ')}"></canvas></div></section>
      </div>
      <section class="cost-ranking">
        <div class="section-heading-row"><div><p class="eyebrow">Replacement signals</p><h2>Vehicle cost ranking</h2></div><span>Above-average spend is flagged</span></div>
        <div class="cost-table-head" aria-hidden="true"><span>Vehicle</span><span>Annual spend</span><span>Services</span><span>Miles this year</span><span>Cost / mile</span></div>
        ${busCosts.map(({ bus, total, jobs, miles, costPerMile }) => `
          <a class="cost-row${total > fleetAverage && total > 0 ? ' above-average' : ''}" href="bus.html?id=${encodeURIComponent(bus.id)}">
            <div><strong>BUS ${escapeHtml(bus.bus_number)}</strong><span>${escapeHtml(bus.nickname || bus.status.replace(/_/g, ' ').toLowerCase())}</span></div>
            <strong>${formatMoney(total)}</strong><span>${jobs}</span><span>${formatNumber(miles)}</span><strong>${costPerMile === null ? '\u2014' : formatMoney(costPerMile)}</strong>
          </a>`).join('')}
      </section>` : emptyState('No maintenance costs have been logged yet.', true)}`;

  if (!logs.length || !chartsAvailable()) return;

  mountChart('trend-chart', {
    type: 'bar',
    data: {
      labels: months.map((m) => m.label),
      datasets: [
        { label: 'Parts', data: partsTotals, backgroundColor: chartTheme.accent, stack: 'spend' },
        { label: 'Labor', data: laborTotals, backgroundColor: chartTheme.warn, stack: 'spend' },
        { label: 'Total', data: monthTotals, type: 'line', borderColor: '#ECE9E2', pointRadius: 3, tension: .28, fill: false },
      ],
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: money } } } },
  });
  mountChart('bus-cost-chart', {
    type: 'bar',
    data: { labels: busCosts.map((b) => `Bus ${b.bus.bus_number}`), datasets: [{ label: 'Annual spend', data: busCosts.map((b) => b.total), backgroundColor: busCosts.map((b) => (b.total > fleetAverage ? chartTheme.warn : chartTheme.accent)) }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { callback: money } } } },
  });
  mountChart('category-chart', {
    type: 'doughnut',
    data: { labels: categories.map(([c]) => c), datasets: [{ data: categories.map(([, v]) => v), backgroundColor: categories.map((_, i) => chartTheme.palette[i % chartTheme.palette.length]), borderColor: chartTheme.panel, borderWidth: 3 }] },
    options: { cutout: '62%' },
  });
}

await initPage();
autoRefresh(render, { onFirstError: (e) => { content.innerHTML = errorState(`Couldn't load cost analytics: ${e.message}`); } });
