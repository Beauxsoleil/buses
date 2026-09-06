// Admin page: sign-in gate, Add Bus wizard, and the day-to-day write forms.
//
// Security model (see supabase/migrations/0001_admin_access.sql):
//   * The UI only appears after a Supabase Auth sign-in AND is_admin() is
//     true, but that is a convenience. Every write is re-checked by Row
//     Level Security and by the RPCs on the server, so a visitor who edits
//     the JavaScript still cannot change fleet records.
//   * Validation happens twice on purpose: instantly in the browser for a
//     good experience, and again in Postgres as the source of truth.

import {
  getSession, onAuthChange, signInWithPassword, signInWithMagicLink, signOut, isAdmin,
  fetchBuses, fetchBus, fetchMaintenanceItems, fetchSchedulesForBus, fetchDefects,
  createBusWithSchedules, assignSchedules, updateBus, recordMileage, logMaintenance, createDefect, updateDefect,
  countActiveSchedules,
} from '../api.js';
import { BUS_STATUSES, MAINTENANCE_CATEGORIES, DEFECT_SEVERITIES, DEFECT_STATUSES, ADMIN_IDLE_MINUTES, COMPLIANCE_FIELDS } from '../config.js';
import { isoLocal, projectInitialSchedule, validateBusInput, validateMileageReading, computeUrgency, statusLabel } from '../urgency.js';
import { initPage, escapeHtml, escapeAttr, formatDate, formatNumber, formatMoney, categoryLabel, titleCase, vehicleDescription, pluralize } from '../ui.js';

const content = document.getElementById('content');
const params = new URLSearchParams(location.search);
const today = isoLocal(new Date());

let session = null;
let admin = false;
let buses = [];
let items = [];

/* ---------------------------------------------------------------------
 * Small form helpers
 * ------------------------------------------------------------------- */

function field({ name, label, type = 'text', value = '', required = false, hint = '', options = null, placeholder = '', attrs = '', span = '' }) {
  const id = `f-${name}`;
  const control = options
    ? `<select id="${id}" name="${name}" ${required ? 'required' : ''} ${attrs}>${options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${escapeAttr(v)}"${String(v) === String(value) ? ' selected' : ''}>${escapeHtml(l)}</option>`;
    }).join('')}</select>`
    : type === 'textarea'
      ? `<textarea id="${id}" name="${name}" ${required ? 'required' : ''} placeholder="${escapeAttr(placeholder)}" ${attrs}>${escapeHtml(value)}</textarea>`
      : `<input id="${id}" name="${name}" type="${type}" value="${escapeAttr(value ?? '')}" ${required ? 'required' : ''} placeholder="${escapeAttr(placeholder)}" ${attrs}>`;
  return `
    <label class="field ${span}" data-field="${name}">
      <span>${escapeHtml(label)}${required ? ' <b class="required" aria-hidden="true">*</b>' : ''}</span>
      ${control}
      ${hint ? `<small class="hint">${escapeHtml(hint)}</small>` : ''}
      <small class="error" role="alert"></small>
    </label>`;
}

function readForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => { data[key] = typeof value === 'string' ? value.trim() : value; });
  return data;
}

function showErrors(form, errors) {
  form.querySelectorAll('.field').forEach((wrap) => {
    const name = wrap.dataset.field;
    const control = wrap.querySelector('input, select, textarea');
    const message = errors[name];
    wrap.querySelector('.error').textContent = message || '';
    if (control) control.setAttribute('aria-invalid', message ? 'true' : 'false');
  });
  const first = Object.keys(errors)[0];
  if (first) form.querySelector(`[name="${first}"]`)?.focus();
  return Object.keys(errors).length === 0;
}

function notice(kind, html) {
  return `<div class="notice ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${html}</div>`;
}

function setBusy(form, busy) {
  form.querySelectorAll('button, input, select, textarea').forEach((el) => { el.disabled = busy; });
}

// Postgres raises readable messages (see migration); surface them verbatim
// but strip the noisy prefixes PostgREST adds.
function friendlyError(error) {
  const message = error?.message || String(error);
  if (/JWT|expired|not authenticated/i.test(message)) return 'Your session has expired. Please sign in again.';
  if (/row-level security|42501|not authorised/i.test(message)) return 'This account is not allowed to change fleet records. Ask the project owner to add it to admin_users.';
  if (/duplicate key|already exists/i.test(message)) return /bus/i.test(message) ? message : 'That record already exists.';
  return message.replace(/^(error|P0001):\s*/i, '');
}

function nullIfEmpty(value) {
  return value === '' || value === undefined ? null : value;
}

function busOptions() {
  return buses.filter((b) => !['SOLD'].includes(b.status)).map((b) => [b.id, `Bus ${b.bus_number}${b.nickname ? ` \u2013 ${b.nickname}` : ''}${b.status !== 'ACTIVE' ? ` (${titleCase(b.status)})` : ''}`]);
}

/* ---------------------------------------------------------------------
 * Auth gate
 * ------------------------------------------------------------------- */

function renderSignIn(message = '') {
  content.innerHTML = `
    <div class="auth-card panel">
      <p class="eyebrow">Restricted</p>
      <h1>Admin sign-in</h1>
      <p>Fleet records can only be changed by the fleet administrator. The dashboards stay public and read-only.</p>
      ${message}
      <div class="auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true" data-tab="password">Password</button>
        <button type="button" role="tab" aria-selected="false" data-tab="magic">E-mail link</button>
      </div>
      <form id="signin-form" novalidate>
        ${field({ name: 'email', label: 'E-mail', type: 'email', required: true, attrs: 'autocomplete="username" inputmode="email"' })}
        <div data-tab-panel="password">${field({ name: 'password', label: 'Password', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}</div>
        <div class="form-actions"><span></span><button class="button" type="submit" id="signin-button">Sign in</button></div>
      </form>
      <p class="hint" style="margin-top:14px">No account? Accounts are created by the project owner in the Supabase dashboard; there is no self-service sign-up.</p>
    </div>`;

  const form = document.getElementById('signin-form');
  const tabs = content.querySelectorAll('[role="tab"]');
  let mode = 'password';
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    mode = tab.dataset.tab;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    content.querySelector('[data-tab-panel="password"]').hidden = mode !== 'password';
    document.getElementById('signin-button').textContent = mode === 'password' ? 'Sign in' : 'Send sign-in link';
  }));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = readForm(form);
    const errors = {};
    if (!data.email) errors.email = 'Enter your e-mail address.';
    if (mode === 'password' && !data.password) errors.password = 'Enter your password.';
    if (!showErrors(form, errors)) return;
    setBusy(form, true);
    try {
      if (mode === 'password') {
        await signInWithPassword(data.email, data.password);
      } else {
        await signInWithMagicLink(data.email);
        renderSignIn(notice('success', `Check <strong>${escapeHtml(data.email)}</strong> for a sign-in link. It only works for accounts that already exist.`));
      }
    } catch (error) {
      setBusy(form, false);
      renderSignIn(notice('error', escapeHtml(/invalid login/i.test(error.message) ? 'Incorrect e-mail or password.' : friendlyError(error))));
    }
  });
}

function renderNotAdmin() {
  content.innerHTML = `
    <div class="auth-card panel">
      <p class="eyebrow">Restricted</p>
      <h1>Not authorised</h1>
      <p>You are signed in as <strong>${escapeHtml(session.user.email)}</strong>, but this account is not on the fleet administrator list, so it cannot change records.</p>
      ${notice('warning', 'To grant access, the project owner runs <code>supabase/grant-admin.sql</code> with this e-mail address in the Supabase SQL editor.')}
      <div class="form-actions"><a class="button secondary" href="index.html">Back to dashboards</a><button class="button" type="button" id="signout">Sign out</button></div>
    </div>`;
  document.getElementById('signout').addEventListener('click', () => signOut());
}

// Shared shop computers: sign out after a period of inactivity.
function startIdleTimer() {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await signOut();
      renderSignIn(notice('warning', 'You were signed out after 30 minutes of inactivity.'));
    }, ADMIN_IDLE_MINUTES * 60_000);
  };
  ['click', 'keydown', 'touchstart', 'input'].forEach((evt) => document.addEventListener(evt, reset, { passive: true }));
  reset();
}

/* ---------------------------------------------------------------------
 * Admin hub
 * ------------------------------------------------------------------- */

function adminBar() {
  return `
    <div class="admin-bar">
      <span class="who">Signed in as <strong>${escapeHtml(session.user.email)}</strong> \u00b7 administrator</span>
      <span class="group"><a class="button secondary small" href="admin.html">Admin home</a> <button class="button secondary small" type="button" id="signout">Sign out</button></span>
    </div>`;
}

function wireAdminBar() {
  document.getElementById('signout')?.addEventListener('click', () => signOut());
}

function renderHub(flash = '') {
  const unscheduled = buses.filter((b) => b.status === 'ACTIVE' && !(b._scheduleCount > 0));
  content.innerHTML = `
    ${adminBar()}
    ${flash}
    <div class="page-intro"><div><p class="eyebrow">Administration</p><h1>Fleet Admin</h1><p>Add vehicles, record odometer readings, log completed work, and report defects.</p></div></div>
    <div class="action-tiles">
      <a class="action-tile primary" href="admin.html?action=add-bus"><strong>Add a bus</strong><span>Guided setup: vehicle details, starting odometer, and maintenance templates with due dates calculated for you.</span></a>
      <a class="action-tile" href="admin.html?action=mileage"><strong>Update mileage</strong><span>Record today's odometer reading for a bus.</span></a>
      <a class="action-tile" href="admin.html?action=maintenance"><strong>Log maintenance</strong><span>Record completed work and roll the schedule forward.</span></a>
      <a class="action-tile" href="admin.html?action=defect"><strong>Report a defect</strong><span>Log a driver or shop-reported problem.</span></a>
      <a class="action-tile" href="admin.html?action=defects"><strong>Open defects</strong><span>Acknowledge, start, defer or resolve reported issues.</span></a>
      <a class="action-tile" href="admin.html?action=schedules"><strong>Assign templates</strong><span>Add maintenance templates to an existing bus.</span></a>
      <a class="action-tile" href="admin.html?action=edit"><strong>Edit bus details</strong><span>Status, compliance dates, plate, VIN and notes.</span></a>
    </div>
    <section class="panel">
      <div class="panel-title"><h2>Fleet at a glance</h2><span>${pluralize(buses.length, 'bus', 'buses')}</span></div>
      ${unscheduled.length ? notice('warning', `${pluralize(unscheduled.length, 'active bus has', 'active buses have')} no maintenance templates assigned: ${unscheduled.map((b) => `<a href="admin.html?action=schedules&bus=${encodeURIComponent(b.id)}">Bus ${escapeHtml(b.bus_number)}</a>`).join(', ')}. They will not generate any maintenance warnings.`) : ''}
      <div class="bus-picker" style="margin-top:12px">${buses.map((b) => `<a class="button secondary small" href="bus.html?id=${encodeURIComponent(b.id)}">Bus ${escapeHtml(b.bus_number)}${b.status !== 'ACTIVE' ? ` \u00b7 ${titleCase(b.status)}` : ''}</a>`).join('')}</div>
    </section>`;
  wireAdminBar();
}

/* ---------------------------------------------------------------------
 * Add Bus wizard
 * ------------------------------------------------------------------- */

const WIZARD_STEPS = ['Vehicle', 'Odometer', 'Templates', 'Review'];

function wizardState() {
  return {
    step: 0,
    bus: { bus_number: '', nickname: '', vin: '', year: '', make: '', model: '', license_plate: '', status: 'ACTIVE', date_acquired: today, notes: '',
      dot_inspection_due_date: '', insurance_expiration_date: '', registration_expiration_date: '', license_plate_expiration: '' },
    mileage: { current_mileage: '', engine_hours: '', date_recorded: today, notes: '' },
    // Map of item id -> { selected, custom_interval_days, custom_interval_miles, last_completed_date, last_completed_mileage }
    templates: Object.fromEntries(items.map((item) => [item.id, { selected: item.is_regulatory || item.priority === 'CRITICAL' || item.priority === 'HIGH', custom_interval_days: '', custom_interval_miles: '', last_completed_date: '', last_completed_mileage: '' }])),
    search: '',
  };
}

function stepsNav(current) {
  return `<ol class="wizard-steps" aria-label="Wizard progress">${WIZARD_STEPS.map((label, i) => `<li class="${i < current ? 'done' : i === current ? 'current' : ''}"${i === current ? ' aria-current="step"' : ''}>${label}</li>`).join('')}</ol>`;
}

function renderWizard(state = wizardState(), flash = '') {
  const render = (extra = '') => renderWizard(state, extra);

  const shell = (body) => {
    content.innerHTML = `${adminBar()}
      <div class="admin-shell">
        <div class="page-intro"><div><p class="eyebrow">Add Bus wizard</p><h1>New vehicle</h1></div><a class="button secondary small" href="admin.html">Cancel</a></div>
        ${stepsNav(state.step)}
        ${flash}
        <section class="panel wizard-panel">${body}</section>
      </div>`;
    wireAdminBar();
  };

  // ---- Step 1: vehicle -------------------------------------------------
  if (state.step === 0) {
    const b = state.bus;
    shell(`
      <h2>Vehicle details</h2>
      <p>Only the bus number is required now; everything else can be added later from "Edit bus details".</p>
      <form id="step-form" novalidate>
        <div class="form-grid">
          ${field({ name: 'bus_number', label: 'Bus number', value: b.bus_number, required: true, hint: 'Must be unique across the fleet.', attrs: 'autocomplete="off" autofocus maxlength="20"' })}
          ${field({ name: 'nickname', label: 'Nickname', value: b.nickname, placeholder: 'e.g. Big Blue' })}
          ${field({ name: 'status', label: 'Status', value: b.status, options: BUS_STATUSES.map((s) => [s, titleCase(s)]) })}
          ${field({ name: 'year', label: 'Year', type: 'number', value: b.year, attrs: 'min="1950" max="2100" inputmode="numeric"' })}
          ${field({ name: 'make', label: 'Make', value: b.make, placeholder: 'Blue Bird, Thomas Built, IC Bus\u2026' })}
          ${field({ name: 'model', label: 'Model', value: b.model, placeholder: 'Vision, Saf-T-Liner C2\u2026' })}
          ${field({ name: 'vin', label: 'VIN', value: b.vin, hint: '17 characters; no I, O or Q.', attrs: 'maxlength="17" autocapitalize="characters" spellcheck="false"' })}
          ${field({ name: 'license_plate', label: 'License plate', value: b.license_plate, attrs: 'autocapitalize="characters"' })}
          ${field({ name: 'date_acquired', label: 'Date acquired', type: 'date', value: b.date_acquired })}
          ${field({ name: 'dot_inspection_due_date', label: 'DOT inspection due', type: 'date', value: b.dot_inspection_due_date })}
          ${field({ name: 'insurance_expiration_date', label: 'Insurance expires', type: 'date', value: b.insurance_expiration_date })}
          ${field({ name: 'registration_expiration_date', label: 'Registration expires', type: 'date', value: b.registration_expiration_date })}
          ${field({ name: 'license_plate_expiration', label: 'Plate expires', type: 'date', value: b.license_plate_expiration })}
          ${field({ name: 'notes', label: 'Notes', type: 'textarea', value: b.notes, span: 'span-all' })}
        </div>
        <div class="form-actions"><span></span><button class="button" type="submit">Next: odometer \u2192</button></div>
      </form>`);
    const form = document.getElementById('step-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      state.bus = { ...state.bus, ...readForm(form) };
      const errors = validateBusInput({ ...state.bus, current_mileage: 0 }, { existingNumbers: buses.map((x) => x.bus_number) });
      delete errors.current_mileage;
      if (!showErrors(form, errors)) return;
      state.step = 1;
      render();
    });
    return;
  }

  // ---- Step 2: odometer ------------------------------------------------
  if (state.step === 1) {
    const m = state.mileage;
    shell(`
      <h2>Starting odometer</h2>
      <p>This becomes the first entry in the mileage log for Bus ${escapeHtml(state.bus.bus_number)} and the baseline for every mileage-based interval.</p>
      <form id="step-form" novalidate>
        <div class="form-grid">
          ${field({ name: 'current_mileage', label: 'Odometer (miles)', type: 'number', value: m.current_mileage, required: true, hint: 'Use 0 for a brand-new vehicle.', attrs: 'min="0" step="1" inputmode="numeric" autofocus' })}
          ${field({ name: 'engine_hours', label: 'Engine hours', type: 'number', value: m.engine_hours, hint: 'Optional; only if the bus tracks hours.', attrs: 'min="0" step="0.1" inputmode="decimal"' })}
          ${field({ name: 'date_recorded', label: 'Reading date', type: 'date', value: m.date_recorded, required: true, attrs: `max="${today}"` })}
          ${field({ name: 'notes', label: 'Reading note', value: m.notes, placeholder: 'e.g. Delivery odometer', span: 'span-2' })}
        </div>
        <div class="form-actions"><button class="button secondary" type="button" id="back">\u2190 Back</button><button class="button" type="submit">Next: templates \u2192</button></div>
      </form>`);
    const form = document.getElementById('step-form');
    document.getElementById('back').addEventListener('click', () => { state.mileage = { ...state.mileage, ...readForm(form) }; state.step = 0; render(); });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      state.mileage = { ...state.mileage, ...readForm(form) };
      const errors = validateMileageReading({ mileage: state.mileage.current_mileage, dateRecorded: state.mileage.date_recorded });
      if (errors.mileage) { errors.current_mileage = errors.mileage; delete errors.mileage; }
      if (!state.mileage.date_recorded) errors.date_recorded = 'Enter the reading date.';
      const busErrors = validateBusInput({ ...state.bus, current_mileage: state.mileage.current_mileage, engine_hours: state.mileage.engine_hours });
      if (busErrors.engine_hours) errors.engine_hours = busErrors.engine_hours;
      if (!showErrors(form, errors)) return;
      state.step = 2;
      render();
    });
    return;
  }

  // ---- Step 3: templates -----------------------------------------------
  if (state.step === 2) {
    const term = state.search.toLowerCase();
    const visible = items.filter((item) => !term || `${item.name} ${item.category}`.toLowerCase().includes(term));
    const groups = new Map();
    visible.forEach((item) => groups.set(item.category, [...(groups.get(item.category) || []), item]));
    const selectedCount = Object.values(state.templates).filter((t) => t.selected).length;

    const intervalText = (item) => [item.default_interval_days ? `every ${item.default_interval_days} days` : null, item.default_interval_miles ? `every ${formatNumber(item.default_interval_miles)} mi` : null, item.default_interval_engine_hours ? `every ${formatNumber(item.default_interval_engine_hours)} hr` : null].filter(Boolean).join(' or ') || 'no default interval';

    shell(`
      <h2>Maintenance templates</h2>
      <p>Tick every template that applies to this bus. Regulatory and high-priority templates are pre-selected. If some work was done recently, enter when so the first due date is not too early.</p>
      <div class="template-toolbar" data-no-swipe>
        <input type="search" id="template-search" placeholder="Filter templates\u2026" value="${escapeAttr(state.search)}" aria-label="Filter templates">
        <button class="button secondary small" type="button" data-bulk="all">Select all</button>
        <button class="button secondary small" type="button" data-bulk="regulatory">Regulatory only</button>
        <button class="button secondary small" type="button" data-bulk="none">Clear</button>
        <span class="text-dim" style="font-size:13px">${selectedCount} selected</span>
      </div>
      <form id="step-form" novalidate>
        ${[...groups.entries()].map(([category, list]) => `
          <div class="template-group">
            <h3>${escapeHtml(categoryLabel(category))}</h3>
            ${list.map((item) => {
              const t = state.templates[item.id];
              return `
                <div class="template-row${t.selected ? ' selected' : ''}" data-item="${item.id}">
                  <input type="checkbox" name="sel-${item.id}" id="sel-${item.id}" ${t.selected ? 'checked' : ''} aria-label="Assign ${escapeAttr(item.name)}">
                  <label class="name" for="sel-${item.id}">${escapeHtml(item.name)}${item.is_regulatory ? ' <span class="tag regulatory">Regulatory</span>' : ''} <span class="tag">${escapeHtml(item.priority)}</span><span>${escapeHtml(intervalText(item))}</span></label>
                  <div class="interval mini">
                    <span>Custom interval</span>
                    <div style="display:flex;gap:6px">
                      <input type="number" name="days-${item.id}" placeholder="${item.default_interval_days || 'days'}" value="${escapeAttr(t.custom_interval_days)}" min="1" step="1" aria-label="Custom interval in days" ${t.selected ? '' : 'disabled'} style="width:50%">
                      <input type="number" name="miles-${item.id}" placeholder="${item.default_interval_miles || 'miles'}" value="${escapeAttr(t.custom_interval_miles)}" min="1" step="1" aria-label="Custom interval in miles" ${t.selected ? '' : 'disabled'} style="width:50%">
                    </div>
                  </div>
                  <div class="mini"><span>Last done (date)</span><input type="date" name="ldate-${item.id}" value="${escapeAttr(t.last_completed_date)}" max="${today}" ${t.selected ? '' : 'disabled'}></div>
                  <div class="mini"><span>Last done (miles)</span><input type="number" name="lmiles-${item.id}" value="${escapeAttr(t.last_completed_mileage)}" min="0" step="1" max="${escapeAttr(state.mileage.current_mileage)}" inputmode="numeric" ${t.selected ? '' : 'disabled'}></div>
                </div>`;
            }).join('')}
          </div>`).join('') || '<div class="empty-state">No templates match that filter.</div>'}
        <div class="form-actions"><button class="button secondary" type="button" id="back">\u2190 Back</button><button class="button" type="submit">Next: review \u2192</button></div>
      </form>`);

    const form = document.getElementById('step-form');
    const capture = () => {
      const data = readForm(form);
      items.forEach((item) => {
        const t = state.templates[item.id];
        const checkbox = form.querySelector(`[name="sel-${item.id}"]`);
        if (!checkbox) return; // filtered out of view; keep previous state
        t.selected = checkbox.checked;
        t.custom_interval_days = data[`days-${item.id}`] ?? t.custom_interval_days;
        t.custom_interval_miles = data[`miles-${item.id}`] ?? t.custom_interval_miles;
        t.last_completed_date = data[`ldate-${item.id}`] ?? t.last_completed_date;
        t.last_completed_mileage = data[`lmiles-${item.id}`] ?? t.last_completed_mileage;
      });
    };

    form.addEventListener('change', (event) => {
      if (event.target.type === 'checkbox') {
        const row = event.target.closest('.template-row');
        row.classList.toggle('selected', event.target.checked);
        row.querySelectorAll('input:not([type="checkbox"])').forEach((input) => { input.disabled = !event.target.checked; });
        capture();
        content.querySelector('.template-toolbar .text-dim').textContent = `${Object.values(state.templates).filter((t) => t.selected).length} selected`;
      }
    });
    let searchTimer;
    document.getElementById('template-search').addEventListener('input', (event) => {
      capture();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = event.target.value; render(); document.getElementById('template-search')?.focus(); }, 180);
    });
    content.querySelectorAll('[data-bulk]').forEach((button) => button.addEventListener('click', () => {
      capture();
      const mode = button.dataset.bulk;
      items.forEach((item) => { state.templates[item.id].selected = mode === 'all' ? true : mode === 'none' ? false : Boolean(item.is_regulatory); });
      render();
    }));
    document.getElementById('back').addEventListener('click', () => { capture(); state.step = 1; render(); });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      capture();
      const problems = [];
      const odometer = Number(state.mileage.current_mileage);
      items.forEach((item) => {
        const t = state.templates[item.id];
        if (!t.selected) return;
        const days = t.custom_interval_days === '' ? item.default_interval_days : Number(t.custom_interval_days);
        const miles = t.custom_interval_miles === '' ? item.default_interval_miles : Number(t.custom_interval_miles);
        if (!days && !miles && !item.default_interval_engine_hours) problems.push(`${item.name}: set a custom interval (it has no default).`);
        if (t.custom_interval_days !== '' && !(Number(t.custom_interval_days) > 0)) problems.push(`${item.name}: interval days must be a positive number.`);
        if (t.custom_interval_miles !== '' && !(Number(t.custom_interval_miles) > 0)) problems.push(`${item.name}: interval miles must be a positive number.`);
        if (t.last_completed_date && t.last_completed_date > today) problems.push(`${item.name}: last-done date cannot be in the future.`);
        if (t.last_completed_mileage !== '' && Number(t.last_completed_mileage) > odometer) problems.push(`${item.name}: last-done mileage is above the starting odometer (${formatNumber(odometer)} mi).`);
      });
      if (problems.length) { render(notice('error', `<strong>Please fix:</strong><ul style="margin:6px 0 0 18px">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`)); return; }
      state.step = 3;
      render();
    });
    return;
  }

  // ---- Step 4: review + submit ----------------------------------------
  const projections = items.filter((item) => state.templates[item.id].selected).map((item) => {
    const t = state.templates[item.id];
    const projection = projectInitialSchedule({
      item,
      startDate: state.mileage.date_recorded,
      startMileage: Number(state.mileage.current_mileage),
      startEngineHours: state.mileage.engine_hours === '' ? null : Number(state.mileage.engine_hours),
      lastCompletedDate: t.last_completed_date || null,
      lastCompletedMileage: t.last_completed_mileage === '' ? null : Number(t.last_completed_mileage),
      customIntervalDays: t.custom_interval_days === '' ? null : Number(t.custom_interval_days),
      customIntervalMiles: t.custom_interval_miles === '' ? null : Number(t.custom_interval_miles),
    });
    const urgency = computeUrgency({ ...projection, item, bus: { current_mileage: Number(state.mileage.current_mileage), engine_hours: state.mileage.engine_hours === '' ? null : Number(state.mileage.engine_hours) } });
    return { item, projection, urgency };
  });
  const b = state.bus;
  const m = state.mileage;

  shell(`
    <h2>Review and create</h2>
    <p>Everything below is saved in a single transaction: the bus, its first odometer reading, and ${pluralize(projections.length, 'maintenance schedule')}. If anything is rejected, nothing is saved.</p>
    <div class="review-grid">
      <div class="review-card"><h3>Bus ${escapeHtml(b.bus_number)}</h3><dl>
        <dt>Vehicle</dt><dd>${escapeHtml(vehicleDescription(b) || '\u2014')}</dd>
        <dt>Nickname</dt><dd>${escapeHtml(b.nickname || '\u2014')}</dd>
        <dt>Status</dt><dd>${escapeHtml(titleCase(b.status))}</dd>
        <dt>VIN</dt><dd>${escapeHtml(b.vin ? b.vin.toUpperCase() : '\u2014')}</dd>
        <dt>Plate</dt><dd>${escapeHtml(b.license_plate ? b.license_plate.toUpperCase() : '\u2014')}${b.license_plate_expiration ? ` (exp. ${formatDate(b.license_plate_expiration)})` : ''}</dd>
        <dt>Acquired</dt><dd>${formatDate(b.date_acquired)}</dd>
      </dl></div>
      <div class="review-card"><h3>Compliance dates</h3><dl>
        ${COMPLIANCE_FIELDS.map(([f, label]) => `<dt>${escapeHtml(label)}</dt><dd>${formatDate(b[f])}</dd>`).join('')}
      </dl></div>
      <div class="review-card"><h3>Starting odometer</h3><dl>
        <dt>Reading</dt><dd>${formatNumber(m.current_mileage)} mi${m.engine_hours ? ` \u00b7 ${formatNumber(m.engine_hours)} hr` : ''}</dd>
        <dt>Date</dt><dd>${formatDate(m.date_recorded)}</dd>
        <dt>Note</dt><dd>${escapeHtml(m.notes || 'Starting odometer when added to fleet')}</dd>
      </dl></div>
    </div>
    <h3 style="margin:0 0 8px;font-family:var(--font-display);font-size:20px">Initial schedule</h3>
    ${projections.length ? projections.map(({ item, projection, urgency }) => `
      <div class="review-schedule status-${urgency.status}">
        <span class="dot status-${urgency.status}" role="img" aria-label="${escapeAttr(statusLabel(urgency.status))}"></span>
        <span><strong>${escapeHtml(item.name)}</strong><br><span class="muted">${escapeHtml(categoryLabel(item.category))}${projection.custom_interval_days || projection.custom_interval_miles ? ' \u00b7 custom interval' : ''}</span></span>
        <span>${projection.next_due_date ? `Due ${formatDate(projection.next_due_date)}` : '<span class="muted">No calendar date</span>'}</span>
        <span>${projection.next_due_mileage != null ? `at ${formatNumber(projection.next_due_mileage)} mi` : '<span class="muted">No mileage trigger</span>'}</span>
        <span class="muted">${projection.last_completed_date ? `last ${formatDate(projection.last_completed_date)}` : 'never done'}</span>
      </div>`).join('') : notice('warning', 'No templates selected. The bus will appear on the dashboards but will not generate any maintenance warnings until templates are assigned.')}
    <form id="step-form" novalidate>
      <div class="form-actions"><button class="button secondary" type="button" id="back">\u2190 Back</button><button class="button" type="submit" id="create">Create Bus ${escapeHtml(b.bus_number)}</button></div>
    </form>`);

  document.getElementById('back').addEventListener('click', () => { state.step = 2; render(); });
  const form = document.getElementById('step-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(form, true);
    document.getElementById('create').textContent = 'Creating\u2026';
    try {
      const result = await createBusWithSchedules({
        bus: { ...b, current_mileage: Number(m.current_mileage), engine_hours: nullIfEmpty(m.engine_hours) },
        mileage: { date_recorded: `${m.date_recorded}T12:00:00`, notes: nullIfEmpty(m.notes) },
        schedules: projections.map(({ projection }) => projection),
      });
      const created = result.bus;
      content.innerHTML = `${adminBar()}
        <div class="admin-shell"><section class="panel success-panel">
          <p class="eyebrow">Done</p>
          <h2>Bus ${escapeHtml(created.bus_number)} added</h2>
          <p>${pluralize(result.schedules, 'maintenance schedule')} created. It is already visible on the Fleet Overview.</p>
          <div class="group">
            <a class="button" href="bus.html?id=${encodeURIComponent(created.id)}">Open Bus ${escapeHtml(created.bus_number)}</a>
            <a class="button secondary" href="admin.html?action=add-bus">Add another bus</a>
            <a class="button secondary" href="admin.html">Admin home</a>
          </div>
        </section></div>`;
      wireAdminBar();
    } catch (error) {
      setBusy(form, false);
      document.getElementById('create').textContent = `Create Bus ${b.bus_number}`;
      render(notice('error', `<strong>Not saved.</strong> ${escapeHtml(friendlyError(error))}`));
    }
  });
}

/* ---------------------------------------------------------------------
 * Simple forms
 * ------------------------------------------------------------------- */

function formPage({ eyebrow, title, intro, body, submitLabel, onSubmit, flash = '' }) {
  content.innerHTML = `${adminBar()}
    <div class="admin-shell">
      <div class="page-intro"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1>${intro ? `<p>${intro}</p>` : ''}</div><a class="button secondary small" href="admin.html">Admin home</a></div>
      ${flash}
      <section class="panel"><form id="form" novalidate>${body}<div class="form-actions"><span></span><button class="button" type="submit">${escapeHtml(submitLabel)}</button></div></form></section>
    </div>`;
  wireAdminBar();
  const form = document.getElementById('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = readForm(form);
    setBusy(form, true);
    try {
      await onSubmit(data, form);
    } catch (error) {
      setBusy(form, false);
      form.insertAdjacentHTML('afterbegin', notice('error', `<strong>Not saved.</strong> ${escapeHtml(friendlyError(error))}`));
      form.querySelector('.notice')?.scrollIntoView({ block: 'nearest' });
    }
  });
  return form;
}

function selectedBusId() {
  const id = params.get('bus');
  return buses.some((b) => b.id === id) ? id : (buses.find((b) => b.status === 'ACTIVE') || buses[0])?.id || '';
}

function busSwitcher(form, onChange) {
  form.querySelector('[name="bus_id"]').addEventListener('change', (event) => {
    const url = new URL(location.href);
    url.searchParams.set('bus', event.target.value);
    history.replaceState(null, '', url);
    params.set('bus', event.target.value);
    onChange?.(event.target.value);
  });
}

function renderMileageForm(flash = '') {
  const busId = selectedBusId();
  const bus = buses.find((b) => b.id === busId);
  const form = formPage({
    eyebrow: 'Odometer', title: 'Update mileage', flash,
    intro: bus ? `Bus ${escapeHtml(bus.bus_number)} is currently at <strong>${formatNumber(bus.current_mileage)} mi</strong>${bus.engine_hours != null ? ` and ${formatNumber(bus.engine_hours)} hr` : ''}. Readings can only go up.` : '',
    body: `<div class="form-grid">
      ${field({ name: 'bus_id', label: 'Bus', value: busId, required: true, options: busOptions() })}
      ${field({ name: 'mileage', label: 'Odometer (miles)', type: 'number', required: true, attrs: `min="${bus?.current_mileage ?? 0}" step="1" inputmode="numeric" autofocus`, hint: bus ? `Not lower than ${formatNumber(bus.current_mileage)}.` : '' })}
      ${field({ name: 'engine_hours', label: 'Engine hours', type: 'number', value: '', attrs: 'min="0" step="0.1" inputmode="decimal"' })}
      ${field({ name: 'date_recorded', label: 'Reading date', type: 'date', value: today, required: true, attrs: `max="${today}"` })}
      ${field({ name: 'notes', label: 'Note', placeholder: 'e.g. Friday fuel-up', span: 'span-2' })}
    </div>`,
    submitLabel: 'Save reading',
    onSubmit: async (data) => {
      const target = buses.find((b) => b.id === data.bus_id);
      const errors = validateMileageReading({ mileage: data.mileage, currentMileage: target?.current_mileage, dateRecorded: data.date_recorded });
      if (!showErrors(form, errors)) { setBusy(form, false); return; }
      const dateRecorded = data.date_recorded === today ? new Date().toISOString() : `${data.date_recorded}T12:00:00`;
      const updated = await recordMileage({ busId: data.bus_id, mileage: Number(data.mileage), engineHours: data.engine_hours ? Number(data.engine_hours) : null, dateRecorded, notes: nullIfEmpty(data.notes) });
      buses = buses.map((b) => (b.id === updated.id ? updated : b));
      renderMileageForm(notice('success', `Saved. Bus ${escapeHtml(updated.bus_number)} is now at <strong>${formatNumber(updated.current_mileage)} mi</strong>. <a href="bus.html?id=${encodeURIComponent(updated.id)}">View bus \u2192</a>`));
    },
  });
  busSwitcher(form, () => renderMileageForm());
}

async function renderMaintenanceForm(flash = '') {
  const busId = selectedBusId();
  const bus = buses.find((b) => b.id === busId);
  const schedules = busId ? await fetchSchedulesForBus(busId).catch(() => []) : [];
  const scheduleOptions = [['', 'Unscheduled repair / other work'], ...schedules.map((s) => {
    const u = computeUrgency(s);
    return [s.id, `${s.item?.name || 'Item'} \u2014 ${u.label}`];
  })];
  const form = formPage({
    eyebrow: 'Completed work', title: 'Log maintenance', flash,
    intro: bus ? `Recording work on Bus ${escapeHtml(bus.bus_number)} (${formatNumber(bus.current_mileage)} mi). Choosing a scheduled item rolls its next due date and mileage forward automatically.` : '',
    body: `<div class="form-grid">
      ${field({ name: 'bus_id', label: 'Bus', value: busId, required: true, options: busOptions() })}
      ${field({ name: 'bus_maintenance_schedule_id', label: 'Scheduled item', value: params.get('schedule') || '', options: scheduleOptions, span: 'span-2' })}
      ${field({ name: 'date_performed', label: 'Date performed', type: 'date', value: today, required: true, attrs: `max="${today}"` })}
      ${field({ name: 'mileage_at_service', label: 'Mileage at service', type: 'number', value: bus?.current_mileage ?? '', attrs: 'min="0" step="1" inputmode="numeric"', hint: 'A higher value also updates the odometer.' })}
      ${field({ name: 'performed_by', label: 'Performed by', placeholder: 'Technician or shop' })}
      ${field({ name: 'vendor', label: 'Vendor', placeholder: 'In-house or vendor name' })}
      ${field({ name: 'work_order_number', label: 'Work order #' })}
      ${field({ name: 'parts_cost', label: 'Parts cost ($)', type: 'number', attrs: 'min="0" step="0.01" inputmode="decimal"' })}
      ${field({ name: 'labor_cost', label: 'Labor cost ($)', type: 'number', attrs: 'min="0" step="0.01" inputmode="decimal"' })}
      ${field({ name: 'cost', label: 'Total cost ($)', type: 'number', attrs: 'min="0" step="0.01" inputmode="decimal"', hint: 'Leave blank to use parts + labor.' })}
      ${field({ name: 'description', label: 'Work performed', type: 'textarea', span: 'span-all', placeholder: 'What was done, parts replaced, findings\u2026' })}
      ${field({ name: 'notes', label: 'Internal notes', type: 'textarea', span: 'span-all' })}
    </div>`,
    submitLabel: 'Save maintenance log',
    onSubmit: async (data) => {
      const errors = {};
      if (!data.date_performed) errors.date_performed = 'Enter the service date.';
      else if (data.date_performed > today) errors.date_performed = 'Service date cannot be in the future.';
      if (data.mileage_at_service && (!Number.isInteger(Number(data.mileage_at_service)) || Number(data.mileage_at_service) < 0)) errors.mileage_at_service = 'Enter a whole number of miles.';
      if (!data.bus_maintenance_schedule_id && !data.description) errors.description = 'Describe the work for an unscheduled repair.';
      if (!showErrors(form, errors)) { setBusy(form, false); return; }
      const sched = schedules.find((s) => s.id === data.bus_maintenance_schedule_id);
      const log = await logMaintenance({
        ...data,
        maintenance_item_id: sched?.maintenance_item_id || null,
        bus_maintenance_schedule_id: nullIfEmpty(data.bus_maintenance_schedule_id),
        mileage_at_service: nullIfEmpty(data.mileage_at_service),
        parts_cost: nullIfEmpty(data.parts_cost), labor_cost: nullIfEmpty(data.labor_cost), cost: nullIfEmpty(data.cost),
      });
      buses = await fetchBuses();
      renderMaintenanceForm(notice('success', `Logged ${escapeHtml(sched?.item?.name || 'unscheduled work')} on Bus ${escapeHtml(bus?.bus_number || '')} for ${formatMoney(log.cost)}${log.next_due_date ? `; next due ${formatDate(log.next_due_date)}` : ''}. <a href="bus.html?id=${encodeURIComponent(data.bus_id)}">View bus \u2192</a>`));
    },
  });
  busSwitcher(form, () => renderMaintenanceForm());
}

function renderDefectForm(flash = '') {
  const busId = selectedBusId();
  const form = formPage({
    eyebrow: 'Defects', title: 'Report a defect', flash,
    intro: 'Safety-critical defects and "not safe to operate" flags appear on the Today board immediately.',
    body: `<div class="form-grid">
      ${field({ name: 'bus_id', label: 'Bus', value: busId, required: true, options: busOptions() })}
      ${field({ name: 'category', label: 'Category', value: 'OTHER', options: MAINTENANCE_CATEGORIES.map((c) => [c, categoryLabel(c)]) })}
      ${field({ name: 'severity', label: 'Severity', value: 'MINOR', options: DEFECT_SEVERITIES.map((s) => [s, titleCase(s)]) })}
      ${field({ name: 'reported_by', label: 'Reported by', placeholder: 'Driver or technician name' })}
      ${field({ name: 'is_bus_safe_to_operate', label: 'Safe to operate?', value: 'true', options: [['true', 'Yes \u2014 bus can stay in service'], ['false', 'No \u2014 take out of service']] })}
      ${field({ name: 'description', label: 'Description', type: 'textarea', required: true, span: 'span-all', placeholder: 'What is wrong, where, and when it was noticed' })}
    </div>`,
    submitLabel: 'Submit defect report',
    onSubmit: async (data) => {
      const errors = {};
      if (!data.description) errors.description = 'Describe the defect.';
      if (!showErrors(form, errors)) { setBusy(form, false); return; }
      const defect = await createDefect({
        bus_id: data.bus_id, category: data.category, severity: data.severity, description: data.description,
        reported_by: nullIfEmpty(data.reported_by), is_bus_safe_to_operate: data.is_bus_safe_to_operate === 'true', status: 'REPORTED',
      });
      const bus = buses.find((b) => b.id === defect.bus_id);
      renderDefectForm(notice('success', `Defect reported on Bus ${escapeHtml(bus?.bus_number || '')}. <a href="admin.html?action=defects">Manage open defects \u2192</a>`));
    },
  });
  busSwitcher(form);
}

async function renderDefectList(flash = '') {
  const defects = await fetchDefects({ status: DEFECT_STATUSES.filter((s) => s !== 'RESOLVED') });
  content.innerHTML = `${adminBar()}
    <div class="admin-shell">
      <div class="page-intro"><div><p class="eyebrow">Defects</p><h1>Open defects</h1><p>${pluralize(defects.length, 'open report')}. Resolving a defect records who fixed it and when.</p></div><a class="button secondary small" href="admin.html">Admin home</a></div>
      ${flash}
      ${defects.map((d) => `
        <form class="panel" data-defect="${d.id}" style="margin-bottom:12px" novalidate>
          <div class="panel-title"><h2 style="font-size:22px">Bus ${escapeHtml(d.bus?.bus_number || '?')} \u00b7 ${escapeHtml(d.description)}</h2><span>${escapeHtml(titleCase(d.severity))} \u00b7 ${escapeHtml(categoryLabel(d.category))} \u00b7 ${formatDate(String(d.reported_date).slice(0, 10))}${d.is_bus_safe_to_operate === false ? ' \u00b7 <strong style="color:var(--overdue)">NOT SAFE</strong>' : ''}</span></div>
          <div class="form-grid" style="margin-top:12px">
            ${field({ name: 'status', label: 'Status', value: d.status, options: DEFECT_STATUSES.map((s) => [s, titleCase(s)]) })}
            ${field({ name: 'is_bus_safe_to_operate', label: 'Safe to operate?', value: String(d.is_bus_safe_to_operate !== false), options: [['true', 'Yes'], ['false', 'No']] })}
            ${field({ name: 'resolved_by', label: 'Resolved by', value: d.resolved_by || '' })}
            ${field({ name: 'resolution_description', label: 'Resolution', value: d.resolution_description || '', span: 'span-2' })}
          </div>
          <div class="form-actions"><span></span><button class="button" type="submit">Save</button></div>
        </form>`).join('') || '<div class="empty-state large">No open defects.</div>'}
    </div>`;
  wireAdminBar();
  content.querySelectorAll('form[data-defect]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = readForm(form);
    if (data.status === 'RESOLVED' && !data.resolution_description) { showErrors(form, { resolution_description: 'Describe how it was resolved.' }); return; }
    setBusy(form, true);
    try {
      await updateDefect(form.dataset.defect, {
        status: data.status,
        is_bus_safe_to_operate: data.is_bus_safe_to_operate === 'true',
        resolved_by: nullIfEmpty(data.resolved_by),
        resolution_description: nullIfEmpty(data.resolution_description),
        resolved_date: data.status === 'RESOLVED' ? new Date().toISOString() : null,
      });
      renderDefectList(notice('success', 'Defect updated.'));
    } catch (error) {
      setBusy(form, false);
      form.insertAdjacentHTML('afterbegin', notice('error', escapeHtml(friendlyError(error))));
    }
  }));
}

async function renderEditForm(flash = '') {
  const busId = selectedBusId();
  const bus = busId ? await fetchBus(busId) : null;
  if (!bus) { renderHub(notice('warning', 'Add a bus first.')); return; }
  const form = formPage({
    eyebrow: 'Vehicle record', title: `Edit Bus ${bus.bus_number}`, flash,
    intro: 'Odometer readings are changed from "Update mileage" so the history stays consistent.',
    body: `<div class="form-grid">
      ${field({ name: 'bus_id', label: 'Bus', value: busId, options: busOptions() })}
      ${field({ name: 'bus_number', label: 'Bus number', value: bus.bus_number, required: true, attrs: 'maxlength="20"' })}
      ${field({ name: 'nickname', label: 'Nickname', value: bus.nickname || '' })}
      ${field({ name: 'status', label: 'Status', value: bus.status, options: BUS_STATUSES.map((s) => [s, titleCase(s)]) })}
      ${field({ name: 'year', label: 'Year', type: 'number', value: bus.year ?? '', attrs: 'min="1950" max="2100"' })}
      ${field({ name: 'make', label: 'Make', value: bus.make || '' })}
      ${field({ name: 'model', label: 'Model', value: bus.model || '' })}
      ${field({ name: 'vin', label: 'VIN', value: bus.vin || '', attrs: 'maxlength="17" autocapitalize="characters" spellcheck="false"' })}
      ${field({ name: 'license_plate', label: 'License plate', value: bus.license_plate || '' })}
      ${field({ name: 'date_acquired', label: 'Date acquired', type: 'date', value: bus.date_acquired || '' })}
      ${COMPLIANCE_FIELDS.map(([f, label]) => field({ name: f, label, type: 'date', value: bus[f] || '' })).join('')}
      ${field({ name: 'notes', label: 'Notes', type: 'textarea', value: bus.notes || '', span: 'span-all' })}
    </div>`,
    submitLabel: 'Save changes',
    onSubmit: async (data) => {
      const errors = validateBusInput({ ...data, current_mileage: bus.current_mileage }, { existingNumbers: buses.filter((b) => b.id !== bus.id).map((b) => b.bus_number) });
      if (!showErrors(form, errors)) { setBusy(form, false); return; }
      const patch = {};
      ['bus_number', 'nickname', 'status', 'year', 'make', 'model', 'vin', 'license_plate', 'date_acquired', 'notes', ...COMPLIANCE_FIELDS.map(([f]) => f)].forEach((key) => { patch[key] = nullIfEmpty(data[key]); });
      patch.year = patch.year === null ? null : Number(patch.year);
      const updated = await updateBus(bus.id, patch);
      buses = buses.map((b) => (b.id === updated.id ? updated : b));
      renderEditForm(notice('success', `Bus ${escapeHtml(updated.bus_number)} saved. <a href="bus.html?id=${encodeURIComponent(updated.id)}">View bus \u2192</a>`));
    },
  });
  busSwitcher(form, () => renderEditForm());
}

async function renderAssignForm(flash = '') {
  const busId = selectedBusId();
  const bus = buses.find((b) => b.id === busId);
  if (!bus) { renderHub(notice('warning', 'Add a bus first.')); return; }
  const existing = await fetchSchedulesForBus(busId);
  const assigned = new Set(existing.map((s) => s.maintenance_item_id));
  const available = items.filter((item) => !assigned.has(item.id));
  const form = formPage({
    eyebrow: 'Maintenance templates', title: `Assign templates to Bus ${bus.bus_number}`, flash,
    intro: `${pluralize(existing.length, 'template')} already assigned. New ones start one interval from today / ${formatNumber(bus.current_mileage)} mi unless you enter when the work was last done.`,
    body: `<div class="form-grid" style="margin-bottom:16px">${field({ name: 'bus_id', label: 'Bus', value: busId, options: busOptions() })}</div>
      ${available.map((item) => `
        <div class="template-row" data-item="${item.id}">
          <input type="checkbox" name="sel-${item.id}" id="sel-${item.id}" aria-label="Assign ${escapeAttr(item.name)}">
          <label class="name" for="sel-${item.id}">${escapeHtml(item.name)}${item.is_regulatory ? ' <span class="tag regulatory">Regulatory</span>' : ''}<span>${[item.default_interval_days ? `every ${item.default_interval_days} days` : null, item.default_interval_miles ? `every ${formatNumber(item.default_interval_miles)} mi` : null].filter(Boolean).join(' or ') || 'no default interval'}</span></label>
          <div class="interval mini"><span>Custom interval</span><div style="display:flex;gap:6px"><input type="number" name="days-${item.id}" placeholder="${item.default_interval_days || 'days'}" min="1" step="1" aria-label="Custom interval days" disabled style="width:50%"><input type="number" name="miles-${item.id}" placeholder="${item.default_interval_miles || 'miles'}" min="1" step="1" aria-label="Custom interval miles" disabled style="width:50%"></div></div>
          <div class="mini"><span>Last done (date)</span><input type="date" name="ldate-${item.id}" max="${today}" disabled></div>
          <div class="mini"><span>Last done (miles)</span><input type="number" name="lmiles-${item.id}" min="0" step="1" max="${bus.current_mileage}" disabled></div>
        </div>`).join('') || '<div class="empty-state">Every active template is already assigned to this bus.</div>'}`,
    submitLabel: 'Assign selected templates',
    onSubmit: async (data) => {
      const selected = available.filter((item) => data[`sel-${item.id}`] === 'on');
      if (!selected.length) { setBusy(form, false); form.insertAdjacentHTML('afterbegin', notice('warning', 'Tick at least one template.')); return; }
      const payload = selected.map((item) => ({
        maintenance_item_id: item.id,
        custom_interval_days: nullIfEmpty(data[`days-${item.id}`]),
        custom_interval_miles: nullIfEmpty(data[`miles-${item.id}`]),
        last_completed_date: nullIfEmpty(data[`ldate-${item.id}`]),
        last_completed_mileage: nullIfEmpty(data[`lmiles-${item.id}`]),
      }));
      const rows = await assignSchedules(busId, payload);
      renderAssignForm(notice('success', `${pluralize(rows.length, 'template')} assigned to Bus ${escapeHtml(bus.bus_number)}. <a href="bus.html?id=${encodeURIComponent(busId)}">View bus \u2192</a>`));
    },
  });
  form.addEventListener('change', (event) => {
    if (event.target.type !== 'checkbox') return;
    const row = event.target.closest('.template-row');
    row.classList.toggle('selected', event.target.checked);
    row.querySelectorAll('input:not([type="checkbox"])').forEach((input) => { input.disabled = !event.target.checked; });
  });
  busSwitcher(form, () => renderAssignForm());
}

/* ---------------------------------------------------------------------
 * Router
 * ------------------------------------------------------------------- */

async function renderAdmin() {
  content.innerHTML = '<div class="empty-state">Loading fleet data\u2026</div>';
  try {
    [buses, items] = await Promise.all([fetchBuses(), fetchMaintenanceItems()]);
    // Count schedules per bus for the "no templates" warning on the hub.
    const tally = await countActiveSchedules();
    buses.forEach((b) => { b._scheduleCount = tally.get(b.id) || 0; });
  } catch (error) {
    content.innerHTML = notice('error', escapeHtml(friendlyError(error)));
    return;
  }

  const action = params.get('action') || '';
  switch (action) {
    case 'add-bus': renderWizard(); break;
    case 'mileage': renderMileageForm(); break;
    case 'maintenance': await renderMaintenanceForm(); break;
    case 'defect': renderDefectForm(); break;
    case 'defects': await renderDefectList(); break;
    case 'edit': await renderEditForm(); break;
    case 'schedules': await renderAssignForm(); break;
    case 'status': await renderEditForm(); break;
    default: renderHub();
  }
}

async function gate() {
  session = await getSession().catch(() => null);
  if (!session) { renderSignIn(); return; }
  try {
    admin = await isAdmin();
  } catch (error) {
    renderSignIn(notice('error', `Could not verify admin access: ${escapeHtml(friendlyError(error))}. Has <code>supabase/migrations/0001_admin_access.sql</code> been applied?`));
    return;
  }
  if (!admin) { renderNotAdmin(); return; }
  startIdleTimer();
  await renderAdmin();
}

await initPage({ navigation: false });
onAuthChange((next) => {
  const changed = Boolean(next) !== Boolean(session) || next?.user?.id !== session?.user?.id;
  session = next;
  if (changed) gate();
});
await gate();
