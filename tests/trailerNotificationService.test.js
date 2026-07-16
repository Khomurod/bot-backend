'use strict';
process.env.BOT_TOKEN||='test-bot-token';process.env.TELEGRAM_BOT_TOKEN||='test-leads-token';process.env.DATABASE_URL||='postgresql://user:pass@localhost/test';process.env.JWT_SECRET||='test-secret';process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY||='test-key';
const test=require('node:test');const assert=require('node:assert/strict');
const{paymentMessage,overdueMessage}=require('../services/trailerNotificationService');
test('payment message contains agreement, charge, receipt, and balance context',()=>{
  const text=paymentMessage({unit_number:'T-1',company_name:'Acme',agreement_number:'RENT-2026-000001',start_at:'start',actual_return_at:'end',billable_days:2,billing_method:'calendar_day',daily_rate:100,total_amount:200,amount:50,total_paid:50,remaining_balance:150,payment_at:'today',payment_method:'wire',recorded_by:'admin'});
  assert.match(text,/T-1/);assert.match(text,/RENT-2026-000001/);assert.match(text,/\$150\.00/);
});
test('overdue message escalates only after configured threshold',()=>{
  const base={unit_number:'T-2',company_name:'Acme',agreement_number:'R',total_amount:100,total_paid:0,outstanding:100,days_overdue:8,reminder_escalation_days:7,escalation_telegram_username:'boss'};
  assert.match(overdueMessage(base),/@boss/);assert.doesNotMatch(overdueMessage({...base,days_overdue:2}),/@boss/);
});
