'use strict';

const { pool, query } = require('./pool');
const { nextNumber } = require('./trailerRentals');
const { createTrailerMedia, attachMediaToPayment } = require('./trailerMedia');
const { insertTrailerAudit } = require('./trailerAudit');
const { createCompanyCredit } = require('./trailerCredits');

function error(message,status=400){return Object.assign(new Error(message),{status});}
function actorMeta(actor){return{adminId:actor?.id,roleKeys:actor?.role_keys||[],ipAddress:actor?.ipAddress};}

async function refreshInvoiceStatus(client, invoiceId) {
  const res = await client.query(
    `WITH paid AS (
       SELECT COALESCE(SUM(amount),0) total FROM trailer_payments
        WHERE invoice_id=$1 AND verification_status IN ('recorded','verified')
     )
     UPDATE trailer_invoices i SET status = CASE
       WHEN i.status IN ('disputed','voided') THEN i.status
       WHEN paid.total >= i.total_amount THEN 'paid'
       WHEN paid.total > 0 THEN 'partially_paid'
       WHEN i.due_at < NOW() THEN 'overdue'
       ELSE 'issued' END, updated_at=NOW()
     FROM paid WHERE i.id=$1 RETURNING i.*,paid.total AS total_paid,
       GREATEST(i.total_amount-paid.total,0) AS outstanding_balance`, [invoiceId],
  );
  return res.rows[0] || null;
}

async function listTrailerInvoices(filters={}) {
  const values=[]; const where=[];
  for(const [col,val] of [['i.status',filters.status],['i.company_id',filters.companyId],['i.trailer_id',filters.trailerId]]){
    if(val!=null&&val!==''){values.push(val);where.push(`${col}=$${values.length}`);}
  }
  const res=await query(
    `SELECT i.*,r.agreement_number,t.unit_number,c.display_name AS company_name,
       COALESCE(p.total_paid,0) AS total_paid,GREATEST(i.total_amount-COALESCE(p.total_paid,0),0) AS outstanding_balance,
       CASE WHEN i.status NOT IN ('disputed','voided','paid') AND i.due_at<NOW()
         THEN TRUE ELSE FALSE END AS is_overdue,n.status AS notification_status,
       n.attempts AS notification_attempts,n.last_error AS notification_error
     FROM trailer_invoices i JOIN trailer_rentals r ON r.id=i.rental_id
     JOIN trailers t ON t.id=i.trailer_id JOIN trailer_renter_companies c ON c.id=i.company_id
     LEFT JOIN LATERAL (SELECT SUM(amount) total_paid FROM trailer_payments
       WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')) p ON TRUE
     LEFT JOIN LATERAL (SELECT j.status,j.attempts,j.last_error FROM trailer_notification_jobs j
       JOIN trailer_payments pp ON pp.id=j.entity_id WHERE j.job_type='payment_confirmation'
       AND pp.invoice_id=i.id ORDER BY j.created_at DESC LIMIT 1) n ON TRUE
     ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY i.created_at DESC LIMIT 500`,values);
  return res.rows;
}

async function getTrailerInvoice(id){
  const rows=await listTrailerInvoices(); const invoice=rows.find((r)=>Number(r.id)===Number(id));
  if(!invoice)return null;
  const payments=await query('SELECT * FROM trailer_payments WHERE invoice_id=$1 ORDER BY payment_at DESC',[id]);
  const adjustments=await query('SELECT * FROM trailer_invoice_adjustments WHERE invoice_id=$1 ORDER BY created_at',[id]);
  return{...invoice,payments:payments.rows,adjustments:adjustments.rows};
}

async function recordTrailerPayment(data, actor, receiptDescriptor) {
  if(!data.invoice_id||!Number(data.amount)||Number(data.amount)<=0||!data.payment_at||!String(data.payment_method||'').trim()){
    throw error('Invoice, positive amount, payment date, and payment method are required.');
  }
  if(!String(data.idempotency_key||'').trim())throw error('Idempotency key is required.');
  if(!receiptDescriptor&&!String(data.receipt_bypass_reason||'').trim())throw error('Receipt is required unless an authorized bypass reason is provided.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const invoiceRes=await client.query(
      `SELECT i.*,r.agreement_number,t.unit_number,c.display_name AS company_name
       FROM trailer_invoices i JOIN trailer_rentals r ON r.id=i.rental_id
       JOIN trailers t ON t.id=i.trailer_id JOIN trailer_renter_companies c ON c.id=i.company_id
       WHERE i.id=$1 FOR UPDATE OF i`,[data.invoice_id]);
    const invoice=invoiceRes.rows[0];
    if(!invoice)throw error('Invoice not found.',404);
    if(['voided','disputed'].includes(invoice.status))throw error('Payments cannot be recorded for a voided or disputed invoice.',409);
    const existing=await client.query('SELECT * FROM trailer_payments WHERE invoice_id=$1 AND idempotency_key=$2',[data.invoice_id,data.idempotency_key]);
    if(existing.rows[0]){await client.query('COMMIT');return{payment:existing.rows[0],invoice:await refreshInvoiceStatus(client,data.invoice_id),duplicate:true};}
    // Overpayment control: a payment above the outstanding balance is rejected
    // by default. With the record_overpayment permission AND explicit
    // confirmation (both surfaced by the route as allow_overpayment), the excess
    // is banked as a company credit in this same transaction.
    const paidRes=await client.query(
      `SELECT COALESCE(SUM(amount),0) total FROM trailer_payments
        WHERE invoice_id=$1 AND verification_status IN ('recorded','verified')`,[invoice.id]);
    const outstanding=Number(invoice.total_amount)-Number(paidRes.rows[0].total);
    const overpayment=Number(data.amount)-outstanding;
    if(overpayment>0.0001 && !data.allow_overpayment){
      throw error('Payment exceeds the outstanding balance. Authorize an overpayment to bank the excess as company credit.',409);
    }
    let media=null;
    if(receiptDescriptor){
      media=await createTrailerMedia({...receiptDescriptor,mediaType:'payment_receipt',trailerId:invoice.trailer_id,
        rentalId:invoice.rental_id,invoiceId:invoice.id,uploadedByAdminId:actor?.id},client);
    }
    const receiptNumber=await nextNumber(client,'trailer_payments','receipt_number','RCPT');
    const payment=await client.query(
      `INSERT INTO trailer_payments
       (receipt_number,invoice_id,rental_id,trailer_id,company_id,amount,currency,payment_at,payment_method,
        reference_number,notes,receipt_media_id,receipt_bypass_reason,idempotency_key,recorded_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [receiptNumber,invoice.id,invoice.rental_id,invoice.trailer_id,invoice.company_id,Number(data.amount),
       data.payment_at,String(data.payment_method).trim(),data.reference_number||null,data.notes||null,
       media?.id||null,data.receipt_bypass_reason||null,String(data.idempotency_key),actor?.id||null]);
    if(media)await attachMediaToPayment(media.id,payment.rows[0].id,client);
    const job=await client.query(
      `INSERT INTO trailer_notification_jobs(job_type,entity_type,entity_id,idempotency_key,payload)
       VALUES ('payment_confirmation','payment',$1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
      [payment.rows[0].id,`payment:${payment.rows[0].id}`,JSON.stringify({receipt_media_id:media?.id||null})]);
    const refreshed=await refreshInvoiceStatus(client,invoice.id);
    if(refreshed?.status==='paid')await client.query(
      `INSERT INTO trailer_reminder_history(invoice_id,action,note,action_by_admin_id,metadata)
       VALUES($1,'payment_resolution','Invoice paid in full',$2,$3)`,
      [invoice.id,actor?.id||null,JSON.stringify({payment_id:payment.rows[0].id})]);
    let credit=null;
    if(overpayment>0.0001&&data.allow_overpayment){
      credit=await createCompanyCredit({company_id:invoice.company_id,source_payment_id:payment.rows[0].id,
        source_invoice_id:invoice.id,amount:Number(overpayment.toFixed(2)),
        reason:data.overpayment_reason||'Overpayment on invoice '+invoice.invoice_number,
        created_by_admin_id:actor?.id||null},client);
      await insertTrailerAudit({...actorMeta(actor),action:'payment.overpayment_credit',entityType:'company_credit',
        entityId:credit.id,newValues:{amount:credit.original_amount,payment_id:payment.rows[0].id}},client);
    }
    await insertTrailerAudit({...actorMeta(actor),action:'payment.create',entityType:'payment',entityId:payment.rows[0].id,
      newValues:payment.rows[0],reason:data.receipt_bypass_reason},client);
    await client.query('COMMIT');
    return{payment:payment.rows[0],invoice:refreshed,media,notification:job.rows[0]||null,credit,duplicate:false};
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function reverseTrailerPayment(paymentId, reason, actor){
  if(!String(reason||'').trim())throw error('A reversal reason is required.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const before=await client.query('SELECT * FROM trailer_payments WHERE id=$1 FOR UPDATE',[paymentId]);
    if(!before.rows[0])throw error('Payment not found.',404);
    if(before.rows[0].verification_status==='reversed')throw error('Payment is already reversed.',409);
    const reversal=await client.query(
      `INSERT INTO trailer_payment_reversals(payment_id,reason,reversed_by_admin_id)
       VALUES($1,$2,$3) RETURNING *`,[paymentId,String(reason).trim(),actor?.id||null]);
    await client.query(`UPDATE trailer_payments SET verification_status='reversed',updated_at=NOW() WHERE id=$1`,[paymentId]);
    const invoice=await refreshInvoiceStatus(client,before.rows[0].invoice_id);
    await insertTrailerAudit({...actorMeta(actor),action:'payment.reverse',entityType:'payment',entityId:paymentId,
      oldValues:before.rows[0],newValues:reversal.rows[0],reason},client);
    await client.query('COMMIT');
    return{reversal:reversal.rows[0],invoice};
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function addTrailerInvoiceAdjustment(invoiceId,{adjustment_type:adjustmentType,amount,reason},actor){
  const value=Number(amount);if(!adjustmentType||!Number.isFinite(value)||value===0||!String(reason||'').trim())throw error('Adjustment type, non-zero amount, and reason are required.');
  const client=await pool.connect();try{await client.query('BEGIN');
    const before=await client.query('SELECT * FROM trailer_invoices WHERE id=$1 FOR UPDATE',[invoiceId]);
    if(!before.rows[0])throw error('Invoice not found.',404);if(['paid','voided'].includes(before.rows[0].status))throw error('Paid or voided invoices cannot be adjusted.',409);
    const adjustment=await client.query(`INSERT INTO trailer_invoice_adjustments(invoice_id,adjustment_type,amount,reason,created_by_admin_id)VALUES($1,$2,$3,$4,$5)RETURNING *`,[invoiceId,String(adjustmentType),value,String(reason).trim(),actor?.id||null]);
    await client.query('UPDATE trailer_invoices SET other_charges=other_charges+$2,total_amount=GREATEST(total_amount+$2,0),updated_at=NOW() WHERE id=$1',[invoiceId,value]);
    const invoice=await refreshInvoiceStatus(client,invoiceId);await insertTrailerAudit({...actorMeta(actor),action:'invoice.adjust',entityType:'invoice',entityId:invoiceId,oldValues:before.rows[0],newValues:{invoice,adjustment:adjustment.rows[0]},reason},client);
    await client.query('COMMIT');return{adjustment:adjustment.rows[0],invoice};
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function updateInvoiceReminderState(invoiceId,{action,note,snoozedUntil},actor){
  const stateByAction={pause:'paused',resume:'active',snooze:'snoozed',waive:'waived',dispute:null};
  if(!(action in stateByAction)&&action!=='contacted'&&action!=='escalate')throw error('Invalid reminder action.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const invoice=await client.query('SELECT * FROM trailer_invoices WHERE id=$1 FOR UPDATE',[invoiceId]);
    if(!invoice.rows[0])throw error('Invoice not found.',404);
    if(action==='dispute')await client.query(`UPDATE trailer_invoices SET status='disputed',updated_at=NOW() WHERE id=$1`,[invoiceId]);
    else if(stateByAction[action])await client.query('UPDATE trailer_invoices SET reminder_state=$2,snoozed_until=$3,updated_at=NOW() WHERE id=$1',[invoiceId,stateByAction[action],action==='snooze'?snoozedUntil:null]);
    await client.query(`INSERT INTO trailer_reminder_history(invoice_id,action,note,action_by_admin_id,metadata)
      VALUES($1,$2,$3,$4,$5)`,[invoiceId,action,note||null,actor?.id||null,JSON.stringify({snoozed_until:snoozedUntil||null})]);
    await insertTrailerAudit({...actorMeta(actor),action:`invoice.reminder.${action}`,entityType:'invoice',entityId:invoiceId,
      oldValues:invoice.rows[0],newValues:{action,snoozedUntil},reason:note},client);
    await client.query('COMMIT');return true;
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

module.exports={refreshInvoiceStatus,listTrailerInvoices,getTrailerInvoice,recordTrailerPayment,reverseTrailerPayment,addTrailerInvoiceAdjustment,updateInvoiceReminderState};
