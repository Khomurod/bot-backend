/**
 * DataTruck adapter — pure mapping tests.
 *
 * Fixtures mirror the LIVE-verified response shapes of the wenze DataTruck
 * OpenAPI (orders/, trucks/list/, trailers/list/, drivers/list/). No network,
 * no config, no credentials.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { orderToLoad, mapOrderStatus, normalizeUnit, mapEquipment, mapDriver } = require('../server/fleet/dataTruckAdapter');

const ORDER_FIXTURE = {
  id: 14384, load_id: 14384889101, shipment_id: 'DT-014384', status: 'dispatched',
  load_pay: 1500.5, total_pay: 1600.25, total_other_pay: 99.75, total_miles: 765,
  per_mile_revenue: 1.96,
  dispatcher__full_name: 'Alex Dispatcher', customer__company_name: 'HUB GROUP',
  mc_number__company_name: 'Wenze Carrier',
  pickup_time: '2026-07-06T16:00:00Z', delivery_time: '2026-07-08T14:00:00Z',
  pickup_appointment_time: null, delivery_appointment_time: null,
  stops: [
    { stop_type: 'pickup', location: { company: 'Shipper Co', city: 'Chicago', state: 'IL' } },
    { stop_type: 'delivery', location: { company: 'Receiver Co', city: 'Dallas', state: 'TX' } },
  ],
  trip: { id: 900, trip_id: 88, status: 'dispatched', mile: 765, driver__full_name: 'TEST DRIVER', team_driver__full_name: null, truck__unit_number: '2614 COMPANY' },
};

test('orderToLoad maps live order shape to FleetView load', () => {
  const l = orderToLoad(ORDER_FIXTURE);
  assert.strictEqual(l.load_number, '14384889101');
  assert.strictEqual(l.trip_number, '88');
  assert.strictEqual(l.status, 'dispatched');
  assert.strictEqual(l.driver_name, 'TEST DRIVER');
  assert.strictEqual(l.dispatcher_name, 'Alex Dispatcher');
  assert.strictEqual(l.broker_name, 'HUB GROUP');
  assert.strictEqual(l.truck_unit, '2614');
  assert.strictEqual(l.hauling_rate, 150050);   // $1500.50 → cents
  assert.strictEqual(l.total_pay, 160025);
  assert.strictEqual(l.rpm, 1.96);              // TMS per_mile_revenue used directly
  assert.strictEqual(l.planned_distance_miles, 765);
  assert.strictEqual(l.origin_label, 'Chicago, IL');
  assert.strictEqual(l.destination_label, 'Dallas, TX');
  assert.strictEqual(l.assigned_rate, null);    // settlement not exposed → honest null
  assert.strictEqual(l.pickup_window_start, '2026-07-06T16:00:00Z');
  assert.strictEqual(l.external_id, '14384');
  assert.strictEqual(l.source, 'datatruck');
});

test('orderToLoad computes RPM only when TMS omits it, never fabricates', () => {
  const noRpm = orderToLoad({ ...ORDER_FIXTURE, per_mile_revenue: null });
  assert.strictEqual(noRpm.rpm, Math.round((150050 / 100 / 765) * 100) / 100);
  const noRate = orderToLoad({ ...ORDER_FIXTURE, per_mile_revenue: null, load_pay: null, total_pay: null });
  assert.strictEqual(noRate.hauling_rate, null);
  assert.strictEqual(noRate.rpm, null);
});

test('mapOrderStatus covers observed DataTruck statuses', () => {
  assert.strictEqual(mapOrderStatus('dispatched'), 'dispatched');
  assert.strictEqual(mapOrderStatus('In Transit'), 'in_transit');
  assert.strictEqual(mapOrderStatus('Delivered'), 'delivered');
  assert.strictEqual(mapOrderStatus('Completed'), 'delivered');
  assert.strictEqual(mapOrderStatus('Cancelled'), 'canceled');
  assert.strictEqual(mapOrderStatus('picked up'), 'in_transit');
});

test('normalizeUnit extracts numeric unit and strips leading zeros', () => {
  assert.strictEqual(normalizeUnit('2614 COMPANY'), '2614');
  assert.strictEqual(normalizeUnit('0132 arslan'), '132');
  assert.strictEqual(normalizeUnit('305'), '305');
  assert.strictEqual(normalizeUnit(null), null);
});

test('mapEquipment maps live truck/trailer rows', () => {
  const truck = mapEquipment({ id: 7, unit_number: '0132 arslan', plate_number: 'P4429', vin: '4V4NC9EH0RN000000', make: 'VLV', model: 'VNL', year: 2024, status: 'Available', state: 'IL', assigned_driver: { id: 3, full_name: 'A Driver' } }, 'truck');
  assert.strictEqual(truck.id, 'dt_truck_7');
  assert.strictEqual(truck.vin.length, 17);
  assert.strictEqual(truck.operated_by, 'A Driver');
  assert.strictEqual(truck.status, 'available');
  const trailer = mapEquipment({ id: 9, unit_number: 'T55', status: 'available', driver_operator: { full_name: 'B Driver' } }, 'trailer');
  assert.strictEqual(trailer.type, 'trailer');
  assert.strictEqual(trailer.operated_by, 'B Driver');
});

test('mapDriver maps live roster rows incl. dispatcher/truck/contact', () => {
  const d = mapDriver({
    id: 12, account: { full_name: 'REAL DRIVER', email: 'x@y.com' }, driver_type: 'company_owner',
    contact_number: '+15550002222', employee_status: 'Active',
    assigned_truck: { unit_number: '2614' }, assigned_trailer: { unit_number: 'T7' },
    assigned_dispatcher: { full_name: 'Alex Dispatcher' }, hire_date: '2024-01-01',
  });
  assert.strictEqual(d.display_name, 'REAL DRIVER');
  assert.strictEqual(d.position, 'owner_operator');
  assert.strictEqual(d.truck_unit, '2614');
  assert.strictEqual(d.trailer_unit, 'T7');
  assert.strictEqual(d.dispatcher_name, 'Alex Dispatcher');
  assert.strictEqual(d.phone_e164, '+15550002222');
  assert.strictEqual(d.status, 'active');
});
