// Realistic fixture data, shaped exactly like the live PostgREST responses
// (including embedded `bus:` and `item:` relations).

export const today = new Date(2026, 8, 5, 10, 0); // Sat 5 Sep 2026

const d = (offsetDays) => {
  const date = new Date(today);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const buses = [
  { id: '535c194b-97cb-47a6-892e-7dd2a6e30b65', bus_number: '101', nickname: 'Big Blue', vin: '1BAANKCL1JF123456', year: 2018, make: 'Blue Bird', model: 'Vision', license_plate: 'ID-BUS101', license_plate_expiration: d(200), current_mileage: 145230, engine_hours: null, date_acquired: '2018-07-01', status: 'ACTIVE', dot_inspection_due_date: d(20), insurance_expiration_date: d(150), registration_expiration_date: d(90), notes: null },
  { id: '6f8305a3-1d69-47c2-b2c0-3fbb1c9754ab', bus_number: '102', nickname: 'Old Betsy <script>alert(1)</script>', vin: '1T88F4A25FJ654321', year: 2015, make: 'Thomas Built', model: 'Saf-T-Liner C2', license_plate: 'ID-BUS102', license_plate_expiration: d(60), current_mileage: 210500, engine_hours: null, date_acquired: '2015-06-15', status: 'ACTIVE', dot_inspection_due_date: d(-5), insurance_expiration_date: d(40), registration_expiration_date: d(55), notes: null },
  { id: '2c940207-c872-4830-a736-c366b2742efc', bus_number: '103', nickname: null, vin: '4UZAAJAK2ND234567', year: 2021, make: 'IC Bus', model: 'CE Series', license_plate: 'ID-BUS103', license_plate_expiration: d(300), current_mileage: 62000, engine_hours: null, date_acquired: '2021-03-10', status: 'ACTIVE', dot_inspection_due_date: d(250), insurance_expiration_date: d(200), registration_expiration_date: d(200), notes: null },
  { id: 'd0a9d4fb-0ed1-48ca-b3d8-f966a83017bc', bus_number: '104', nickname: null, vin: '1BAANKCL0CF345678', year: 2012, make: 'Blue Bird', model: 'All American', license_plate: 'ID-BUS104', license_plate_expiration: d(10), current_mileage: 305000, engine_hours: null, date_acquired: '2012-08-20', status: 'OUT_OF_SERVICE', dot_inspection_due_date: d(-40), insurance_expiration_date: d(-20), registration_expiration_date: d(15), notes: 'Awaiting transmission rebuild' },
  { id: 'c5df39d5-ec72-40b4-97dc-59415760e2b3', bus_number: '105', nickname: 'Sparky', vin: '1BAANKCL9NF987654', year: 2023, make: 'Blue Bird', model: 'Vision Electric', license_plate: 'ID-BUS105', license_plate_expiration: d(320), current_mileage: 15000, engine_hours: null, date_acquired: '2023-11-01', status: 'ACTIVE', dot_inspection_due_date: d(300), insurance_expiration_date: d(300), registration_expiration_date: d(300), notes: null },
  { id: 'a1111111-1111-4111-8111-111111111111', bus_number: '106', nickname: null, vin: null, year: null, make: null, model: null, license_plate: null, license_plate_expiration: null, current_mileage: 0, engine_hours: null, date_acquired: null, status: 'ACTIVE', dot_inspection_due_date: null, insurance_expiration_date: null, registration_expiration_date: null, notes: null },
];

export const items = [
  { id: 'cddcaf27-3ae1-408b-87d5-6e2165abe843', name: 'Engine Oil & Filter Change', description: null, category: 'ENGINE', default_interval_miles: 5000, default_interval_days: 90, default_interval_engine_hours: null, is_regulatory: false, estimated_duration_minutes: 60, priority: 'HIGH', is_active: true },
  { id: '1cddb4ca-6348-49f9-80ab-c34739d36894', name: 'Annual DOT Inspection', description: null, category: 'COMPLIANCE', default_interval_miles: null, default_interval_days: 365, default_interval_engine_hours: null, is_regulatory: true, estimated_duration_minutes: 120, priority: 'CRITICAL', is_active: true },
  { id: '44b3026f-e412-4c53-ab18-7bbb051b35b4', name: 'Brake Inspection', description: null, category: 'BRAKES', default_interval_miles: 10000, default_interval_days: 90, default_interval_engine_hours: null, is_regulatory: true, estimated_duration_minutes: 90, priority: 'CRITICAL', is_active: true },
  { id: '2812ddc5-c116-4ba6-8cf5-b74fc77393d6', name: 'Tire Inspection & Rotation', description: null, category: 'TIRES', default_interval_miles: 7500, default_interval_days: 90, default_interval_engine_hours: null, is_regulatory: false, estimated_duration_minutes: 45, priority: 'HIGH', is_active: true },
  { id: '13699fd9-de16-4519-86e2-89e0e2e0542c', name: 'Fire Extinguisher Inspection', description: null, category: 'SAFETY_EQUIPMENT', default_interval_miles: null, default_interval_days: 180, default_interval_engine_hours: null, is_regulatory: true, estimated_duration_minutes: 15, priority: 'CRITICAL', is_active: true },
  { id: 'e800e0ea-b8a9-4f8a-aba5-97853fee01be', name: 'HVAC System Check', description: null, category: 'HVAC', default_interval_miles: null, default_interval_days: 180, default_interval_engine_hours: null, is_regulatory: false, estimated_duration_minutes: null, priority: 'LOW', is_active: true },
];

const bus = (n) => buses.find((b) => b.bus_number === n);
const item = (name) => items.find((i) => i.name === name);

const sched = (id, busNumber, itemName, extra) => ({
  id, bus_id: bus(busNumber).id, maintenance_item_id: item(itemName).id,
  custom_interval_miles: null, custom_interval_days: null, custom_interval_engine_hours: null,
  last_completed_date: null, last_completed_mileage: null, last_completed_engine_hours: null,
  next_due_date: null, next_due_mileage: null, next_due_engine_hours: null, is_active: true, notes: null,
  bus: bus(busNumber), item: item(itemName), ...extra,
});

export const schedules = [
  sched('s1', '101', 'Engine Oil & Filter Change', { last_completed_date: d(-100), last_completed_mileage: 139730, next_due_date: d(-10), next_due_mileage: 144730 }), // overdue both
  sched('s2', '101', 'Tire Inspection & Rotation', { last_completed_date: d(-86), next_due_date: d(4), next_due_mileage: 148230 }), // due this week
  sched('s3', '101', 'Annual DOT Inspection', { last_completed_date: d(-345), next_due_date: d(20) }), // 20 days, <25% -> due-soon but NOT this week
  sched('s4', '101', 'Brake Inspection', { last_completed_date: d(-90), next_due_date: d(0), next_due_mileage: 155280 }), // due today
  sched('s5', '102', 'Annual DOT Inspection', { last_completed_date: d(-370), next_due_date: d(-5) }),
  sched('s6', '102', 'Brake Inspection', { next_due_date: d(45), next_due_mileage: 210900 }), // mileage watch: 400 mi left
  sched('s7', '103', 'Engine Oil & Filter Change', { next_due_date: d(80), next_due_mileage: 66500 }),
  sched('s8', '103', 'Fire Extinguisher Inspection', { next_due_date: d(170) }),
  sched('s9', '104', 'Engine Oil & Filter Change', { next_due_date: d(-200), next_due_mileage: 290000 }), // OOS bus
  sched('s10', '105', 'HVAC System Check', { next_due_date: d(150) }),
  sched('s11', '105', 'Brake Inspection', {}), // unscheduled: no dates at all
];

export const defects = [
  { id: 'df1', bus_id: bus('102').id, reported_by: 'J. Alvarez', reported_date: new Date(today.getTime() - 86400000).toISOString(), category: 'BODY_EXTERIOR', severity: 'MINOR', description: 'Rear left window seal peeling', status: 'REPORTED', resolution_description: null, resolved_date: null, resolved_by: null, maintenance_log_id: null, photos: [], is_bus_safe_to_operate: true, bus: bus('102') },
  { id: 'df2', bus_id: bus('101').id, reported_by: 'M. Chen', reported_date: new Date(today.getTime() - 3 * 86400000).toISOString(), category: 'BRAKES', severity: 'MAJOR', description: 'Grinding noise on front brakes at low speed', status: 'ACKNOWLEDGED', resolution_description: null, resolved_date: null, resolved_by: null, maintenance_log_id: null, photos: [], is_bus_safe_to_operate: true, bus: bus('101') },
  { id: 'df3', bus_id: bus('104').id, reported_by: 'Shop', reported_date: new Date(today.getTime() - 30 * 86400000).toISOString(), category: 'DRIVETRAIN', severity: 'SAFETY_CRITICAL', description: 'Transmission slipping under load', status: 'IN_PROGRESS', resolution_description: null, resolved_date: null, resolved_by: null, maintenance_log_id: null, photos: [], is_bus_safe_to_operate: false, bus: bus('104') },
];

export const maintenanceLogs = [
  { id: 'l1', bus_id: bus('101').id, maintenance_item_id: item('Engine Oil & Filter Change').id, bus_maintenance_schedule_id: null, date_performed: d(-94), mileage_at_service: 140230, engine_hours_at_service: null, performed_by: 'Valley Fleet Shop', cost: 512.75, parts_cost: 302.75, labor_cost: 210, vendor: 'Valley Fleet Shop', work_order_number: 'WO-260603-101', description: 'Routine oil and filter service.', parts_used: [], next_due_date: null, next_due_mileage: null, attachments: [], notes: null, created_at: d(-94), bus: bus('101'), item: item('Engine Oil & Filter Change') },
  { id: 'l2', bus_id: bus('102').id, maintenance_item_id: item('Brake Inspection').id, bus_maintenance_schedule_id: null, date_performed: d(-187), mileage_at_service: 197600, engine_hours_at_service: null, performed_by: 'Valley Fleet Shop', cost: 1860.4, parts_cost: 1210.4, labor_cost: 650, vendor: 'Valley Fleet Shop', work_order_number: 'WO-260302-102', description: 'Replaced front pads and serviced calipers.', parts_used: [], next_due_date: null, next_due_mileage: null, attachments: [], notes: null, created_at: d(-187), bus: bus('102'), item: item('Brake Inspection') },
  { id: 'l3', bus_id: bus('104').id, maintenance_item_id: null, bus_maintenance_schedule_id: null, date_performed: d(-3), mileage_at_service: 305000, engine_hours_at_service: null, performed_by: 'Heavy Duty Transmissions', cost: 4200, parts_cost: 3100, labor_cost: 1100, vendor: 'Heavy Duty Transmissions', work_order_number: '=HYPERLINK("http://evil")', description: 'Transmission diagnosis', parts_used: [], next_due_date: null, next_due_mileage: null, attachments: [], notes: null, created_at: d(-3), bus: bus('104'), item: null },
  { id: 'l4', bus_id: bus('105').id, maintenance_item_id: item('Engine Oil & Filter Change').id, bus_maintenance_schedule_id: null, date_performed: d(-32), mileage_at_service: 14200, engine_hours_at_service: null, performed_by: 'Valley Fleet Shop', cost: 410, parts_cost: 250, labor_cost: 160, vendor: 'Valley Fleet Shop', work_order_number: 'WO-260804-105', description: 'Initial fleet oil service and inspection.', parts_used: [], next_due_date: null, next_due_mileage: null, attachments: [], notes: null, created_at: d(-32), bus: bus('105'), item: item('Engine Oil & Filter Change') },
];

export const mileageLogs = [];
[['101', 130200, 145230], ['102', 191800, 210500], ['103', 51800, 62000], ['104', 289500, 305000], ['105', 6200, 15000]].forEach(([n, start, end]) => {
  for (let i = 0; i <= 6; i++) {
    const date = new Date(today);
    date.setMonth(date.getMonth() - (6 - i));
    mileageLogs.push({ id: `m-${n}-${i}`, bus_id: bus(n).id, mileage: Math.round(start + ((end - start) * i) / 6), engine_hours: null, date_recorded: date.toISOString(), source: 'MANUAL', notes: null });
  }
});

export const settings = [
  { key: 'timezone', value: 'America/Denver' },
  { key: 'dashboard_auto_refresh_seconds', value: 60 },
  { key: 'dashboard_auto_rotate_seconds', value: 30 },
];
