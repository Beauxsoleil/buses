// All Supabase access lives here. The client library is vendored
// (vendor/supabase.js, pinned to 2.115.0) and loaded as a classic script so
// the page keeps working if a CDN is unreachable and nothing floats to a new
// major version unreviewed.

import { SUPABASE_URL, SUPABASE_ANON_KEY, OPEN_DEFECT_STATUSES } from './config.js';

if (!globalThis.supabase?.createClient) {
  throw new Error('Supabase client library failed to load (vendor/supabase.js).');
}

export const supabase = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const SCHEDULE_SELECT = '*, bus:buses(*), item:maintenance_items(*)';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------------
 * Reads (allowed for anon via RLS)
 * ------------------------------------------------------------------- */

export async function fetchBuses() {
  return unwrap(await supabase.from('buses').select('*').order('bus_number')) || [];
}

export async function fetchBus(busId) {
  return unwrap(await supabase.from('buses').select('*').eq('id', busId).maybeSingle());
}

export async function fetchMaintenanceItems({ activeOnly = true } = {}) {
  let q = supabase.from('maintenance_items').select('*').order('category').order('name');
  if (activeOnly) q = q.eq('is_active', true);
  return unwrap(await q) || [];
}

// Active schedules for ACTIVE buses only: what the shop should work on.
export async function fetchActiveSchedules() {
  const data = unwrap(await supabase.from('bus_maintenance_schedules').select(SCHEDULE_SELECT).eq('is_active', true)) || [];
  return data.filter((s) => s.bus && s.bus.status === 'ACTIVE');
}

// Active schedules for every bus still in the fleet, so regulatory deadlines
// do not vanish while a bus is temporarily out of service.
export async function fetchFleetSchedules() {
  const data = unwrap(await supabase.from('bus_maintenance_schedules').select(SCHEDULE_SELECT).eq('is_active', true)) || [];
  return data.filter((s) => s.bus && !['RETIRED', 'SOLD'].includes(s.bus.status));
}

export async function fetchSchedulesForBus(busId, { includeInactive = false } = {}) {
  let q = supabase.from('bus_maintenance_schedules').select(SCHEDULE_SELECT).eq('bus_id', busId).order('next_due_date', { ascending: true, nullsFirst: false });
  if (!includeInactive) q = q.eq('is_active', true);
  return unwrap(await q) || [];
}

export async function fetchDefects({ status = OPEN_DEFECT_STATUSES, busId } = {}) {
  let q = supabase.from('defect_reports').select('*, bus:buses(*)').order('reported_date', { ascending: false });
  if (status?.length) q = q.in('status', status);
  if (busId) q = q.eq('bus_id', busId);
  return unwrap(await q) || [];
}

export async function fetchMaintenanceLogs({ busId, limit = 1000 } = {}) {
  let q = supabase
    .from('maintenance_logs')
    .select('*, bus:buses(*), item:maintenance_items(*)')
    .order('date_performed', { ascending: false })
    .order('created_at', { ascending: false })
    .range(0, Math.max(0, limit - 1));
  if (busId) q = q.eq('bus_id', busId);
  return unwrap(await q) || [];
}

export async function fetchMileageLogs({ busId, limit = 5000 } = {}) {
  let q = supabase.from('mileage_log').select('*').order('date_recorded', { ascending: true }).range(0, Math.max(0, limit - 1));
  if (busId) q = q.eq('bus_id', busId);
  return unwrap(await q) || [];
}

export async function fetchSettings() {
  const rows = unwrap(await supabase.from('app_settings').select('key, value')) || [];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/* ---------------------------------------------------------------------
 * Auth (admin page)
 * ------------------------------------------------------------------- */

export async function getSession() {
  return unwrap(await supabase.auth.getSession())?.session || null;
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function signInWithPassword(email, password) {
  return unwrap(await supabase.auth.signInWithPassword({ email, password }));
}

export async function signInWithMagicLink(email) {
  return unwrap(await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}${location.pathname}` },
  }));
}

export async function signOut() {
  unwrap(await supabase.auth.signOut());
}

// True when the signed-in user is listed in admin_users (the RLS gate).
export async function isAdmin() {
  return Boolean(unwrap(await supabase.rpc('is_admin')));
}

/* ---------------------------------------------------------------------
 * Writes (admins only; every call is re-checked by RLS on the server)
 * ------------------------------------------------------------------- */

// The wizard's final step. One RPC = one transaction: bus + first mileage
// reading + every selected schedule succeed or fail together, and the
// server re-validates uniqueness, mileage and dates regardless of client.
export async function createBusWithSchedules({ bus, mileage, schedules }) {
  return unwrap(await supabase.rpc('create_bus_with_schedules', {
    p_bus: bus,
    p_mileage: mileage,
    p_schedules: schedules,
  }));
}

// Adds templates to an existing bus (server anchors due dates to the current
// odometer / today unless last-done values are supplied) and returns the rows.
export async function assignSchedules(busId, schedules) {
  return unwrap(await supabase.rpc('assign_schedules', { p_bus_id: busId, p_schedules: schedules })) || [];
}

// Map of bus_id -> number of active schedules (for "no templates" warnings).
export async function countActiveSchedules() {
  const rows = unwrap(await supabase.from('bus_maintenance_schedules').select('bus_id').eq('is_active', true)) || [];
  const tally = new Map();
  rows.forEach((row) => tally.set(row.bus_id, (tally.get(row.bus_id) || 0) + 1));
  return tally;
}

export async function updateBus(busId, patch) {
  return unwrap(await supabase.from('buses').update(patch).eq('id', busId).select().single());
}

// Records a reading; a trigger rejects readings below the current odometer
// and rolls the new value forward onto buses.current_mileage.
export async function recordMileage({ busId, mileage, engineHours = null, dateRecorded, notes = null }) {
  return unwrap(await supabase.rpc('record_mileage', {
    p_bus_id: busId,
    p_mileage: mileage,
    p_engine_hours: engineHours,
    p_date_recorded: dateRecorded,
    p_notes: notes,
  }));
}

// Logs completed work and advances the matching schedule in one transaction.
export async function logMaintenance(payload) {
  return unwrap(await supabase.rpc('log_maintenance', { p_log: payload }));
}

export async function createDefect(payload) {
  return unwrap(await supabase.from('defect_reports').insert(payload).select().single());
}

export async function updateDefect(defectId, patch) {
  return unwrap(await supabase.from('defect_reports').update(patch).eq('id', defectId).select().single());
}

export async function upsertSchedule(schedule) {
  return unwrap(await supabase.from('bus_maintenance_schedules').upsert(schedule, { onConflict: 'bus_id,maintenance_item_id' }).select(SCHEDULE_SELECT).single());
}

export async function setScheduleActive(scheduleId, isActive) {
  return unwrap(await supabase.from('bus_maintenance_schedules').update({ is_active: isActive }).eq('id', scheduleId).select().single());
}
