'use strict';

const { pool, query } = require('./pool');

async function claimTrailerNotificationJob(){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const res=await client.query(
      `SELECT * FROM trailer_notification_jobs
       WHERE (status IN ('pending','failed') OR (status='processing' AND locked_at<NOW()-INTERVAL '5 minutes'))
         AND available_at<=NOW() AND attempts<8
       ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
    if(!res.rows[0]){await client.query('COMMIT');client.release();return null;}
    const updated=await client.query(
      `UPDATE trailer_notification_jobs SET status='processing',attempts=attempts+1,locked_at=NOW(),updated_at=NOW()
       WHERE id=$1 RETURNING *`,[res.rows[0].id]);
    await client.query('COMMIT');client.release();return updated.rows[0];
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}client.release();throw e;}
}

async function markTrailerNotificationSent(id,{chatId,messageId}){
  const res=await query(`WITH updated AS (UPDATE trailer_notification_jobs SET status='sent',telegram_chat_id=$2,
    telegram_message_id=$3,sent_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *)
    INSERT INTO trailer_reminder_history(invoice_id,notification_job_id,action,metadata)
    SELECT entity_id,id,'sent',jsonb_build_object('chat_id',telegram_chat_id,'message_id',telegram_message_id)
    FROM updated WHERE job_type='overdue_reminder' RETURNING (SELECT row_to_json(updated) FROM updated) AS job`,[id,String(chatId),String(messageId)]);
  if(!res.rows[0])return (await query('SELECT * FROM trailer_notification_jobs WHERE id=$1',[id])).rows[0]||null;
  return res.rows[0].job;
}

async function markTrailerNotificationFailed(id,error){
  const res=await query(
    `WITH updated AS (UPDATE trailer_notification_jobs SET status='failed',last_error=$2,
      available_at=NOW()+(LEAST(3600,POWER(2,attempts)*30)*INTERVAL '1 second'),updated_at=NOW()
     WHERE id=$1 RETURNING *)
     INSERT INTO trailer_reminder_history(invoice_id,notification_job_id,action,note)
     SELECT entity_id,id,'retry',last_error FROM updated WHERE job_type='overdue_reminder'
     RETURNING (SELECT row_to_json(updated) FROM updated) AS job`,[id,String(error?.message||error||'Delivery failed').slice(0,2000)]);
  if(!res.rows[0])return (await query('SELECT * FROM trailer_notification_jobs WHERE id=$1',[id])).rows[0]||null;
  return res.rows[0].job;
}

async function getPaymentNotificationContext(paymentId){
  const res=await query(
    `SELECT p.*,i.invoice_number,i.total_amount,i.billable_days,i.daily_rate,i.flat_rate,i.billing_method,
       r.agreement_number,r.start_at,r.actual_return_at,t.unit_number,c.display_name AS company_name,
       a.username AS recorded_by,m.object_path,m.preview_object_path,m.mime_type,m.bucket,
       -- Everything services/trailerStorage needs to build a signed URL for
       -- EITHER backend. Without these a database-backed receipt has no
       -- object_path and would silently send as a plain text message.
       m.id AS receipt_media_id,m.storage_backend,m.blob_id,m.preview_blob_id,m.checksum_sha256,
       COALESCE(total.total_paid,0) AS total_paid,
       GREATEST(i.total_amount-COALESCE(total.total_paid,0),0) AS remaining_balance
     FROM trailer_payments p JOIN trailer_invoices i ON i.id=p.invoice_id
     JOIN trailer_rentals r ON r.id=p.rental_id JOIN trailers t ON t.id=p.trailer_id
     JOIN trailer_renter_companies c ON c.id=p.company_id LEFT JOIN admins a ON a.id=p.recorded_by_admin_id
     LEFT JOIN trailer_media m ON m.id=p.receipt_media_id
     LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments
       WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')) total ON TRUE
     WHERE p.id=$1`,[paymentId]);
  return res.rows[0]||null;
}

/**
 * Restore expired snoozes to the active reminder state.
 *
 * A snoozed invoice carries reminder_state='snoozed'; enqueueOverdueReminders
 * only considers reminder_state='active', so without this an expired snooze
 * would stay snoozed forever and never remind again. Each UPDATE is atomic.
 * Returns the count restored.
 */
async function resumeExpiredSnoozes(){
  const res=await query(
    `UPDATE trailer_invoices
        SET reminder_state='active', snoozed_until=NULL, updated_at=NOW()
      WHERE reminder_state='snoozed' AND snoozed_until IS NOT NULL AND snoozed_until<=NOW()
      RETURNING id`);
  return res.rowCount;
}

async function enqueueOverdueReminders(){
  // Expired snoozes rejoin the active pool before we decide who is due.
  await resumeExpiredSnoozes();
  const res=await query(
    `INSERT INTO trailer_notification_jobs(job_type,entity_type,entity_id,idempotency_key,payload)
     SELECT 'overdue_reminder','invoice',i.id,
       'overdue:'||i.id||':'||to_char(NOW() AT TIME ZONE COALESCE(s.reminder_timezone,'America/Chicago'),'YYYY-MM-DD'),
       jsonb_build_object('invoice_id',i.id)
     FROM trailer_invoices i CROSS JOIN trailer_settings s
     LEFT JOIN LATERAL(SELECT COALESCE(SUM(amount),0) total_paid FROM trailer_payments
       WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')) p ON TRUE
     WHERE s.id=1 AND s.reminders_enabled=TRUE AND s.overdue_reminder_group_id IS NOT NULL
       AND i.status NOT IN ('paid','disputed','voided') AND i.reminder_state='active'
       AND (i.snoozed_until IS NULL OR i.snoozed_until<=NOW())
       AND i.due_at+(s.payment_grace_period_days*INTERVAL '1 day')<NOW()
       AND i.total_amount>p.total_paid
       AND NOT EXISTS (SELECT 1 FROM trailer_notification_jobs prior
         WHERE prior.job_type='overdue_reminder' AND prior.entity_id=i.id
           AND prior.status IN ('pending','processing','sent','failed')
           AND prior.created_at>NOW()-(s.reminder_repeat_days*INTERVAL '1 day'))
       AND (s.reminder_weekend_behavior<>'skip' OR EXTRACT(ISODOW FROM NOW() AT TIME ZONE s.reminder_timezone)<6)
       AND EXTRACT(HOUR FROM NOW() AT TIME ZONE s.reminder_timezone)=s.reminder_hour
     ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`);
  return res.rowCount;
}

async function getOverdueNotificationContext(invoiceId){
  const res=await query(
    `SELECT i.*,r.agreement_number,r.actual_return_at,t.unit_number,c.display_name AS company_name,
       s.overdue_reminder_group_id,s.responsible_telegram_username,s.responsible_telegram_user_id,
       s.escalation_telegram_username,s.escalation_telegram_user_id,s.reminder_escalation_days,
       COALESCE(p.total_paid,0) total_paid,GREATEST(i.total_amount-COALESCE(p.total_paid,0),0) outstanding,
       FLOOR(EXTRACT(EPOCH FROM (NOW()-i.due_at))/86400)::int days_overdue
     FROM trailer_invoices i JOIN trailer_rentals r ON r.id=i.rental_id JOIN trailers t ON t.id=i.trailer_id
     JOIN trailer_renter_companies c ON c.id=i.company_id CROSS JOIN trailer_settings s
     LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments
       WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')) p ON TRUE
     WHERE i.id=$1 AND s.id=1`,[invoiceId]);
  return res.rows[0]||null;
}

async function retryTrailerNotification(id){
  const res=await query(`UPDATE trailer_notification_jobs SET status='pending',available_at=NOW(),last_error=NULL,updated_at=NOW()
    WHERE id=$1 AND status='failed' RETURNING *`,[id]);return res.rows[0]||null;
}

module.exports={claimTrailerNotificationJob,markTrailerNotificationSent,markTrailerNotificationFailed,getPaymentNotificationContext,
  enqueueOverdueReminders,resumeExpiredSnoozes,getOverdueNotificationContext,retryTrailerNotification};
