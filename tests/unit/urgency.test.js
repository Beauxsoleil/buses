import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeUrgency, statusForBus, worstStatus, compareUrgency, daysUntil, addDays, isoLocal,
  deadlineStatus, deadlineLabel, projectInitialSchedule, validateBusInput, validateMileageReading,
  formatDueLabel,
} from '../../js/urgency.js';

// Freeze "today" so results do not drift with the calendar.
const NOW = new Date(2026, 8, 5, 10, 30); // Sat 5 Sep 2026, 10:30 local

function schedule(overrides = {}) {
  return {
    next_due_date: null,
    next_due_mileage: null,
    next_due_engine_hours: null,
    custom_interval_days: null,
    custom_interval_miles: null,
    item: { default_interval_days: 90, default_interval_miles: 5000 },
    bus: { current_mileage: 100_000, engine_hours: null, status: 'ACTIVE' },
    ...overrides,
  };
}

describe('date helpers', () => {
  test('daysUntil counts whole local days from the start of today', () => {
    assert.equal(daysUntil('2026-09-05', NOW), 0);
    assert.equal(daysUntil('2026-09-06', NOW), 1);
    assert.equal(daysUntil('2026-09-04', NOW), -1);
    assert.equal(daysUntil('2026-10-05', NOW), 30);
    assert.equal(daysUntil(null, NOW), null);
    assert.equal(daysUntil('not a date', NOW), null);
  });

  test('daysUntil ignores a time component on timestamps', () => {
    assert.equal(daysUntil('2026-09-07T23:59:00+00:00', NOW), 2);
  });

  test('addDays and isoLocal round-trip across month and DST boundaries', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-02-28', 365), '2027-02-28');
    assert.equal(addDays('2026-03-07', 1), '2026-03-08'); // US DST start
    assert.equal(addDays('2026-11-01', 90), '2027-01-30');
    assert.equal(addDays(null, 30), null);
    assert.equal(isoLocal(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('computeUrgency', () => {
  test('is unscheduled when no axis has a due value', () => {
    const u = computeUrgency(schedule(), NOW);
    assert.equal(u.status, 'unscheduled');
    assert.equal(u.label, 'Not yet scheduled');
  });

  test('is ok when far out on both axes', () => {
    const u = computeUrgency(schedule({ next_due_date: '2026-12-01', next_due_mileage: 104_900 }), NOW);
    assert.equal(u.status, 'ok');
    assert.equal(u.daysRemaining, 87);
    assert.equal(u.milesRemaining, 4900);
  });

  // A template with no interval isolates the pure day thresholds from the
  // percentage-of-interval rule.
  const noInterval = {};

  test('is upcoming within 30 days', () => {
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-10-05', item: noInterval }), NOW).status, 'upcoming');
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-10-06', item: noInterval }), NOW).status, 'ok');
  });

  test('is due-soon within 7 days, overdue after the date', () => {
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-09-12', item: noInterval }), NOW).status, 'due-soon');
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-09-13', item: noInterval }), NOW).status, 'upcoming');
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-09-05', item: noInterval }), NOW).status, 'due-soon');
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-09-04', item: noInterval }), NOW).status, 'overdue');
  });

  test('a long interval makes even a month away "due soon" by percentage', () => {
    // 30 of 3650 days is <1% remaining: the percentage rule correctly wins.
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-10-05', item: { default_interval_days: 3650 } }), NOW).status, 'due-soon');
  });

  test('percentage-of-interval thresholds apply to dates too', () => {
    // 90-day interval: 31 days left is 34% -> upcoming even though >30 days
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-10-06' }), NOW).status, 'upcoming');
    // 8 days left of 90 is 9% -> due-soon even though >7 days
    assert.equal(computeUrgency(schedule({ next_due_date: '2026-09-13' }), NOW).status, 'due-soon');
  });

  test('percentage-of-interval thresholds apply to mileage', () => {
    // 5000 mi interval: <25% remaining (1249) -> due-soon, <75% (3749) -> upcoming
    assert.equal(computeUrgency(schedule({ next_due_mileage: 101_200 }), NOW).status, 'due-soon');
    assert.equal(computeUrgency(schedule({ next_due_mileage: 103_000 }), NOW).status, 'upcoming');
    assert.equal(computeUrgency(schedule({ next_due_mileage: 104_000 }), NOW).status, 'ok');
    assert.equal(computeUrgency(schedule({ next_due_mileage: 99_999 }), NOW).status, 'overdue');
  });

  test('a long-interval item 60 days out is due-soon by percentage but NOT within 7 days', () => {
    // This is the case that mislabelled "Due this week" on the old Today page.
    const u = computeUrgency(schedule({ next_due_date: '2026-11-04', item: { default_interval_days: 365 } }), NOW);
    assert.equal(u.status, 'due-soon');
    assert.equal(u.daysRemaining, 60);
  });

  test('the worst axis wins', () => {
    const u = computeUrgency(schedule({ next_due_date: '2027-01-01', next_due_mileage: 99_000 }), NOW);
    assert.equal(u.status, 'overdue');
    assert.match(u.label, /1,000 mi overdue/);
  });

  test('engine hours are a third axis', () => {
    const u = computeUrgency(schedule({
      next_due_engine_hours: 1200,
      item: { default_interval_engine_hours: 250 },
      bus: { current_mileage: 0, engine_hours: 1210 },
    }), NOW);
    assert.equal(u.status, 'overdue');
    assert.match(u.label, /10 hr overdue/);
  });

  test('mileage axis is ignored when the bus has no odometer reading', () => {
    const u = computeUrgency(schedule({ next_due_mileage: 5000, bus: { current_mileage: null } }), NOW);
    assert.equal(u.status, 'unscheduled');
  });

  test('custom intervals override template defaults for percentages', () => {
    const u = computeUrgency(schedule({ next_due_mileage: 101_000, custom_interval_miles: 1000 }), NOW);
    assert.equal(u.status, 'ok'); // 100% of a 1,000 mi interval remains
  });

  test('labels read naturally', () => {
    assert.equal(formatDueLabel(0, null, null), 'due today');
    assert.equal(formatDueLabel(3, 1200, null), '3d left \u00b7 1,200 mi left');
    assert.equal(formatDueLabel(-2, -50, null), '2d overdue \u00b7 50 mi overdue');
    assert.equal(formatDueLabel(null, null, null), '\u2014');
  });
});

describe('bus status', () => {
  test('inactive buses are always inactive', () => {
    assert.equal(statusForBus({ status: 'OUT_OF_SERVICE' }, [schedule({ next_due_date: '2020-01-01' })], NOW), 'inactive');
  });

  test('a bus with no schedules is unscheduled, not ok', () => {
    assert.equal(statusForBus({ status: 'ACTIVE' }, [], NOW), 'unscheduled');
  });

  test('the worst schedule drives the bus status', () => {
    const list = [schedule({ next_due_date: '2027-01-01' }), schedule({ next_due_date: '2026-09-10' })];
    assert.equal(statusForBus({ status: 'ACTIVE' }, list, NOW), 'due-soon');
  });

  test('worstStatus ranks correctly', () => {
    assert.equal(worstStatus(['ok', 'upcoming']), 'upcoming');
    assert.equal(worstStatus(['ok', 'overdue', 'due-soon']), 'overdue');
    assert.equal(worstStatus(['unscheduled', 'ok']), 'ok');
    assert.equal(worstStatus([]), 'unscheduled');
  });

  test('compareUrgency sorts most urgent first, then soonest', () => {
    const rows = [
      { u: { status: 'ok', daysRemaining: 80 } },
      { u: { status: 'overdue', daysRemaining: -1 } },
      { u: { status: 'overdue', daysRemaining: -10 } },
      { u: { status: 'due-soon', daysRemaining: null, milesRemaining: 300 } },
      { u: { status: 'due-soon', daysRemaining: 2 } },
    ].sort(compareUrgency);
    assert.deepEqual(rows.map((r) => `${r.u.status}:${r.u.daysRemaining}`), ['overdue:-10', 'overdue:-1', 'due-soon:2', 'due-soon:null', 'ok:80']);
  });
});

describe('compliance deadlines', () => {
  test('thresholds are 30 and 90 days', () => {
    assert.equal(deadlineStatus(null), 'unscheduled');
    assert.equal(deadlineStatus(-1), 'overdue');
    assert.equal(deadlineStatus(0), 'due-soon');
    assert.equal(deadlineStatus(30), 'due-soon');
    assert.equal(deadlineStatus(31), 'upcoming');
    assert.equal(deadlineStatus(90), 'upcoming');
    assert.equal(deadlineStatus(91), 'ok');
  });

  test('labels', () => {
    assert.equal(deadlineLabel(null), 'No date');
    assert.equal(deadlineLabel(-3), '3 days expired');
    assert.equal(deadlineLabel(0), 'Due today');
    assert.equal(deadlineLabel(12), '12 days remaining');
  });
});

describe('projectInitialSchedule (Add Bus wizard)', () => {
  const oil = { id: 'oil', default_interval_days: 90, default_interval_miles: 5000 };
  const dot = { id: 'dot', default_interval_days: 365, default_interval_miles: null };

  test('never-done work is due one interval after the start date/odometer', () => {
    const s = projectInitialSchedule({ item: oil, startDate: '2026-09-05', startMileage: 12_000 });
    assert.equal(s.next_due_date, '2026-12-04');
    assert.equal(s.next_due_mileage, 17_000);
    assert.equal(s.last_completed_date, null);
    assert.equal(s.is_active, true);
  });

  test('a known last-completion anchors the projection', () => {
    const s = projectInitialSchedule({ item: oil, startDate: '2026-09-05', startMileage: 12_000, lastCompletedDate: '2026-08-01', lastCompletedMileage: 11_000 });
    assert.equal(s.next_due_date, '2026-10-30');
    assert.equal(s.next_due_mileage, 16_000);
  });

  test('date-only templates do not produce a mileage trigger', () => {
    const s = projectInitialSchedule({ item: dot, startDate: '2026-09-05', startMileage: 12_000 });
    assert.equal(s.next_due_date, '2027-09-05');
    assert.equal(s.next_due_mileage, null);
  });

  test('custom intervals are stored and used', () => {
    const s = projectInitialSchedule({ item: oil, startDate: '2026-09-05', startMileage: 12_000, customIntervalMiles: 8000, customIntervalDays: 120 });
    assert.equal(s.custom_interval_miles, 8000);
    assert.equal(s.custom_interval_days, 120);
    assert.equal(s.next_due_mileage, 20_000);
    assert.equal(s.next_due_date, '2027-01-03');
  });
});

describe('validateBusInput', () => {
  const good = { bus_number: '201', current_mileage: '12000', vin: '1BAANKCL1JF123456', year: '2024', status: 'ACTIVE', engine_hours: '' };

  test('accepts a complete valid bus', () => {
    assert.deepEqual(validateBusInput(good), {});
  });

  test('requires a bus number and rejects duplicates case/space-insensitively', () => {
    assert.match(validateBusInput({ ...good, bus_number: '  ' }).bus_number, /required/);
    assert.match(validateBusInput({ ...good, bus_number: ' 101 ' }, { existingNumbers: ['101'] }).bus_number, /already exists/);
    assert.match(validateBusInput({ ...good, bus_number: 'bus-a' }, { existingNumbers: ['BUS-A'] }).bus_number, /already exists/);
    assert.equal(validateBusInput({ ...good, bus_number: '102' }, { existingNumbers: ['101'] }).bus_number, undefined);
  });

  test('validates mileage', () => {
    assert.match(validateBusInput({ ...good, current_mileage: '' }).current_mileage, /required/);
    assert.match(validateBusInput({ ...good, current_mileage: '-1' }).current_mileage, /zero or more/);
    assert.match(validateBusInput({ ...good, current_mileage: '12.5' }).current_mileage, /whole number/);
    assert.match(validateBusInput({ ...good, current_mileage: '9000000' }).current_mileage, /looks wrong/);
    assert.equal(validateBusInput({ ...good, current_mileage: '0' }).current_mileage, undefined);
  });

  test('validates VIN format', () => {
    assert.match(validateBusInput({ ...good, vin: '123' }).vin, /17 characters/);
    assert.match(validateBusInput({ ...good, vin: '1BAANKCL1JF12345O' }).vin, /I, O or Q/);
    assert.equal(validateBusInput({ ...good, vin: '' }).vin, undefined);
    assert.equal(validateBusInput({ ...good, vin: '1baankcl1jf123456' }).vin, undefined);
  });

  test('validates year and status', () => {
    assert.match(validateBusInput({ ...good, year: '1900' }).year, /between/);
    assert.match(validateBusInput({ ...good, year: String(new Date().getFullYear() + 5) }).year, /between/);
    assert.match(validateBusInput({ ...good, status: 'SCRAPPED' }).status, /valid status/);
  });
});

describe('validateMileageReading', () => {
  test('rejects decreasing odometer readings', () => {
    assert.match(validateMileageReading({ mileage: '999', currentMileage: 1000 }, NOW).mileage, /can't be lower/);
    assert.deepEqual(validateMileageReading({ mileage: '1000', currentMileage: 1000 }, NOW), {});
    assert.deepEqual(validateMileageReading({ mileage: '1001', currentMileage: 1000 }, NOW), {});
  });

  test('rejects blanks, negatives, decimals and future dates', () => {
    assert.match(validateMileageReading({ mileage: '' }, NOW).mileage, /Enter/);
    assert.match(validateMileageReading({ mileage: '-3' }, NOW).mileage, /zero or more/);
    assert.match(validateMileageReading({ mileage: '10.5' }, NOW).mileage, /whole number/);
    assert.match(validateMileageReading({ mileage: '5', dateRecorded: '2026-09-06' }, NOW).date_recorded, /future/);
    assert.equal(validateMileageReading({ mileage: '5', dateRecorded: '2026-09-05' }, NOW).date_recorded, undefined);
  });
});
