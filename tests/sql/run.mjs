#!/usr/bin/env node
// Integration test for supabase/schema.sql + migrations, run against a
// throw-away embedded PostgreSQL. It stubs the parts of Supabase that the
// SQL touches (auth schema, anon/authenticated roles, auth.uid()) and then
// checks the behaviour the Admin page depends on:
//
//   * anon can read but cannot write anything
//   * a signed-in user who is NOT in admin_users cannot write either
//   * an admin can run the Add Bus wizard RPC and everything lands
//   * duplicate bus numbers, decreasing odometers and bad dates are rejected
//   * logging maintenance advances the schedule
//
// Usage:  npm run test:sql        (installs embedded-postgres on first run)

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let EmbeddedPostgres;
try {
  const mod = require('embedded-postgres');
  EmbeddedPostgres = mod.default || mod;
} catch {
  console.error('embedded-postgres is not installed. Run: npm install --no-save embedded-postgres');
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), 'fleet-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: 54329 + Math.floor(Math.random() * 1000),
  persistent: false,
  // Keep the server's own chatter (expected ERRORs from the negative tests,
  // checkpoints, etc.) out of the test output.
  onLog: () => {},
  onError: () => {},
});

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); } else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}

// Every statement runs inside one long transaction (like a PostgREST
// request does) so failures can be rolled back to a savepoint.
async function expectError(client, sql, params, pattern, name) {
  await client.query('savepoint sp');
  try {
    await client.query(sql, params);
    await client.query('release savepoint sp');
    ok(false, `${name} (no error raised)`);
  } catch (error) {
    await client.query('rollback to savepoint sp');
    ok(pattern.test(error.message), `${name}${pattern.test(error.message) ? '' : ` — got: ${error.message}`}`);
  }
}

// Act as a Supabase role with a given JWT subject.
async function become(client, role, uid) {
  await client.query('reset role');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await client.query(`set local role ${role}`);
}

const SUPABASE_STUBS = `
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    last_sign_in_at timestamptz
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
  grant anon, authenticated, service_role to postgres;
  grant usage on schema auth to anon, authenticated;
`;

try {
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  // Silence NOTICEs from the idempotent guards.
  await client.query(`set client_min_messages = warning`);
  await client.query('begin');

  console.log('\nApplying schema + migration…');
  await client.query(SUPABASE_STUBS);
  await client.query(readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8'));
  await client.query(readFileSync(join(root, 'supabase', 'migrations', '0001_admin_access.sql'), 'utf8'));
  await client.query(readFileSync(join(root, 'supabase', 'seed-maintenance-items.sql'), 'utf8'));
  // Re-running must be a no-op.
  await client.query(readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8'));
  await client.query(readFileSync(join(root, 'supabase', 'migrations', '0001_admin_access.sql'), 'utf8'));
  ok(true, 'schema and migration apply twice without error (idempotent)');

  // Two users: one admin, one ordinary authenticated user.
  const { rows: [admin] } = await client.query(`insert into auth.users (email) values ('admin@example.com') returning id`);
  const { rows: [nobody] } = await client.query(`insert into auth.users (email) values ('nobody@example.com') returning id`);
  await client.query(`insert into public.admin_users (user_id, email) values ($1, 'admin@example.com')`, [admin.id]);

  const { rows: items } = await client.query(`select id, name, default_interval_days, default_interval_miles from public.maintenance_items order by name`);
  ok(items.length >= 19, `seed installed ${items.length} maintenance templates`);
  const oil = items.find((i) => i.name === 'Engine Oil & Filter Change');
  const dot = items.find((i) => i.name === 'Annual DOT Inspection');
  const brakes = items.find((i) => i.name === 'Brake Inspection');

  // ---------------------------------------------------------------- anon
  console.log('\nAnonymous visitors…');
  await become(client, 'anon', null);
  const { rows: anonItems } = await client.query(`select count(*)::int as n from public.maintenance_items`);
  ok(anonItems[0].n === items.length, 'anon can read maintenance_items');
  await expectError(client, `insert into public.buses (bus_number) values ('999')`, [], /permission denied|violates row-level security/i, 'anon cannot insert a bus');
  await expectError(client, `update public.buses set nickname = 'x'`, [], /permission denied|violates row-level security/i, 'anon cannot update buses');
  await expectError(client, `select public.create_bus_with_schedules('{"bus_number":"999"}'::jsonb)`, [], /permission denied/i, 'anon cannot execute the wizard RPC');
  await expectError(client, `select * from public.admin_users`, [], /permission denied/i, 'anon cannot read admin_users');
  const { rows: [anonIsAdmin] } = await client.query(`select public.is_admin() as v`);
  ok(anonIsAdmin.v === false, 'is_admin() is false for anon');

  // ------------------------------------------------- authenticated, not admin
  console.log('\nSigned-in user who is not an admin…');
  await become(client, 'authenticated', nobody.id);
  const { rows: [nobodyIsAdmin] } = await client.query(`select public.is_admin() as v`);
  ok(nobodyIsAdmin.v === false, 'is_admin() is false for a non-admin user');
  await expectError(client, `insert into public.buses (bus_number) values ('999')`, [], /violates row-level security/i, 'non-admin cannot insert a bus');
  await expectError(client, `select public.create_bus_with_schedules('{"bus_number":"999"}'::jsonb)`, [], /not authorised/i, 'wizard RPC refuses a non-admin with a readable message');
  await expectError(client, `select public.record_mileage('00000000-0000-0000-0000-000000000000', 1)`, [], /not authorised/i, 'record_mileage refuses a non-admin');
  const { rows: selfRows } = await client.query(`select * from public.admin_users`);
  ok(selfRows.length === 0, 'non-admin sees no admin_users rows');

  // ---------------------------------------------------------------- admin
  console.log('\nAdmin: Add Bus wizard…');
  await become(client, 'authenticated', admin.id);
  const { rows: [adminIsAdmin] } = await client.query(`select public.is_admin() as v`);
  ok(adminIsAdmin.v === true, 'is_admin() is true for the listed admin');

  const busPayload = {
    bus_number: ' 201 ', nickname: 'Test Rig', vin: '1baankcl1jf123456', year: 2024, make: 'Blue Bird', model: 'Vision',
    license_plate: 'id-201', current_mileage: 12000, status: 'ACTIVE', dot_inspection_due_date: '2027-03-01', notes: '',
  };
  const schedules = [
    { maintenance_item_id: oil.id },
    { maintenance_item_id: dot.id, last_completed_date: '2026-03-01' },
    { maintenance_item_id: brakes.id, custom_interval_miles: 8000, last_completed_mileage: 11000, last_completed_date: '2026-08-01' },
  ];
  const { rows: [{ result }] } = await client.query(
    `select public.create_bus_with_schedules($1::jsonb, $2::jsonb, $3::jsonb) as result`,
    [JSON.stringify(busPayload), JSON.stringify({ date_recorded: '2026-09-05', notes: 'Delivery odometer' }), JSON.stringify(schedules)],
  );
  ok(result.bus.bus_number === '201', 'bus number is trimmed');
  ok(result.bus.vin === '1BAANKCL1JF123456' && result.bus.license_plate === 'ID-201', 'VIN and plate are upper-cased');
  ok(result.bus.notes === null, 'empty strings become NULL');
  ok(result.bus.current_mileage === 12000, 'starting mileage stored on the bus');
  ok(result.schedules === 3, 'three schedules created');

  const { rows: mileageRows } = await client.query(`select mileage, notes from public.mileage_log where bus_id = $1`, [result.bus.id]);
  ok(mileageRows.length === 1 && mileageRows[0].mileage === 12000 && mileageRows[0].notes === 'Delivery odometer', 'first odometer reading logged');

  const { rows: sched } = await client.query(
    `select mi.name, s.next_due_date::text, s.next_due_mileage, s.last_completed_mileage, s.custom_interval_miles
       from public.bus_maintenance_schedules s join public.maintenance_items mi on mi.id = s.maintenance_item_id
      where s.bus_id = $1 order by mi.name`, [result.bus.id]);
  const oilSched = sched.find((s) => s.name === oil.name);
  const dotSched = sched.find((s) => s.name === dot.name);
  const brakeSched = sched.find((s) => s.name === brakes.name);
  ok(oilSched.next_due_date === '2026-12-04' && oilSched.next_due_mileage === 17000, `never-done item is due one interval after the start (${oilSched.next_due_date}, ${oilSched.next_due_mileage} mi)`);
  ok(dotSched.next_due_date === '2027-03-01' && dotSched.next_due_mileage === null, 'date-only item anchors to its last completion');
  ok(brakeSched.next_due_mileage === 19000 && brakeSched.custom_interval_miles === 8000 && brakeSched.next_due_date === '2026-10-30', 'custom interval + last completion honoured');

  console.log('\nAdmin: integrity rules…');
  await expectError(client, `select public.create_bus_with_schedules($1::jsonb)`, [JSON.stringify({ bus_number: '201', current_mileage: 0 })], /already exists/i, 'duplicate bus number rejected by the RPC');
  await expectError(client, `insert into public.buses (bus_number) values ('  201')`, [], /duplicate key|already exists/i, 'duplicate bus number rejected at the table (case/whitespace-insensitive)');
  await expectError(client, `select public.create_bus_with_schedules($1::jsonb)`, [JSON.stringify({ bus_number: '', current_mileage: 0 })], /required/i, 'blank bus number rejected');
  await expectError(client, `select public.create_bus_with_schedules($1::jsonb)`, [JSON.stringify({ bus_number: '202', current_mileage: -5 })], /negative/i, 'negative starting mileage rejected');
  await expectError(client, `select public.create_bus_with_schedules($1::jsonb, '{}', $2::jsonb)`, [JSON.stringify({ bus_number: '202', current_mileage: 500 }), JSON.stringify([{ maintenance_item_id: oil.id, last_completed_mileage: 900 }])], /above the bus odometer/i, 'last-completed mileage above odometer rejected (and the bus insert rolled back with it)');
  const { rows: no202 } = await client.query(`select 1 from public.buses where bus_number = '202'`);
  ok(no202.length === 0, 'failed wizard run left no partial bus behind (transactional)');

  await expectError(client, `update public.buses set current_mileage = 11000 where id = $1`, [result.bus.id], /cannot decrease/i, 'direct odometer rollback on buses rejected');
  await expectError(client, `select public.record_mileage($1, 11999)`, [result.bus.id], /cannot decrease/i, 'record_mileage rejects a lower reading');
  await expectError(client, `select public.record_mileage($1, 13000, null, now() + interval '3 days')`, [result.bus.id], /future/i, 'record_mileage rejects a future date');

  const { rows: [afterReading] } = await client.query(`select * from public.record_mileage($1, 12800, 310.5, now(), 'Friday check')`, [result.bus.id]);
  ok(afterReading.current_mileage === 12800 && Number(afterReading.engine_hours) === 310.5, `valid reading rolls forward onto the bus (mileage + engine hours) — ${afterReading.current_mileage} mi, ${afterReading.engine_hours} hr`);

  // Back-dated reading between existing ones must fit chronologically.
  await expectError(client, `insert into public.mileage_log (bus_id, mileage, date_recorded) values ($1, 12900, now() - interval '10 days')`, [result.bus.id], /conflicts with a later entry/i, 'back-dated reading higher than a later reading rejected');

  console.log('\nAdmin: logging maintenance…');
  const { rows: [log] } = await client.query(
    `select * from public.log_maintenance($1::jsonb)`,
    [JSON.stringify({ bus_id: result.bus.id, maintenance_item_id: oil.id, date_performed: '2026-09-05', mileage_at_service: 12950, parts_cost: 120, labor_cost: 80, vendor: 'Valley Fleet Shop', work_order_number: 'WO-1' })],
  );
  ok(Number(log.cost) === 200, 'total cost derived from parts + labor when omitted');
  ok(log.bus_maintenance_schedule_id !== null, 'log linked to the matching active schedule');
  const { rows: [oilAfter] } = await client.query(`select last_completed_date::text, last_completed_mileage, next_due_date::text, next_due_mileage from public.bus_maintenance_schedules where id = $1`, [log.bus_maintenance_schedule_id]);
  ok(oilAfter.last_completed_date === '2026-09-05' && oilAfter.last_completed_mileage === 12950, 'schedule last-completed updated');
  ok(oilAfter.next_due_date === '2026-12-04' && oilAfter.next_due_mileage === 17950, `schedule rolled forward one interval (${oilAfter.next_due_date}, ${oilAfter.next_due_mileage} mi)`);
  const { rows: [busAfterLog] } = await client.query(`select current_mileage from public.buses where id = $1`, [result.bus.id]);
  ok(busAfterLog.current_mileage === 12950, 'higher service mileage became the new odometer');
  await expectError(client, `select public.log_maintenance($1::jsonb)`, [JSON.stringify({ bus_id: result.bus.id, date_performed: '2999-01-01' })], /future/i, 'future service date rejected');

  console.log('\nAdmin: assign templates to an existing bus…');
  const { rows: assigned } = await client.query(`select * from public.assign_schedules($1, $2::jsonb)`, [result.bus.id, JSON.stringify([{ maintenance_item_id: items.find((i) => i.name === 'Battery Check').id }])]);
  ok(assigned.length === 1 && assigned[0].next_due_mileage === 12950 + 10000, 'assign_schedules anchors to the current odometer');
  const { rows: again } = await client.query(`select * from public.assign_schedules($1, $2::jsonb)`, [result.bus.id, JSON.stringify([{ maintenance_item_id: oil.id, custom_interval_days: 45 }])]);
  ok(again.length === 1 && again[0].id === log.bus_maintenance_schedule_id && again[0].custom_interval_days === 45, 're-assigning an existing template updates the active row instead of duplicating it');
  const { rows: activeCount } = await client.query(`select count(*)::int as n from public.bus_maintenance_schedules where bus_id = $1 and maintenance_item_id = $2 and is_active`, [result.bus.id, oil.id]);
  ok(activeCount[0].n === 1, 'still exactly one active schedule per (bus, template)');

  await client.query('reset role');
  await client.query('rollback');
  await client.end();
} catch (error) {
  failed++;
  failures.push(`Unexpected error: ${error.message}`);
  console.error('\nUnexpected error:', error);
} finally {
  try { await pg.stop(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
