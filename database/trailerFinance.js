'use strict';

const { pool, query } = require('./pool');
const { nextNumber } = require('./trailerRentals');
const { createTrailerMedia, attachMediaToPayment } = require('./trailerMedia');
const { insertTrailerAudit } = require('./trailerAudit');
const { createCompanyCredit } = require('./trailerCredits');
const { refreshInvoiceStatus, PAID_TOTAL_LATERAL } = require('./trailerInvoiceStatus');

function error(message,status=400){return Object.assign(new Error(message),{status});}
function actorMeta(actor){return{adminId:actor?.id,roleKeys:actor?.role_keys||[],ipAddress:actor?.ipAddress};}

// Invoice header joins. Legacy rental and trailer are OPTIONAL — an
// agreement-only invoice (combined, or a fresh agreement with no legacy rental)
// has neither, so requiring them made those invoices invisible and unpayable.
const INVOICE_SELECT = `
  SELECT i.*,COALESCE(r.agreement_number,a.agreement_number) AS agreement_number,
    t.unit_number,c.display_name AS company_name,
    COALESCE(p.total_paid,0) AS total_paid,GREATEST(i.total_amount-COALESCE(p.total_paid,0),0) AS outstanding_balance,
    CASE WHEN i.status NOT IN ('disputed','voided','paid') AND i.due_at<NOW()
      THEN TRUE ELSE FALSE END AS is_overdue,n.id AS notification_job_id,n.status AS notification_status,
    n.attempts AS notification_attempts,n.last_error AS notification_error
  FROM trailer_invoices i
  LEFT JOIN trailer_rentals r ON r.id=i.rental_id
  LEFT JOIN trailer_rental_agreements a ON a.id=i.agreement_id
  LEFT JOIN trailers t ON t.id=i.trailer_id
  JOIN trailer_renter_companies c ON c.id=i.company_id
  ${PAID_TOTAL_LATERAL}
  LEFT JOIN LATERAL (SELECT j.id,j.status,j.attempts,j.last_error FROM trailer_notification_jobs j
    JOIN trailer_payments pp ON pp.id=j.entity_id WHERE j.job_type='payment_confirmation'
    AND pp.invoice_id=i.id ORDER BY j.created_at DESC LIMIT 1) n ON TRUE`;

async function listTrailerInvoices(filters={}) {
  const values=[]; const where=[];
  for(const [col,val] of [['i.status',filters.status],['i.company_id',filters.companyId],
    ['i.trailer_id',filters.trailerId],['i.agreement_id',filters.agreementId],['i.rental_item_id',filters.rentalItemId]]){
    if(val!=null&&val!==''){values.push(val);where.push(`${col}=$${values.length}`);}
  }
  if(filters.q){
    values.push(`%${String(filters.q).trim()}%`);
    where.push(`(i.invoice_number ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`);
  }
  if(filters.company){values.push(`%${String(filters.company).trim()}%`);where.push(`c.display_name ILIKE $${values.length}`);}
  if(filters.due_from){values.push(filters.due_from);where.push(`i.due_at >= $${values.length}`);}
  if(filters.due_to){values.push(filters.due_to);where.push(`i.due_at <= $${values.length}`);}
  // Outstanding-only: self-contained subqueries (payments + credits) so the
  // condition resolves in BOTH the list and the COUNT query, which join fewer tables.
  if(filters.outstanding_only===true||filters.outstanding_only==='true'){
    where.push(`i.total_amount
      - COALESCE((SELECT SUM(amount) FROM trailer_payments WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')),0)
      - COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications WHERE invoice_id=i.id),0) > 0`);
  }
  const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
  // With a page requested, answer the shared paginated envelope; without one,
  // keep the legacy bare-array behaviour for existing consumers.
  if(filters.page){
    const page=Math.max(Number(filters.page)||1,1);
    const size=Math.min(Math.max(Number(filters.page_size??filters.pageSize)||25,1),200);
    const total=await query(
      `SELECT COUNT(*)::int AS total FROM trailer_invoices i JOIN trailer_renter_companies c ON c.id=i.company_id ${clause}`,values);
    const res=await query(
      `${INVOICE_SELECT} ${clause} ORDER BY i.created_at DESC LIMIT ${size} OFFSET ${(page-1)*size}`,values);
    return {items:res.rows,page,page_size:size,total:total.rows[0].total};
  }
  const res=await query(
    `${INVOICE_SELECT}
     ${clause} ORDER BY i.created_at DESC LIMIT 500`,values);
  return res.rows;
}

async function getTrailerInvoice(id){
  const res=await query(`${INVOICE_SELECT} WHERE i.id=$1`,[Number(id)]);
  const invoice=res.rows[0];
  if(!invoice)return null;
  const [payments,adjustments,lines]=await Promise.all([
    query(`SELECT p.*,a.username AS recorded_by,rv.reason AS reversal_reason,rv.reversed_at
       FROM trailer_payments p
       LEFT JOIN admins a ON a.id=p.recorded_by_admin_id
       LEFT JOIN trailer_payment_reversals rv ON rv.payment_id=p.id
      WHERE p.invoice_id=$1 ORDER BY p.payment_at DESC`,[id]),
    query('SELECT * FROM trailer_invoice_adjustments WHERE invoice_id=$1 ORDER BY created_at',[id]),
    query('SELECT * FROM trailer_invoice_lines WHERE invoice_id=$1 ORDER BY id',[id]),
  ]);
  return{...invoice,payments:payments.rows,adjustments:adjustments.rows,lines:lines.rows};
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
      `SELECT i.*,COALESCE(r.agreement_number,a.agreement_number) AS agreement_number,
         t.unit_number,c.display_name AS company_name
       FROM trailer_invoices i
       LEFT JOIN trailer_rentals r ON r.id=i.rental_id
       LEFT JOIN trailer_rental_agreements a ON a.id=i.agreement_id
       LEFT JOIN trailers t ON t.id=i.trailer_id
       JOIN trailer_renter_companies c ON c.id=i.company_id
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
      `SELECT COALESCE((SELECT SUM(amount) FROM trailer_payments
                WHERE invoice_id=$1 AND verification_status IN ('recorded','verified')),0)
            + COALESCE((SELECT SUM(amount) FROM trailer_company_credit_applications
                WHERE invoice_id=$1),0) AS total`,[invoice.id]);
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
       (receipt_number,invoice_id,rental_id,trailer_id,agreement_id,company_id,amount,currency,payment_at,payment_method,
        reference_number,notes,receipt_media_id,receipt_bypass_reason,idempotency_key,recorded_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [receiptNumber,invoice.id,invoice.rental_id||null,invoice.trailer_id||null,invoice.agreement_id||null,
       invoice.company_id,Number(data.amount),
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

async function addTrailerInvoiceAdjustment(invoiceId,{adjustment_type:adjustmentType,amount,reason,version},actor){
  const value=Number(amount);if(!adjustmentType||!Number.isFinite(value)||value===0||!String(reason||'').trim())throw error('Adjustment type, non-zero amount, and reason are required.');
  const client=await pool.connect();try{await client.query('BEGIN');
    const before=await client.query('SELECT * FROM trailer_invoices WHERE id=$1 FOR UPDATE',[invoiceId]);
    if(!before.rows[0])throw error('Invoice not found.',404);if(['paid','voided'].includes(before.rows[0].status))throw error('Paid or voided invoices cannot be adjusted.',409);
    if(version!==undefined&&version!==null&&Number(before.rows[0].version)!==Number(version)){
      throw Object.assign(new Error('This record changed while you were editing. Reload and try again.'),
        {status:409,code:'VERSION_CONFLICT',currentVersion:before.rows[0].version});
    }
    const adjustment=await client.query(`INSERT INTO trailer_invoice_adjustments(invoice_id,adjustment_type,amount,reason,created_by_admin_id)VALUES($1,$2,$3,$4,$5)RETURNING *`,[invoiceId,String(adjustmentType),value,String(reason).trim(),actor?.id||null]);
    await client.query('UPDATE trailer_invoices SET other_charges=other_charges+$2,total_amount=GREATEST(total_amount+$2,0),updated_at=NOW(),version=version+1 WHERE id=$1',[invoiceId,value]);
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
