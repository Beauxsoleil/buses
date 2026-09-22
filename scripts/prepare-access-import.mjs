// Usage: node scripts/prepare-access-import.mjs <extracted-access.json> <output-dir>
// The input is a local export from the password-protected Access back end.
// This script writes SQL batches locally. Never commit the export or SQL batches.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Provide an Access JSON export and output directory.');
const tables = JSON.parse(readFileSync(source, 'utf8')).tables;
mkdirSync(target, { recursive: true });
const rows = (name) => tables[name]?.rows || [];
const clean = (v) => v == null || v === '' ? null : String(v).trim();
const date = (v) => v ? String(v).slice(0, 10) : null;
const sql = (v) => v == null ? 'null' : `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => sql(JSON.stringify(v));
const uuid = (prefix, id) => {
  const hex = createHash('sha256').update(`${prefix}:${id}`).digest('hex').slice(0, 32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
let batch = 0;
const emit = (name, chunks) => {
  for (const [i, query] of chunks.entries()) {
    const file = `${String(++batch).padStart(3,'0')}-${name}-${i + 1}.sql`;
    writeFileSync(join(target, file), `begin;\n${query}\ncommit;\n`);
  }
};
const chunk = (items, n) => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, (i + 1) * n));
const values = (items, map) => items.map(map).map((x) => `(${x.map(sql).join(',')})`).join(',\n');

const vehicles = rows('Bus Demographics');
const inspections = rows('Inspections');
const identifiers = new Set(vehicles.map((r) => clean(r['Bus ID'])));
if (identifiers.size !== vehicles.length || identifiers.has(null)) throw new Error('Bus ID is missing or duplicated.');

emit('vehicles', [
  `insert into public.buses
    (bus_number, year, make, model, vin, current_mileage, notes, dot_inspection_due_date, vehicle_type,
     fuel_type, capacity, mileage_as_of, engine_serial, body_serial, chassis_serial,
     transmission_serial, body_service_number, engine_type, bliss_bus, source_system)
   values ${values(vehicles, (r) => [
    clean(r['Bus ID']), /^\d{4}$/.test(clean(r.Year) || '') ? +r.Year : null,
    /^blu(?:bird|e ?bird)$/i.test(clean(r.Make) || '') ? 'Blue Bird' : clean(r.Make), clean(r.Model), clean(r.Vin), Math.max(0, Number(r.Mileage) || 0),
    [clean(r['Bus Demographic Note']), clean(r['Watch List']) && `Watch list: ${clean(r['Watch List'])}`].filter(Boolean).join('\n') || null,
    inspections.filter((x) => clean(x['Bus ID']) === clean(r['Bus ID']) && x['Inspection Type'] === 'Annual' && date(x['Next Annual Due']))
      .map((x) => date(x['Next Annual Due'])).sort().at(-1) || null,
    /truck/i.test(r['Bus ID']) ? 'Truck' : /van/i.test(r['Bus ID']) ? 'Van' : /tahoe|grand prix/i.test(r['Bus ID']) ? 'Car / SUV' : 'Bus',
    clean(r['Fuel Type']), r.Capacity, date(r['Mileage Date']), clean(r['Engine SN']),
    clean(r['Body SN']), clean(r['Chassis SN']), clean(r['Transmission SN']),
    clean(r['Body Service #']), clean(r['Engine Type']), r['Bliss Bus'], 'GFSD Access',
  ])}
   on conflict (bus_number) do nothing;`,
  `insert into public.mileage_log (id, bus_id, mileage, date_recorded, source, notes)
   select v.id::uuid, b.id, v.mileage::integer, v.recorded_at::timestamptz, 'MANUAL', 'Imported current odometer from GFSD Access'
   from (values ${values(vehicles.filter((r) => r.Mileage != null && date(r['Mileage Date'])), (r) => [
     uuid('GFSD-mileage', clean(r['Bus ID'])), clean(r['Bus ID']), r.Mileage, `${date(r['Mileage Date'])}T12:00:00Z`,
   ])}) as v(id, bus_number, mileage, recorded_at)
   join public.buses b on b.bus_number = v.bus_number
   where v.mileage::integer >= b.current_mileage
     and not exists (select 1 from public.mileage_log m where m.id = v.id::uuid);`,
]);

// For existing fleet records, preserve manual edits and never lower the odometer.
// Only the 30 matched source vehicles get equipment detail rows.
const specs = rows('Misc Specifications');
const tires = rows('tbl Tires');
const filters = rows('Filters');
const details = vehicles.map((r) => {
  const id = clean(r['Bus ID']);
  return [id, specs.find((s) => clean(s['Bus ID']) === id) || {},
    tires.find((s) => clean(s['Bus ID']) === id) || {},
    filters.filter((f) => clean(f['Bus ID']) === id)];
});
emit('vehicle-details', [
  `insert into public.vehicle_details (bus_id, specifications, tires, filters)
   select b.id, v.specifications::jsonb, v.tires::jsonb, v.filters::jsonb
   from (values ${values(details, ([id, s, t, f]) => [id, JSON.stringify(s), JSON.stringify(t), JSON.stringify(f)])})
     as v(bus_number, specifications, tires, filters)
   join public.buses b on b.bus_number = v.bus_number
   on conflict (bus_id) do nothing;`,
]);

const service = rows('Service');
const lof = rows('LOF');
const parts = rows('Service Parts');
const attachedParts = new Map();
for (const part of parts) {
  const key = part['Service ID'];
  attachedParts.set(key, [...(attachedParts.get(key) || []), part]);
}

// Every source row is retained under a stable table/row key, including
// undated inspections and service with no bus ID. Drivers are admin-only.
const sourceNames = [
  'Bus Demographics', 'Filter Stock Level', 'Filter Type Pick List', 'Filters',
  'Inspections', 'LOF', 'Misc Specifications', 'Service', 'Service Parts',
  'tbl Status Board Admin', 'tbl Tires', 'tbl Drivers',
];
for (const name of sourceNames) {
  const records = name === 'tbl Drivers'
    ? rows(name).map((r) => ({
        'Driver ID': r['Driver ID'], LName: r.LName, FName: r.FName, MI: r.MI,
        'License Exp': r['License Exp'], 'DOT Physical Expire': r['DOT Physical Expire'],
        Placeholder: r.Placeholder,
      }))
    : rows(name);
  emit(`archive-${name.replaceAll(/[^a-z0-9]+/gi,'-').toLowerCase()}`,
    chunk(records, 100).map((group, groupIndex) =>
      `insert into public.access_import_rows (source_table, source_key, bus_id, source_data)
       select v.source_table, v.source_key, b.id, v.source_data::jsonb
       from (values ${values(group, (r, index) => [
          name, name === 'Service' ? `service:${r['Service ID']}` :
          name === 'tbl Drivers' ? `driver:${r['Driver ID'] ?? `row-${groupIndex * 100 + index + 1}`}` : `row:${groupIndex * 100 + index + 1}`,
          clean(r['Bus ID']), JSON.stringify(r),
        ])}) as v(source_table, source_key, bus_number, source_data)
       left join public.buses b on b.bus_number = v.bus_number
       on conflict (source_table, source_key) do nothing;`));
}

// Separate standard school inspections from repairs so compliance can use
// due dates already recorded in Access. Do not invent completion dates.
emit('inspection-templates', [
  `insert into public.maintenance_items
    (name, category, default_interval_days, is_regulatory, priority, description)
   select v.name, v.category::public.maintenance_category, v.days, v.regulatory, v.priority::public.priority_level, v.description
   from (values
     ('60-Day Inspection', 'COMPLIANCE', 60, true, 'CRITICAL', 'District 60-day vehicle inspection'),
     ('Vehicle Inspection', 'COMPLIANCE', null, true, 'HIGH', 'Legacy vehicle inspection with an unspecified type'),
     ('Unscheduled Repair', 'OTHER', null, false, 'MEDIUM', 'Corrective service or repair imported from the legacy system')
   ) as v(name, category, days, regulatory, priority, description)
   where not exists (select 1 from public.maintenance_items mi where mi.name = v.name);`,
]);

const events = [
  ...service.filter((r) => identifiers.has(clean(r['Bus ID'])) && date(r['Service Date']))
    .map((r) => ({
      key: `service:${r['Service ID']}`, bus: clean(r['Bus ID']), day: date(r['Service Date']),
      miles: r.Mileage, item: 'Unscheduled Repair',
      description: [r.Problem && `Problem: ${r.Problem}`, r['Service Performed'] && `Work: ${r['Service Performed']}`].filter(Boolean).join('\n'),
      notes: [r.Disposition && `Disposition: ${r.Disposition}`, r['Time In'] && `Time in: ${String(r['Time In']).slice(11,16)}`, r['Time Out'] && `Time out: ${String(r['Time Out']).slice(11,16)}`].filter(Boolean).join('\n'),
      workOrder: clean(r['Invoice #']), parts: attachedParts.get(r['Service ID']) || [], dueMiles: null, dueDate: null,
    })),
  ...inspections.filter((r) => identifiers.has(clean(r['Bus ID'])) && date(r['Inspection Date']))
    .map((r, i) => ({
      key: `inspection:${i}:${r['Bus ID']}:${r['Inspection Date']}`, bus: clean(r['Bus ID']), day: date(r['Inspection Date']),
      miles: null, item: r['Inspection Type'] === 'Annual' ? 'Annual DOT Inspection' : r['Inspection Type'] === '60-Day' ? '60-Day Inspection' : 'Vehicle Inspection',
      description: `${r['Inspection Type'] || 'Unspecified'} inspection`, notes: clean(r['Inspection Notes']),
      workOrder: null, parts: [], dueMiles: null,
      dueDate: date(r['Inspection Type'] === 'Annual' ? r['Next Annual Due'] : r['Next 60 Day Due']),
    })),
  ...lof.filter((r) => identifiers.has(clean(r['Bus ID'])) && date(r['LOF Date']))
    .map((r, i) => ({
      key: `lof:${i}:${r['Bus ID']}:${r['LOF Date']}`, bus: clean(r['Bus ID']), day: date(r['LOF Date']),
      miles: r.Mileage, item: 'Engine Oil & Filter Change', description: 'Lube / oil / filter service',
      notes: clean(r['LOF Note']), workOrder: null, parts: [], dueMiles: r['Next Service Due'], dueDate: null,
    })),
];

emit('maintenance', chunk(events, 100).map((group) =>
  `insert into public.maintenance_logs
   (id, bus_id, maintenance_item_id, date_performed, mileage_at_service,
    description, notes, work_order_number, parts_used, next_due_date, next_due_mileage)
   select v.id::uuid, b.id, mi.id, v.day::date, v.miles::integer,
          v.description, v.notes, v.work_order, v.parts::jsonb, v.due_date::date, v.due_miles::integer
   from (values ${values(group, (e) => [uuid('GFSD-maintenance', e.key), e.bus, e.item, e.day,
     e.miles, e.description, e.notes, e.workOrder, JSON.stringify(e.parts), e.dueDate, e.dueMiles])})
   as v(id, bus_number, item_name, day, miles, description, notes, work_order, parts, due_date, due_miles)
   join public.buses b on b.bus_number = v.bus_number
   left join public.maintenance_items mi on mi.name = v.item_name
   on conflict (id) do nothing;`));

const schedules = [];
for (const bus of identifiers) {
  for (const [type, itemName, dueColumn] of [
    ['Annual', 'Annual DOT Inspection', 'Next Annual Due'],
    ['60-Day', '60-Day Inspection', 'Next 60 Day Due'],
  ]) {
    const history = inspections.filter((r) => clean(r['Bus ID']) === bus && r['Inspection Type'] === type && date(r['Inspection Date']))
      .sort((a, b) => date(b['Inspection Date']).localeCompare(date(a['Inspection Date'])));
    if (!history.length) continue;
    const latest = history[0];
    const explicit = date(latest[dueColumn]);
    const due = explicit && explicit > date(latest['Inspection Date']) ? explicit : null;
    schedules.push([bus, itemName, date(latest['Inspection Date']), due, null]);
  }
  const history = lof.filter((r) => clean(r['Bus ID']) === bus && date(r['LOF Date']))
    .sort((a,b) => date(b['LOF Date']).localeCompare(date(a['LOF Date'])));
  if (history.length) {
    const latest = history[0];
    const next = Number(latest['Next Service Due']);
    schedules.push([bus, 'Engine Oil & Filter Change', date(latest['LOF Date']),
      next > Number(latest.Mileage || 0) ? next : null, latest.Mileage]);
  }
}
emit('schedules', [
  `insert into public.bus_maintenance_schedules
   (bus_id, maintenance_item_id, last_completed_date, next_due_date,
    last_completed_mileage, next_due_mileage, custom_interval_miles,
    notes)
   select b.id, mi.id, v.last_date::date,
      case when v.item_name = 'Annual DOT Inspection' then coalesce(v.next_due::date, v.last_date::date + 365)
           when v.item_name = '60-Day Inspection' then coalesce(v.next_due::date, v.last_date::date + 60)
           else null end,
      v.last_miles::integer,
      case when v.item_name = 'Engine Oil & Filter Change' then v.next_due::integer else null end,
      case when v.item_name = 'Engine Oil & Filter Change' and v.next_due::integer > v.last_miles::integer
           then v.next_due::integer - v.last_miles::integer else null end,
      'Imported from GFSD Access; review inspection labels and service intervals.'
   from (values ${values(schedules, (v) => v)})
      as v(bus_number, item_name, last_date, next_due, last_miles)
   join public.buses b on b.bus_number = v.bus_number
   join public.maintenance_items mi on mi.name = v.item_name
   where not exists (
     select 1 from public.bus_maintenance_schedules s
     where s.bus_id = b.id and s.maintenance_item_id = mi.id and s.is_active
   );`,
]);

writeFileSync(join(target, 'manifest.json'), JSON.stringify({
  vehicles: vehicles.length, events: events.length, schedules: schedules.length,
  sourceTables: Object.fromEntries(sourceNames.map((name) => [name, rows(name).length])),
  batches: batch,
}, null, 2));
console.log(`Prepared ${batch} SQL batches for ${vehicles.length} vehicles, ${events.length} dated events, ${schedules.length} schedules.`);
