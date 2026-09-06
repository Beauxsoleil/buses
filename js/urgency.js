// Pure scheduling math. No DOM and no network so it can be unit tested in Node
// (see tests/unit/urgency.test.js) and shared by dashboards and the admin
// wizard alike.

const DAY_MS = 86_400_000;

export const STATUS_RANK = { overdue: 4, 'due-soon': 3, upcoming: 2, ok: 1, unscheduled: 0, inactive: -1 };

export const STATUS_LABELS = {
  ok: 'On track',
  upcoming: 'Upcoming',
  'due-soon': 'Due soon',
  overdue: 'Overdue',
  inactive: 'Inactive',
  unscheduled: 'Unscheduled',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/* ---------------------------------------------------------------------
 * Date helpers (all local-time, all "YYYY-MM-DD" strings)
 * ------------------------------------------------------------------- */

export function isoLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(dateString) {
  if (!dateString) return null;
  const date = new Date(`${String(dateString).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addDays(dateString, days) {
  const date = parseLocalDate(dateString);
  if (!date || days == null) return null;
  date.setDate(date.getDate() + Number(days));
  return isoLocal(date);
}

export function daysUntil(dateString, now = new Date()) {
  const due = parseLocalDate(dateString);
  if (!due) return null;
  return Math.round((due - startOfToday(now)) / DAY_MS);
}

/* ---------------------------------------------------------------------
 * Urgency calculation
 *
 * A schedule is judged on whichever axis (time, mileage or engine hours) is
 * closest to its limit:
 *   ok        : more than 30 days away AND more than 75% of interval remaining
 *   upcoming  : within 30 days OR less than 75% of the interval remaining
 *   due-soon  : within 7 days OR less than 25% of the interval remaining
 *   overdue   : past the limit on any axis
 * ------------------------------------------------------------------- */

export function computeUrgency(schedule, now = new Date()) {
  const item = schedule.item || {};
  const bus = schedule.bus || {};
  const intervalDays = schedule.custom_interval_days ?? item.default_interval_days ?? null;
  const intervalMiles = schedule.custom_interval_miles ?? item.default_interval_miles ?? null;
  const intervalEngineHours = schedule.custom_interval_engine_hours ?? item.default_interval_engine_hours ?? null;

  let daysRemaining = null;
  let pctDaysRemaining = null;
  if (schedule.next_due_date) {
    daysRemaining = daysUntil(schedule.next_due_date, now);
    if (daysRemaining !== null && intervalDays) pctDaysRemaining = daysRemaining / intervalDays;
  }

  let milesRemaining = null;
  let pctMilesRemaining = null;
  if (schedule.next_due_mileage != null && bus.current_mileage != null) {
    milesRemaining = Number(schedule.next_due_mileage) - Number(bus.current_mileage);
    if (intervalMiles) pctMilesRemaining = milesRemaining / intervalMiles;
  }

  let engineHoursRemaining = null;
  let pctEngineHoursRemaining = null;
  if (schedule.next_due_engine_hours != null && bus.engine_hours != null) {
    engineHoursRemaining = Number(schedule.next_due_engine_hours) - Number(bus.engine_hours);
    if (intervalEngineHours) pctEngineHoursRemaining = engineHoursRemaining / intervalEngineHours;
  }

  if (daysRemaining === null && milesRemaining === null && engineHoursRemaining === null) {
    return { status: 'unscheduled', daysRemaining, milesRemaining, engineHoursRemaining, label: 'Not yet scheduled' };
  }

  const pctCandidates = [pctDaysRemaining, pctMilesRemaining, pctEngineHoursRemaining].filter((v) => v !== null);
  const pctRemaining = pctCandidates.length ? Math.min(...pctCandidates) : null;

  const isOverdue = (daysRemaining !== null && daysRemaining < 0)
    || (milesRemaining !== null && milesRemaining < 0)
    || (engineHoursRemaining !== null && engineHoursRemaining < 0);
  const isDueSoon = (daysRemaining !== null && daysRemaining <= 7) || (pctRemaining !== null && pctRemaining < 0.25);
  const isUpcoming = (daysRemaining !== null && daysRemaining <= 30) || (pctRemaining !== null && pctRemaining < 0.75);

  let status = 'ok';
  if (isOverdue) status = 'overdue';
  else if (isDueSoon) status = 'due-soon';
  else if (isUpcoming) status = 'upcoming';

  return {
    status,
    daysRemaining,
    milesRemaining,
    engineHoursRemaining,
    label: formatDueLabel(daysRemaining, milesRemaining, engineHoursRemaining),
  };
}

export function formatDueLabel(daysRemaining, milesRemaining, engineHoursRemaining) {
  const parts = [];
  if (daysRemaining !== null && daysRemaining !== undefined) {
    parts.push(daysRemaining < 0 ? `${Math.abs(daysRemaining)}d overdue` : daysRemaining === 0 ? 'due today' : `${daysRemaining}d left`);
  }
  if (milesRemaining !== null && milesRemaining !== undefined) {
    parts.push(milesRemaining < 0 ? `${Math.abs(milesRemaining).toLocaleString('en-US')} mi overdue` : `${milesRemaining.toLocaleString('en-US')} mi left`);
  }
  if (engineHoursRemaining !== null && engineHoursRemaining !== undefined) {
    const hours = Math.abs(engineHoursRemaining).toLocaleString('en-US', { maximumFractionDigits: 1 });
    parts.push(engineHoursRemaining < 0 ? `${hours} hr overdue` : `${hours} hr left`);
  }
  return parts.join(' \u00b7 ') || '\u2014';
}

export function worstStatus(statuses) {
  if (!statuses.length) return 'unscheduled';
  return statuses.reduce((worst, s) => ((STATUS_RANK[s] ?? -1) > (STATUS_RANK[worst] ?? -1) ? s : worst), statuses[0]);
}

// A bus with no schedules at all is "unscheduled", not "ok": it deserves a
// grey card so the data-entry gap is visible on the wall.
export function statusForBus(bus, schedulesForBus, now = new Date()) {
  if (bus.status !== 'ACTIVE') return 'inactive';
  if (!schedulesForBus.length) return 'unscheduled';
  return worstStatus(schedulesForBus.map((s) => computeUrgency(s, now).status));
}

// Sort helper: most urgent first, then soonest, then by bus number.
export function compareUrgency(a, b) {
  const rankDiff = (STATUS_RANK[b.u.status] ?? -1) - (STATUS_RANK[a.u.status] ?? -1);
  if (rankDiff) return rankDiff;
  const daysDiff = (a.u.daysRemaining ?? Infinity) - (b.u.daysRemaining ?? Infinity);
  if (daysDiff) return daysDiff;
  return (a.u.milesRemaining ?? Infinity) - (b.u.milesRemaining ?? Infinity);
}

/* ---------------------------------------------------------------------
 * Compliance document deadlines (bus-level dates, days only)
 * ------------------------------------------------------------------- */

export function deadlineStatus(days) {
  if (days === null || days === undefined) return 'unscheduled';
  if (days < 0) return 'overdue';
  if (days <= 30) return 'due-soon';
  if (days <= 90) return 'upcoming';
  return 'ok';
}

export function deadlineLabel(days) {
  if (days === null || days === undefined) return 'No date';
  if (days < 0) return `${Math.abs(days)} days expired`;
  if (days === 0) return 'Due today';
  return `${days} days remaining`;
}

/* ---------------------------------------------------------------------
 * Initial schedule projection (used by the Add Bus wizard)
 *
 * Given a maintenance template, the bus's starting odometer, and an optional
 * "last done" date/mileage, work out when the first service is due. When the
 * work has never been done we anchor to the start date so the item shows up
 * one full interval out instead of immediately overdue.
 * ------------------------------------------------------------------- */

export function projectInitialSchedule({
  item,
  startDate,
  startMileage,
  startEngineHours = null,
  lastCompletedDate = null,
  lastCompletedMileage = null,
  lastCompletedEngineHours = null,
  customIntervalDays = null,
  customIntervalMiles = null,
  customIntervalEngineHours = null,
}) {
  const intervalDays = customIntervalDays ?? item.default_interval_days ?? null;
  const intervalMiles = customIntervalMiles ?? item.default_interval_miles ?? null;
  const intervalEngineHours = customIntervalEngineHours ?? item.default_interval_engine_hours ?? null;

  const anchorDate = lastCompletedDate || startDate;
  const anchorMileage = lastCompletedMileage ?? startMileage ?? null;
  const anchorEngineHours = lastCompletedEngineHours ?? startEngineHours ?? null;

  return {
    maintenance_item_id: item.id,
    custom_interval_days: customIntervalDays,
    custom_interval_miles: customIntervalMiles,
    custom_interval_engine_hours: customIntervalEngineHours,
    last_completed_date: lastCompletedDate,
    last_completed_mileage: lastCompletedMileage,
    last_completed_engine_hours: lastCompletedEngineHours,
    next_due_date: intervalDays ? addDays(anchorDate, intervalDays) : null,
    next_due_mileage: intervalMiles && anchorMileage != null ? Number(anchorMileage) + Number(intervalMiles) : null,
    next_due_engine_hours: intervalEngineHours && anchorEngineHours != null ? Number(anchorEngineHours) + Number(intervalEngineHours) : null,
    is_active: true,
  };
}

/* ---------------------------------------------------------------------
 * Form validation for the admin pages
 * ------------------------------------------------------------------- */

export function validateBusInput(input, { existingNumbers = [] } = {}) {
  const errors = {};
  const busNumber = String(input.bus_number ?? '').trim();
  if (!busNumber) errors.bus_number = 'Bus number is required.';
  else if (busNumber.length > 20) errors.bus_number = 'Bus number must be 20 characters or fewer.';
  else if (existingNumbers.some((n) => String(n).trim().toLowerCase() === busNumber.toLowerCase())) {
    errors.bus_number = `Bus ${busNumber} already exists.`;
  }

  const mileage = input.current_mileage;
  if (mileage === '' || mileage === null || mileage === undefined) errors.current_mileage = 'Starting mileage is required (use 0 for a new vehicle).';
  else if (!Number.isInteger(Number(mileage)) || Number(mileage) < 0) errors.current_mileage = 'Mileage must be a whole number of zero or more.';
  else if (Number(mileage) > 5_000_000) errors.current_mileage = 'That mileage looks wrong. Double-check the odometer.';

  if (input.engine_hours !== '' && input.engine_hours != null && (Number.isNaN(Number(input.engine_hours)) || Number(input.engine_hours) < 0)) {
    errors.engine_hours = 'Engine hours must be zero or more.';
  }

  if (input.vin) {
    const vin = String(input.vin).trim().toUpperCase();
    if (vin.length !== 17) errors.vin = 'A VIN is 17 characters.';
    else if (/[IOQ]/.test(vin)) errors.vin = 'VINs never contain the letters I, O or Q.';
    else if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) errors.vin = 'VIN may only contain letters and digits.';
  }

  if (input.year !== '' && input.year != null) {
    const year = Number(input.year);
    const maxYear = new Date().getFullYear() + 2;
    if (!Number.isInteger(year) || year < 1950 || year > maxYear) errors.year = `Year must be between 1950 and ${maxYear}.`;
  }

  if (input.status && !['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED', 'SOLD'].includes(input.status)) {
    errors.status = 'Choose a valid status.';
  }

  return errors;
}

export function validateMileageReading({ mileage, currentMileage, dateRecorded }, now = new Date()) {
  const errors = {};
  if (mileage === '' || mileage === null || mileage === undefined) errors.mileage = 'Enter the odometer reading.';
  else if (!Number.isInteger(Number(mileage)) || Number(mileage) < 0) errors.mileage = 'Mileage must be a whole number of zero or more.';
  else if (currentMileage != null && Number(mileage) < Number(currentMileage)) {
    errors.mileage = `Reading can't be lower than the current odometer (${Number(currentMileage).toLocaleString('en-US')} mi).`;
  }
  if (dateRecorded) {
    const days = daysUntil(dateRecorded, now);
    if (days === null) errors.date_recorded = 'Enter a valid date.';
    else if (days > 0) errors.date_recorded = 'Reading date cannot be in the future.';
  }
  return errors;
}
