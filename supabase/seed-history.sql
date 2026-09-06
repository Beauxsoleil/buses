-- Synthetic history for the five demonstration buses. Safe to rerun because
-- every row uses a stable UUID and ON CONFLICT DO NOTHING.

with seed(
  id, bus_number, item_name, date_performed, mileage_at_service,
  performed_by, cost, parts_cost, labor_cost, vendor,
  work_order_number, description
) as (
  values
    ('20000000-0000-0000-0000-000000000001'::uuid,'101','Engine Oil & Filter Change','2026-02-20'::date,133100,'Valley Fleet Shop',486.20,286.20,200.00,'Valley Fleet Shop','WO-260220-101','Replaced engine oil and filters; inspected for leaks.'),
    ('20000000-0000-0000-0000-000000000002'::uuid,'101','Brake Inspection','2026-03-18'::date,135420,'M. Chen',275.00,35.00,240.00,'In-house','WO-260318-101','Inspected pads, rotors, lines, and air-brake operation.'),
    ('20000000-0000-0000-0000-000000000003'::uuid,'101','Tire Inspection & Rotation','2026-05-12'::date,139880,'J. Alvarez',390.00,120.00,270.00,'In-house','WO-260512-101','Rotated tires and recorded tread depth at all positions.'),
    ('20000000-0000-0000-0000-000000000004'::uuid,'101','Engine Oil & Filter Change','2026-06-03'::date,140230,'Valley Fleet Shop',512.75,302.75,210.00,'Valley Fleet Shop','WO-260603-101','Routine oil and filter service.'),
    ('20000000-0000-0000-0000-000000000005'::uuid,'102','Annual DOT Inspection','2026-01-28'::date,194800,'Interstate Inspection',625.00,75.00,550.00,'Interstate Inspection','DOT-102-2026','Annual inspection completed; minor lighting correction made.'),
    ('20000000-0000-0000-0000-000000000006'::uuid,'102','Brake Inspection','2026-03-02'::date,197600,'Valley Fleet Shop',1860.40,1210.40,650.00,'Valley Fleet Shop','WO-260302-102','Replaced front pads and serviced calipers.'),
    ('20000000-0000-0000-0000-000000000007'::uuid,'102','Battery Check','2026-05-19'::date,203950,'J. Alvarez',168.00,108.00,60.00,'In-house','WO-260519-102','Load tested batteries and cleaned terminals.'),
    ('20000000-0000-0000-0000-000000000008'::uuid,'102','Tire Inspection & Rotation','2026-07-14'::date,207820,'Mountain Tire',740.00,520.00,220.00,'Mountain Tire','MT-77102','Rotation, balance, and replacement of one damaged tire.'),
    ('20000000-0000-0000-0000-000000000009'::uuid,'103','Engine Oil & Filter Change','2026-03-26'::date,55200,'Valley Fleet Shop',438.50,258.50,180.00,'Valley Fleet Shop','WO-260326-103','Routine oil and filter service.'),
    ('20000000-0000-0000-0000-000000000010'::uuid,'103','Tire Inspection & Rotation','2026-06-21'::date,58500,'Mountain Tire',315.00,95.00,220.00,'Mountain Tire','MT-63103','Rotated tires and checked alignment.'),
    ('20000000-0000-0000-0000-000000000011'::uuid,'104','Transmission Fluid Check','2026-02-10'::date,292700,'Heavy Duty Transmissions',1245.00,785.00,460.00,'Heavy Duty Transmissions','HDT-104-22','Transmission service and fluid analysis.'),
    ('20000000-0000-0000-0000-000000000012'::uuid,'104','Steering & Suspension Check','2026-04-22'::date,297900,'Valley Fleet Shop',2135.65,1435.65,700.00,'Valley Fleet Shop','WO-260422-104','Replaced worn tie-rod end and aligned front axle.'),
    ('20000000-0000-0000-0000-000000000013'::uuid,'104','Engine Oil & Filter Change','2026-06-30'::date,301850,'Valley Fleet Shop',559.30,329.30,230.00,'Valley Fleet Shop','WO-260630-104','Routine oil and filter service.'),
    ('20000000-0000-0000-0000-000000000014'::uuid,'105','Lights & Signals Check','2026-06-12'::date,12100,'J. Alvarez',94.00,54.00,40.00,'In-house','WO-260612-105','Replaced two marker lamps and verified all signals.'),
    ('20000000-0000-0000-0000-000000000015'::uuid,'105','Engine Oil & Filter Change','2026-08-04'::date,14200,'Valley Fleet Shop',410.00,250.00,160.00,'Valley Fleet Shop','WO-260804-105','Initial fleet oil service and inspection.')
)
insert into public.maintenance_logs (
  id, bus_id, maintenance_item_id, date_performed, mileage_at_service,
  performed_by, cost, parts_cost, labor_cost, vendor, work_order_number,
  description, parts_used, attachments
)
select
  seed.id, b.id, mi.id, seed.date_performed, seed.mileage_at_service,
  seed.performed_by, seed.cost, seed.parts_cost, seed.labor_cost,
  seed.vendor, seed.work_order_number, seed.description, '[]'::jsonb, '[]'::jsonb
from seed
join public.buses b on b.bus_number = seed.bus_number
join public.maintenance_items mi on mi.name = seed.item_name
on conflict (id) do nothing;

with seed(id, bus_number, mileage, date_recorded) as (
  values
    ('30000000-0000-0000-0000-000000000001'::uuid,'101',130200,'2026-03-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000002'::uuid,'101',134000,'2026-04-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000003'::uuid,'101',137750,'2026-05-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000004'::uuid,'101',141050,'2026-06-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000005'::uuid,'101',142650,'2026-07-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000006'::uuid,'101',144100,'2026-08-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000007'::uuid,'101',145230,'2026-09-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000008'::uuid,'102',191800,'2026-03-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000009'::uuid,'102',196100,'2026-04-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000010'::uuid,'102',200050,'2026-05-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000011'::uuid,'102',203850,'2026-06-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000012'::uuid,'102',206700,'2026-07-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000013'::uuid,'102',208900,'2026-08-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000014'::uuid,'102',210500,'2026-09-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000015'::uuid,'103',51800,'2026-03-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000016'::uuid,'103',53900,'2026-04-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000017'::uuid,'103',55850,'2026-05-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000018'::uuid,'103',57700,'2026-06-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000019'::uuid,'103',59400,'2026-07-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000020'::uuid,'103',60750,'2026-08-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000021'::uuid,'103',62000,'2026-09-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000022'::uuid,'104',289500,'2026-03-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000023'::uuid,'104',294100,'2026-04-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000024'::uuid,'104',297800,'2026-05-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000025'::uuid,'104',300250,'2026-06-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000026'::uuid,'104',302300,'2026-07-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000027'::uuid,'104',304400,'2026-08-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000028'::uuid,'104',305000,'2026-09-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000029'::uuid,'105',6200,'2026-03-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000030'::uuid,'105',7900,'2026-04-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000031'::uuid,'105',9500,'2026-05-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000032'::uuid,'105',11100,'2026-06-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000033'::uuid,'105',12600,'2026-07-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000034'::uuid,'105',13900,'2026-08-05 12:00:00+00'::timestamptz),
    ('30000000-0000-0000-0000-000000000035'::uuid,'105',15000,'2026-09-05 12:00:00+00'::timestamptz)
)
insert into public.mileage_log (id, bus_id, mileage, date_recorded, source, notes)
select seed.id, b.id, seed.mileage, seed.date_recorded, 'MANUAL'::mileage_source, 'Synthetic monthly demo reading'
from seed
join public.buses b on b.bus_number = seed.bus_number
on conflict (id) do nothing;
