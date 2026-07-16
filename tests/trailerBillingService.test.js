'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const{calculateBillableDays,calculateInvoice}=require('../services/trailerBillingService');

test('calendar-day billing counts local dates inclusively',()=>{
  const result=calculateBillableDays({startAt:'2026-07-16T04:30:00Z',endAt:'2026-07-16T06:30:00Z',billingMethod:'calendar_day',timezone:'America/Chicago'});
  assert.equal(result.billableDays,2);
});
test('24-hour billing rounds partial periods up with a one-day minimum',()=>{
  assert.equal(calculateBillableDays({startAt:'2026-01-01T00:00:00Z',endAt:'2026-01-01T00:01:00Z',billingMethod:'twenty_four_hour'}).billableDays,1);
  assert.equal(calculateBillableDays({startAt:'2026-01-01T00:00:00Z',endAt:'2026-01-03T00:00:01Z',billingMethod:'twenty_four_hour'}).billableDays,3);
});
test('manual days require count and reason',()=>{
  assert.throws(()=>calculateBillableDays({startAt:'2026-01-01',endAt:'2026-01-02',billingMethod:'manual_days',manualDays:2}),/reason/);
  assert.equal(calculateBillableDays({startAt:'2026-01-01',endAt:'2026-01-02',billingMethod:'manual_days',manualDays:4,manualReason:'Agreed contract'}).billableDays,4);
});
test('flat-rate invoice keeps utilization days and USD-only totals',()=>{
  const result=calculateInvoice({startAt:'2026-01-01T00:00:00Z',endAt:'2026-01-02T01:00:00Z',billingMethod:'flat_rate',flatRate:500,depositCredit:50,damageCharge:25,currency:'USD'});
  assert.equal(result.billableDays,2);assert.equal(result.baseAmount,500);assert.equal(result.totalAmount,475);
  assert.throws(()=>calculateInvoice({...result,startAt:'2026-01-01',endAt:'2026-01-02',billingMethod:'flat_rate',currency:'EUR'}),/Only USD/);
});
