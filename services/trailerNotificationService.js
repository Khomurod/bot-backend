'use strict';

const db = require('../database/db');
const storage = require('./trailerStorageService');

let telegram = null;
let timer = null;
let reminderTimer = null;
let running = false;

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
    `Trailer: <b>${esc(row.unit_number)}</b>`,
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
    `Trailer: <b>${esc(row.unit_number)}</b>`,`Company: ${esc(row.company_name)}`,
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
  const path=row.preview_object_path||row.object_path;
  if(path){
    const url=await storage.createSignedUrl(path,300);
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

async function processOne(){
  if(running||!telegram)return;
  running=true;
  let job;
  try{
    job=await db.claimTrailerNotificationJob();
    if(!job)return;
    let result;
    if(job.job_type==='payment_confirmation')result=await sendPayment(job);
    else if(job.job_type==='overdue_reminder')result=await sendOverdue(job);
    else throw new Error(`Unsupported notification job: ${job.job_type}`);
    await db.markTrailerNotificationSent(job.id,result);
  }catch(error){
    if(job)await db.markTrailerNotificationFailed(job.id,error);
    console.error('[TRAILER-NOTIFY] worker error:',error.message);
  }finally{running=false;}
}

async function enqueueReminders(){
  try{await db.enqueueOverdueReminders();}catch(error){console.error('[TRAILER-REMINDER] enqueue error:',error.message);}
}

function startTrailerNotificationService(botTelegram){
  if(timer)return;
  telegram=botTelegram;
  timer=setInterval(processOne,15_000);timer.unref?.();
  reminderTimer=setInterval(enqueueReminders,5*60_000);reminderTimer.unref?.();
  setTimeout(processOne,5_000).unref?.();
  setTimeout(enqueueReminders,10_000).unref?.();
  console.log('[TRAILER-NOTIFY] Durable payment/reminder worker started.');
}

function stopTrailerNotificationService(){
  if(timer)clearInterval(timer);if(reminderTimer)clearInterval(reminderTimer);
  timer=null;reminderTimer=null;telegram=null;
}

module.exports={startTrailerNotificationService,stopTrailerNotificationService,processOne,enqueueReminders,paymentMessage,overdueMessage};
