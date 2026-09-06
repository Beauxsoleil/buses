import { fetchActiveSchedules, fetchDefects } from '../api.js';
import { computeUrgency, compareUrgency } from '../urgency.js';
import { initPage, autoRefresh, escapeHtml, formatDate, formatNumber, formatTimestampDate, categoryLabel, titleCase, errorState, emptyState } from '../ui.js';

const content = document.getElementById('content');

function taskRow(rowClass, s, u) {
  return `
    <a class="task-row ${rowClass}" href="bus.html?id=${encodeURIComponent(s.bus_id)}">
      <div class="bus-num">${escapeHtml(s.bus?.bus_number || '\u2014')}</div>
      <div class="task-main">
        <div class="item-name">${escapeHtml(s.item?.name || 'Maintenance item')}</div>
        <div class="item-cat">${escapeHtml(categoryLabel(s.item?.category))}${s.item?.is_regulatory ? ' \u00b7 regulatory' : ''}</div>
      </div>
      <div class="text-dim task-last">Last done: ${s.last_completed_date ? formatDate(s.last_completed_date) : 'never'}</div>
      <div class="due-info"><strong>${escapeHtml(u.label)}</strong>${s.bus?.current_mileage != null ? `${formatNumber(s.bus.current_mileage)} mi now` : ''}</div>
    </a>`;
}

function defectRow(d) {
  const severe = d.severity === 'SAFETY_CRITICAL' || d.severity === 'MAJOR';
  const unsafe = d.is_bus_safe_to_operate === false;
  return `
    <a class="task-row ${severe ? 'overdue' : 'due-today'}${unsafe ? ' unsafe' : ''}" href="bus.html?id=${encodeURIComponent(d.bus_id)}">
      <div class="bus-num">${escapeHtml(d.bus?.bus_number || '\u2014')}</div>
      <div class="task-main">
        <div class="item-name">${escapeHtml(d.description)}</div>
        <div class="item-cat">${escapeHtml(categoryLabel(d.category))} \u00b7 ${escapeHtml(titleCase(d.severity))}</div>
      </div>
      <div class="text-dim task-last">${formatTimestampDate(d.reported_date)} \u00b7 ${escapeHtml(d.reported_by || 'field report')}</div>
      <div class="due-info"><strong>${escapeHtml(titleCase(d.status))}</strong>${unsafe ? '<span class="unsafe-label">Not safe to operate</span>' : ''}</div>
    </a>`;
}

function section(title, rows, emptyMessage, count = rows.length) {
  return `
    <section aria-labelledby="${title.replace(/\W+/g, '-').toLowerCase()}">
      <h2 class="section-heading" id="${title.replace(/\W+/g, '-').toLowerCase()}">${title} <span class="text-dim" style="font-size:.6em;font-family:var(--font-body);font-weight:500">${count}</span></h2>
      ${rows.length ? rows.join('') : emptyState(emptyMessage)}
    </section>`;
}

async function render() {
  const [schedules, defects] = await Promise.all([fetchActiveSchedules(), fetchDefects()]);

  const withUrgency = schedules.map((s) => ({ s, u: computeUrgency(s) })).sort(compareUrgency);
  const overdue = withUrgency.filter((x) => x.u.status === 'overdue');
  const dueToday = withUrgency.filter((x) => x.u.status !== 'overdue' && x.u.daysRemaining === 0);
  // "This week" means a calendar due date within the next 7 days, not the
  // percentage-of-interval flag (which can fire months out on annual items).
  const dueWeek = withUrgency.filter((x) => x.u.status !== 'overdue' && x.u.daysRemaining !== null && x.u.daysRemaining > 0 && x.u.daysRemaining <= 7);
  const mileageSoon = withUrgency.filter((x) => x.u.status === 'due-soon' && (x.u.daysRemaining === null || x.u.daysRemaining > 7));
  const inProgress = defects.filter((d) => d.status === 'IN_PROGRESS');
  const open = defects.filter((d) => d.status !== 'IN_PROGRESS');

  content.innerHTML =
    section('Overdue', overdue.map((x) => taskRow('overdue', x.s, x.u)), 'Nothing overdue.') +
    section('Due today', dueToday.map((x) => taskRow('due-today', x.s, x.u)), 'Nothing due today.') +
    section('Due this week', dueWeek.map((x) => taskRow('due-week', x.s, x.u)), 'Nothing else due in the next 7 days.') +
    section('Approaching by mileage', mileageSoon.map((x) => taskRow('due-week', x.s, x.u)), 'No items close to their mileage limit.') +
    section('Open defects', open.map(defectRow), 'No open defect reports.') +
    section('In progress', inProgress.map(defectRow), 'Nothing currently being worked on.');
}

await initPage();
autoRefresh(render, { onFirstError: (e) => { content.innerHTML = errorState(`Couldn't load today's data: ${e.message}`); } });
