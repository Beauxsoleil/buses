import {
  fetchBuses,
  fetchMaintenanceLogs,
  fetchMileageLogs,
  startClock,
  highlightActiveNav,
  escapeHtml,
  formatMoney,
} from './dashboard.js';

const content = document.getElementById('content');
let charts = [];

highlightActiveNav();
startClock(document.getElementById('clock'));

function localDate(value) {
  return new Date(`${value}T00:00:00`);
}

function inRange(log, start, end = new Date()) {
  const date = localDate(log.date_performed);
  return date >= start && date <= end;
}

function sumCost(logs) {
  return logs.reduce((sum, log) => sum + Number(log.cost || 0), 0);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function chartDefaults() {
  return {
    color: '#9AA3AC',
    borderColor: '#363C41',
    font: { family: 'Inter, sans-serif' },
  };
}

function buildChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || !window.Chart) return;
  charts.push(new window.Chart(canvas, config));
}

function destroyCharts() {
  charts.forEach((chart) => chart.destroy());
  charts = [];
}

async function render() {
  const [buses, logs, mileage] = await Promise.all([
    fetchBuses(),
    fetchMaintenanceLogs(),
    fetchMileageLogs(),
  ]);

  destroyCharts();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const yearLogs = logs.filter((log) => inRange(log, yearStart, now));

  const busCosts = buses.map((bus) => {
    const busLogs = yearLogs.filter((log) => log.bus_id === bus.id);
    const readings = mileage.filter((reading) => reading.bus_id === bus.id);
    const miles = readings.length > 1 ? readings.at(-1).mileage - readings[0].mileage : 0;
    const total = sumCost(busLogs);
    return { bus, total, jobs: busLogs.length, miles, costPerMile: miles > 0 ? total / miles : null };
  }).sort((a, b) => b.total - a.total);
  const fleetAverage = busCosts.length ? busCosts.reduce((sum, item) => sum + item.total, 0) / busCosts.length : 0;

  const categoryMap = new Map();
  yearLogs.forEach((log) => {
    const category = (log.item?.category || 'OTHER').replace(/_/g, ' ');
    categoryMap.set(category, (categoryMap.get(category) || 0) + Number(log.cost || 0));
  });

  const months = [];
  for (let offset = 11; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push({
      key: monthKey(date),
      label: date.toLocaleDateString('en-US', { month: 'short', year: offset === 11 || date.getMonth() === 0 ? '2-digit' : undefined }),
    });
  }
  const monthTotals = months.map(({ key }) => sumCost(logs.filter((log) => log.date_performed.startsWith(key))));

  content.innerHTML = `
    <div class="page-intro">
      <div><p class="eyebrow">Total cost of ownership</p><h1>Costs & Analytics</h1><p>Maintenance spend, cost drivers, and vehicle-level operating signals.</p></div>
      <div class="keyboard-hint">← → switch views</div>
    </div>
    <div class="summary-strip cost-summary">
      <div class="summary-stat"><div class="num money-num">${formatMoney(sumCost(logs.filter((log) => inRange(log, monthStart, now))))}</div><div class="label">This month</div></div>
      <div class="summary-stat"><div class="num money-num">${formatMoney(sumCost(logs.filter((log) => inRange(log, quarterStart, now))))}</div><div class="label">This quarter</div></div>
      <div class="summary-stat"><div class="num money-num">${formatMoney(sumCost(yearLogs))}</div><div class="label">This year</div></div>
      <div class="summary-stat"><div class="num">${yearLogs.length}</div><div class="label">Services this year</div></div>
      <div class="summary-stat due-soon"><div class="num money-num">${formatMoney(fleetAverage)}</div><div class="label">Average per bus</div></div>
    </div>
    ${logs.length ? `
      <div class="analytics-grid">
        <section class="panel chart-panel chart-wide"><div class="panel-title"><h2>12-month spend trend</h2><span>Completed maintenance</span></div><div class="chart-wrap"><canvas id="trend-chart" aria-label="Monthly maintenance spend line chart"></canvas></div></section>
        <section class="panel chart-panel"><div class="panel-title"><h2>Cost by bus</h2><span>Current year</span></div><div class="chart-wrap"><canvas id="bus-cost-chart" aria-label="Maintenance cost by bus bar chart"></canvas></div></section>
        <section class="panel chart-panel"><div class="panel-title"><h2>Cost by category</h2><span>Current year</span></div><div class="chart-wrap"><canvas id="category-chart" aria-label="Maintenance cost by category doughnut chart"></canvas></div></section>
      </div>
      <section class="cost-ranking">
        <div class="section-heading-row"><div><p class="eyebrow">Replacement signals</p><h2>Vehicle cost ranking</h2></div><span>Above-average spend is flagged</span></div>
        <div class="cost-table-head"><span>Vehicle</span><span>Annual spend</span><span>Services</span><span>Miles tracked</span><span>Cost / mile</span></div>
        ${busCosts.map(({ bus, total, jobs, miles, costPerMile }) => `
          <a class="cost-row${total > fleetAverage && total > 0 ? ' above-average' : ''}" href="bus.html?id=${encodeURIComponent(bus.id)}">
            <div><strong>BUS ${escapeHtml(bus.bus_number)}</strong><span>${escapeHtml(bus.nickname || '')}</span></div>
            <strong>${formatMoney(total)}</strong><span>${jobs}</span><span>${miles.toLocaleString()}</span><strong>${costPerMile === null ? '—' : formatMoney(costPerMile)}</strong>
          </a>`).join('')}
      </section>` : '<div class="empty-state large">No maintenance costs have been logged yet.</div>'}`;

  if (!logs.length) return;
  window.Chart.defaults.color = chartDefaults().color;
  window.Chart.defaults.borderColor = chartDefaults().borderColor;
  window.Chart.defaults.font.family = chartDefaults().font.family;
  const common = { responsive: true, maintainAspectRatio: false, animation: { duration: 350 }, plugins: { legend: { labels: { usePointStyle: true } } } };

  buildChart('trend-chart', {
    type: 'line',
    data: { labels: months.map((month) => month.label), datasets: [{ label: 'Spend', data: monthTotals, borderColor: '#F2A900', backgroundColor: 'rgba(242,169,0,.16)', fill: true, tension: .28, pointRadius: 3 }] },
    options: { ...common, scales: { y: { beginAtZero: true, ticks: { callback: (value) => `$${Number(value).toLocaleString()}` } } } },
  });
  buildChart('bus-cost-chart', {
    type: 'bar',
    data: { labels: busCosts.map((item) => `Bus ${item.bus.bus_number}`), datasets: [{ label: 'Annual spend', data: busCosts.map((item) => item.total), backgroundColor: busCosts.map((item) => item.total > fleetAverage ? '#E8792B' : '#F2A900') }] },
    options: { ...common, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { callback: (value) => `$${Number(value).toLocaleString()}` } } } },
  });
  const palette = ['#F2A900', '#E8792B', '#4C9A2A', '#5B8DEF', '#B076D1', '#D6392E', '#7E8A93'];
  buildChart('category-chart', {
    type: 'doughnut',
    data: { labels: [...categoryMap.keys()], datasets: [{ data: [...categoryMap.values()], backgroundColor: [...categoryMap.keys()].map((_, index) => palette[index % palette.length]), borderColor: '#212528', borderWidth: 3 }] },
    options: { ...common, cutout: '62%' },
  });
}

render().catch((error) => {
  content.innerHTML = `<div class="empty-state error-state">Couldn't load cost analytics: ${escapeHtml(error.message)}</div>`;
});
setInterval(() => render().catch(() => {}), 60000);
