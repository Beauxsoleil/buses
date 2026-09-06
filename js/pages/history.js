import { fetchBuses, fetchMaintenanceLogs } from '../api.js';
import { initPage, autoRefresh, escapeHtml, formatDate, formatMoney, categoryLabel, errorState, emptyState } from '../ui.js';

const PAGE_SIZE = 25;
let buses = [];
let logs = [];
let filtered = [];
let currentPage = 1;

const search = document.getElementById('history-search');
const busFilter = document.getElementById('history-bus');
const categoryFilter = document.getElementById('history-category');
const fromFilter = document.getElementById('history-from');
const throughFilter = document.getElementById('history-through');
const results = document.getElementById('history-results');

function searchableText(log) {
  return [log.bus?.bus_number, log.item?.name, log.item?.category, log.vendor, log.performed_by, log.work_order_number, log.description, log.notes]
    .join(' ').toLowerCase();
}

function applyFilters({ resetPage = true } = {}) {
  if (resetPage) currentPage = 1;
  const term = search.value.trim().toLowerCase();
  filtered = logs.filter((log) => {
    if (term && !searchableText(log).includes(term)) return false;
    if (busFilter.value && log.bus_id !== busFilter.value) return false;
    if (categoryFilter.value && (log.item?.category || 'UNSCHEDULED') !== categoryFilter.value) return false;
    if (fromFilter.value && log.date_performed < fromFilter.value) return false;
    if (throughFilter.value && log.date_performed > throughFilter.value) return false;
    return true;
  });
  render();
}

function render() {
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pageCount);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const total = filtered.reduce((sum, log) => sum + Number(log.cost || 0), 0);
  const parts = filtered.reduce((sum, log) => sum + Number(log.parts_cost || 0), 0);
  const labor = filtered.reduce((sum, log) => sum + Number(log.labor_cost || 0), 0);

  document.getElementById('history-summary').innerHTML = `
    <div><strong>${filtered.length}</strong><span>Matching records</span></div>
    <div><strong>${formatMoney(total)}</strong><span>Total cost</span></div>
    <div><strong>${formatMoney(parts)}</strong><span>Parts</span></div>
    <div><strong>${formatMoney(labor)}</strong><span>Labor</span></div>`;

  results.innerHTML = pageRows.length ? `
    <div class="history-table-head" aria-hidden="true"><span>Date</span><span>Bus</span><span>Maintenance</span><span>Performed by</span><span>Work order</span><span>Cost</span></div>
    ${pageRows.map((log) => `
      <a class="history-row" href="bus.html?id=${encodeURIComponent(log.bus_id)}">
        <time datetime="${escapeHtml(log.date_performed)}">${formatDate(log.date_performed)}</time>
        <strong>BUS ${escapeHtml(log.bus?.bus_number || '\u2014')}</strong>
        <div><strong>${escapeHtml(log.item?.name || 'Unscheduled repair')}</strong><span>${escapeHtml(log.item?.category ? categoryLabel(log.item.category) : (log.description || ''))}</span></div>
        <div><strong>${escapeHtml(log.performed_by || '\u2014')}</strong><span>${escapeHtml(log.vendor || '')}</span></div>
        <span>${escapeHtml(log.work_order_number || '\u2014')}</span>
        <strong>${formatMoney(log.cost)}</strong>
      </a>`).join('')}` : emptyState('No maintenance records match these filters.', true);

  document.getElementById('page-status').textContent = `Page ${currentPage} of ${pageCount}`;
  document.getElementById('previous-page').disabled = currentPage <= 1;
  document.getElementById('next-page').disabled = currentPage >= pageCount;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // neutralise spreadsheet formula injection
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const headers = ['Date', 'Bus', 'Maintenance item', 'Category', 'Mileage', 'Performed by', 'Vendor', 'Work order', 'Parts cost', 'Labor cost', 'Total cost', 'Description', 'Notes'];
  const rows = filtered.map((log) => [
    log.date_performed, log.bus?.bus_number, log.item?.name || 'Unscheduled repair', categoryLabel(log.item?.category),
    log.mileage_at_service, log.performed_by, log.vendor, log.work_order_number, log.parts_cost, log.labor_cost, log.cost, log.description, log.notes,
  ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `fleet-maintenance-history-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function load() {
  [buses, logs] = await Promise.all([fetchBuses(), fetchMaintenanceLogs()]);
  const selectedBus = busFilter.value;
  const selectedCategory = categoryFilter.value;
  busFilter.innerHTML = `<option value="">All buses</option>${buses.map((bus) => `<option value="${escapeHtml(bus.id)}">Bus ${escapeHtml(bus.bus_number)}</option>`).join('')}`;
  const categories = [...new Set(logs.map((log) => log.item?.category || 'UNSCHEDULED'))].sort();
  categoryFilter.innerHTML = `<option value="">All categories</option>${categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(categoryLabel(c))}</option>`).join('')}`;
  busFilter.value = selectedBus;
  categoryFilter.value = selectedCategory;
  applyFilters({ resetPage: false });
}

[search, busFilter, categoryFilter, fromFilter, throughFilter].forEach((control) => control.addEventListener('input', () => applyFilters()));
document.getElementById('clear-filters').addEventListener('click', () => {
  search.value = busFilter.value = categoryFilter.value = fromFilter.value = throughFilter.value = '';
  applyFilters();
});
document.getElementById('export-csv').addEventListener('click', exportCsv);
document.getElementById('previous-page').addEventListener('click', () => { currentPage--; render(); });
document.getElementById('next-page').addEventListener('click', () => { currentPage++; render(); });

// Pre-select a bus when linked from the bus detail page (history.html?bus=<id>).
const preselect = new URLSearchParams(location.search).get('bus');

await initPage();
autoRefresh(async () => {
  await load();
  if (preselect && busFilter.value !== preselect && [...busFilter.options].some((o) => o.value === preselect)) {
    busFilter.value = preselect;
    applyFilters();
  }
}, { onFirstError: (e) => { results.innerHTML = errorState(`Couldn't load maintenance history: ${e.message}`); } });
