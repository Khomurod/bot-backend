'use strict';

const db = require('../database/db');
const storage = require('./trailerStorageService');
const { createQueueWakeScheduler, resolveSweepMs } = require('./jobQueueScheduler');

/**
 * Overdue reminders are enqueued on the hour configured in trailer settings, so
 * this sweep only has to be finer than an hour to never miss one.
 */
const REMINDER_SWEEP_MS = 5 * 60 * 1000;

let telegram = null;
let scheduler = null;
let reminderTimer = null;
let running = false;
let draining = false;
let drainQueued = false;
let workerStopped = false;

function esc(value){return String(value??'—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function usd(value){return `$${Number(value||0).toFixed(2)}`;}
function mention(id,username,label='Responsible person'){
  if(id&&/^\d+$/.test(String(id)))return `<a href="tg://user?id=${esc(id)}">${esc(label)}</a>`;
  if(username)return `@${esc(String(username).replace(/^@/,''))}`;
  return esc(label);
}

function paymentMessage(row){
  return [
    '<b>Trailer Payment Received</b>',
    '',
    `Trailer: <b>${esc(row.unit_number??'Multiple trailers')}</b>`,
    `Company: ${esc(row.company_name)}`,
    `Agreement: ${esc(row.agreement_number)}`,
    `Rental period: ${esc(row.start_at)} — ${esc(row.actual_return_at||'active')}`,
    `Billable days: ${esc(row.billable_days)}`,
    `Deal: ${esc(row.billing_method)}${row.daily_rate?` at ${usd(row.daily_rate)}/day`:row.flat_rate?` at ${usd(row.flat_rate)}`:''}`,
    `Invoice total: ${usd(row.total_amount)}`,
    `Payment received: <b>${usd(row.amount)}</b>`,
    `Total paid: ${usd(row.total_paid)}`,
    `Remaining balance: ${usd(row.remaining_balance)}`,
    `Payment date: ${esc(row.payment_at)}`,
    `Method: ${esc(row.payment_method)}`,
    `Recorded by: ${esc(row.recorded_by)}`,
  ].join('\n');
}

function overdueMessage(row){
  const who=mention(row.responsible_telegram_user_id,row.responsible_telegram_username);
  const escalation=Number(row.days_overdue)>=Number(row.reminder_escalation_days)
    ?`Escalation: ${mention(row.escalation_telegram_user_id,row.escalation_telegram_username,'Escalation contact')}`:null;
  return [
    '<b>Trailer Payment Overdue</b>','',`${who}, please follow up with the renter company.`,'',
    `Trailer: <b>${esc(row.unit_number??'Multiple trailers')}</b>`,`Company: ${esc(row.company_name)}`,
    `Agreement: ${esc(row.agreement_number)}`,`Rental ended: ${esc(row.actual_return_at||'—')}`,
    `Invoice total: ${usd(row.total_amount)}`,`Paid: ${usd(row.total_paid)}`,
    `Outstanding: <b>${usd(row.outstanding)}</b>`,`Days overdue: ${esc(row.days_overdue)}`,escalation,
  ].filter(Boolean).join('\n');
}

async function sendPayment(job){
  const row=await db.getPaymentNotificationContext(job.entity_id);
  if(!row)throw new Error('Payment notification context not found.');
  const settings=await db.getTrailerSettings();
  if(!settings.payment_confirmation_group_id)throw new Error('Payment confirmation Telegram group is not configured.');
  const options={caption:paymentMessage(row),parse_mode:'HTML'};
  let sent;
  // Telegram fetches the receipt from a short-lived signed URL rather than
  // receiving an uploaded buffer — the same transport Route Control relies on,
  // where the multipart path stalled between Render and api.telegram.org.
  // Works for both backends: a database-backed receipt has no object_path.
  if(row.receipt_media_id){
    const url=await storage.buildSignedMediaUrl({
      id:row.receipt_media_id,storage_backend:row.storage_backend,bucket:row.bucket,
      object_path:row.object_path,preview_object_path:row.preview_object_path,
      blob_id:row.blob_id,preview_blob_id:row.preview_blob_id,checksum_sha256:row.checksum_sha256,
    },{preview:row.mime_type!=='application/pdf'});
    sent=row.mime_type==='application/pdf'
      ?await telegram.sendDocument(settings.payment_confirmation_group_id,url,{...options,caption:options.caption})
      :await telegram.sendPhoto(settings.payment_confirmation_group_id,url,options);
  }else sent=await telegram.sendMessage(settings.payment_confirmation_group_id,options.caption,{parse_mode:'HTML'});
  return{chatId:settings.payment_confirmation_group_id,messageId:sent.message_id};
}

async function sendOverdue(job){
  const row=await db.getOverdueNotificationContext(job.entity_id);
  if(!row)throw new Error('Overdue invoice context not found.');
  const sent=await telegram.sendMessage(row.overdue_reminder_group_id,overdueMessage(row),{parse_mode:'HTML'});
  return{chatId:row.overdue_reminder_group_id,messageId:sent.message_id};
}

/** Claim and deliver at most one job. Resolves true when one was claimed. */
async function processOne(){
  if(running||!telegram)return false;
  running=true;
  let job;
  try{
    job=await db.claimTrailerNotificationJob();
    if(!job)return false;
    let result;
    if(job.job_type==='payment_confirmation')result=await sendPayment(job);
    else if(job.job_type==='overdue_reminder')result=await sendOverdue(job);
    else throw new Error(`Unsupported notification job: ${job.job_type}`);
    await db.markTrailerNotificationSent(job.id,result);
  }catch(error){
    if(job)await db.markTrailerNotificationFailed(job.id,error);
    console.error('[TRAILER-NOTIFY] worker error:',error.message);
  }finally{running=false;}
  return Boolean(job);
}

/**
 * Drain every claimable job, then sleep until the next one is genuinely due.
 *
 * Replaces a blanket 15-second poll. A burst of receipts now goes out back to
 * back instead of one per tick, and an empty queue costs nothing at all.
 */
async function drainQueue(){
  if(!telegram)return;
  if(draining){drainQueued=true;return;}
  draining=true;
  let drainedCleanly=false;
  try{
    while(await processOne());
    drainedCleanly=true;
  }finally{
    draining=false;
    if(drainQueued){drainQueued=false;setImmediate(pokeTrailerNotificationQueue);}
    else if(drainedCleanly&&scheduler)void scheduler.afterDrain();
  }
}

/**
 * Deliver now. Called by the producer the moment a job is written (a recorded
 * payment, a freshly enqueued overdue reminder), so nothing waits for a timer.
 */
function pokeTrailerNotificationQueue(){
  if(workerStopped||!telegram)return;
  drainQueue().catch((error)=>console.error('[TRAILER-NOTIFY] drain error:',error.message));
}

async function enqueueReminders(){
  try{
    const enqueued=await db.enqueueOverdueReminders();
    // Deliver what was just enqueued now rather than on a later tick.
    if(enqueued)pokeTrailerNotificationQueue();
  }catch(error){console.error('[TRAILER-REMINDER] enqueue error:',error.message);}
}

function startTrailerNotificationService(botTelegram){
  if(scheduler)return;
  telegram=botTelegram;
  workerStopped=false;
  const sweepMs=resolveSweepMs(process.env.TRAILER_NOTIFY_SWEEP_MS);
  scheduler=createQueueWakeScheduler({
    onWake:pokeTrailerNotificationQueue,
    getNextDueAt:db.getNextTrailerNotificationDueAt,
    sweepMs,
  });
  scheduler.start();
  reminderTimer=setInterval(enqueueReminders,REMINDER_SWEEP_MS);reminderTimer.unref?.();
  // Recover anything left pending by a restart immediately, not on a sweep.
  setTimeout(pokeTrailerNotificationQueue,5_000).unref?.();
  setTimeout(enqueueReminders,10_000).unref?.();
  console.log(
    `[TRAILER-NOTIFY] Durable payment/reminder worker started — delivery on enqueue, `
    +`retries on their own available_at, idle sweep every ${Math.round(sweepMs/1000)}s.`
  );
}

function stopTrailerNotificationService(){
  workerStopped=true;
  if(scheduler)scheduler.stop();
  if(reminderTimer)clearInterval(reminderTimer);
  scheduler=null;reminderTimer=null;telegram=null;
}

module.exports={startTrailerNotificationService,stopTrailerNotificationService,processOne,drainQueue,
  pokeTrailerNotificationQueue,enqueueReminders,paymentMessage,overdueMessage};
