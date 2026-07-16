'use strict';

const express=require('express');
const multer=require('multer');
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const storage=require('../../services/trailerStorageService');
const {processTrailerUpload,safeFilename}=require('../../services/trailerImageService');

const upload=multer({
  storage:multer.diskStorage({destination:os.tmpdir(),filename:(_req,file,cb)=>cb(null,`trailer-${crypto.randomUUID()}-${safeFilename(file.originalname)}`)}),
  limits:{fileSize:15*1024*1024,files:10},
});

function asyncRoute(fn){return(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function actor(req){return{...req.admin,ipAddress:req.ip};}
function can(req,p){return new Set(req.admin?.permissions||[]).has(p);}
function csvCell(value){const s=typeof value==='object'&&value!==null?JSON.stringify(value):String(value??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function sendCsv(res,name,rows){const keys=rows.length?Object.keys(rows[0]):[];const body=[keys.map(csvCell).join(','),...rows.map((r)=>keys.map((k)=>csvCell(r[k])).join(','))].join('\n');res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition',`attachment; filename="${name}.csv"`);res.send(body);}
function objectNamespace(mediaType){
  if(mediaType==='payment_receipt')return'payment-receipts';
  if(mediaType==='agreement_document')return'agreements';
  if(mediaType==='invoice_document')return'invoices';
  return'condition-photos';
}

async function storeFile(file,mediaType,entityKey){
  const processed=await processTrailerUpload(file);
  const base=`${objectNamespace(mediaType)}/${entityKey}/${crypto.randomUUID()}`;
  const extension=path.extname(processed.originalFilename).toLowerCase()|| (processed.mimeType==='application/pdf'?'.pdf':'.bin');
  const originalPath=`${base}/original${extension}`;const previewPath=processed.preview?`${base}/preview.webp`:null;
  const uploaded=[];
  try{
    const original=await storage.uploadObject({path:originalPath,bytes:processed.original,contentType:processed.mimeType});uploaded.push(original.objectPath);
    if(processed.preview){await storage.uploadObject({path:previewPath,bytes:processed.preview,contentType:'image/webp'});uploaded.push(previewPath);}
    return{bucket:original.bucket,objectPath:original.objectPath,previewObjectPath:previewPath,
      originalFilename:processed.originalFilename,mimeType:processed.mimeType,originalSize:processed.originalSize,
      previewSize:processed.previewSize,checksum:processed.checksum,uploadedPaths:uploaded};
  }catch(e){await storage.removeObjects(uploaded);throw e;}
}

async function cleanupFiles(files){for(const file of files||[]){try{await fs.unlink(file.path);}catch(_){}}}

function createTrailerDepartmentRoutes({db,config,authMiddleware,requirePermission,telegram}){
  const router=express.Router();
  router.use('/api/trailer-department',authMiddleware,(req,res,next)=>{
    if(!config.trailerDepartmentEnabled)return res.status(404).json({error:'Trailer Department is disabled.'});
    next();
  });

  router.get('/api/trailer-department/dashboard',requirePermission('trailers.view'),asyncRoute(async(req,res)=>res.json({dashboard:await db.getTrailerDashboard(req.query)})));
  router.get('/api/trailer-department/trailers',requirePermission('trailers.view'),asyncRoute(async(req,res)=>res.json({trailers:await db.listDepartmentTrailers(req.query)})));
  router.post('/api/trailer-department/trailers',requirePermission('trailers.create'),asyncRoute(async(req,res)=>res.status(201).json({trailer:await db.createDepartmentTrailer(req.body||{},actor(req))})));
  router.get('/api/trailer-department/trailers/:id',requirePermission('trailers.view'),asyncRoute(async(req,res)=>{
    const trailer=await db.getDepartmentTrailer(req.params.id);if(!trailer)return res.status(404).json({error:'Trailer not found.'});res.json({trailer});
  }));
  router.put('/api/trailer-department/trailers/:id',requirePermission('trailers.edit'),asyncRoute(async(req,res)=>{
    if(req.body?.active===false&&!can(req,'trailers.delete_or_archive'))return res.status(403).json({error:'Trailer archive permission required.'});
    const trailer=await db.updateDepartmentTrailer(req.params.id,req.body||{},actor(req));if(!trailer)return res.status(404).json({error:'Trailer not found.'});res.json({trailer});
  }));

  router.get('/api/trailer-department/companies',requirePermission('trailer_rentals.view','trailer_companies.manage'),asyncRoute(async(req,res)=>res.json({companies:await db.listTrailerCompanies({q:req.query.q,active:req.query.active==null?undefined:req.query.active==='true'})})));
  router.post('/api/trailer-department/companies',requirePermission('trailer_companies.manage'),asyncRoute(async(req,res)=>res.status(201).json({company:await db.createTrailerCompany(req.body||{},actor(req))})));
  router.get('/api/trailer-department/companies/:id',requirePermission('trailer_rentals.view','trailer_companies.manage'),asyncRoute(async(req,res)=>{
    const company=await db.getTrailerCompany(req.params.id);if(!company)return res.status(404).json({error:'Company not found.'});res.json({company});
  }));
  router.put('/api/trailer-department/companies/:id',requirePermission('trailer_companies.manage'),asyncRoute(async(req,res)=>{
    const company=await db.updateTrailerCompany(req.params.id,req.body||{},actor(req));if(!company)return res.status(404).json({error:'Company not found.'});res.json({company});
  }));

  router.get('/api/trailer-department/rentals',requirePermission('trailer_rentals.view'),asyncRoute(async(req,res)=>res.json({rentals:await db.listTrailerRentals(req.query)})));
  router.post('/api/trailer-department/rentals',requirePermission('trailer_rentals.create'),asyncRoute(async(req,res)=>res.status(201).json({rental:await db.createTrailerRental(req.body||{},actor(req))})));
  router.get('/api/trailer-department/rentals/:id',requirePermission('trailer_rentals.view'),asyncRoute(async(req,res)=>{
    const rental=await db.getTrailerRental(req.params.id);if(!rental)return res.status(404).json({error:'Rental not found.'});res.json({rental});
  }));
  router.put('/api/trailer-department/rentals/:id',requirePermission('trailer_rentals.edit'),asyncRoute(async(req,res)=>{
    if(req.body?.billing_method==='manual_days'&&!can(req,'trailer_rentals.close'))return res.status(403).json({error:'Manual day overrides require rental close permission.'});
    const rental=await db.updateTrailerRental(req.params.id,req.body||{},actor(req));if(!rental)return res.status(404).json({error:'Rental not found.'});res.json({rental});
  }));
  router.put('/api/trailer-department/rentals/:id/inspections/:type',requirePermission('trailer_inspections.manage'),asyncRoute(async(req,res)=>{
    const inspection=await db.saveInspection({...req.body,rental_id:req.params.id,inspection_type:req.params.type},actor(req));res.json({inspection});
  }));
  router.post('/api/trailer-department/rentals/:id/activate',requirePermission('trailer_rentals.create'),asyncRoute(async(req,res)=>res.json(await db.activateTrailerRental(req.params.id,actor(req)))));
  router.post('/api/trailer-department/rentals/:id/return',requirePermission('trailer_rentals.close'),asyncRoute(async(req,res)=>res.json(await db.returnTrailerRental(req.params.id,req.body||{},actor(req)))));
  router.get('/api/trailer-department/rentals/:id/estimate',requirePermission('trailer_rentals.view'),asyncRoute(async(req,res)=>res.json({estimate:await db.estimateTrailerRental(req.params.id,req.query.end_at,req.query.timezone)})));
  router.post('/api/trailer-department/rentals/:id/status',requirePermission('trailer_rentals.edit'),asyncRoute(async(req,res)=>res.json({rental:await db.changeTrailerRentalStatus(req.params.id,req.body?.status,req.body?.reason,actor(req))})));
  router.post('/api/trailer-department/rentals/:id/link-event/:eventId',requirePermission('trailer_rentals.edit'),asyncRoute(async(req,res)=>{
    const event=await db.linkTrailerEventToRental(req.params.eventId,req.params.id,actor(req));if(!event)return res.status(404).json({error:'Event or rental movement not found.'});res.json({event});
  }));

  router.post('/api/trailer-department/media',requirePermission('trailer_inspections.manage','trailer_payments.record'),(req,res,next)=>{
    upload.array('files',10)(req,res,async(uploadError)=>{
      if(uploadError)return next(Object.assign(uploadError,{status:400}));
      const created=[];
      try{
        if(!req.files?.length)return res.status(400).json({error:'At least one file is required.'});
        const mediaType=req.body.media_type;
        const allowed=['pickup_condition_photo','return_condition_photo','damage_photo','agreement_document','invoice_document','other_rental_document'];
        if(!allowed.includes(mediaType))return res.status(400).json({error:'Invalid media type.'});
        for(const file of req.files){
          const descriptor=await storeFile(file,mediaType,req.body.rental_id||req.body.trailer_id||'unassigned');
          try{created.push(await db.createTrailerMedia({...descriptor,mediaType,trailerId:req.body.trailer_id,rentalId:req.body.rental_id,
            inspectionId:req.body.inspection_id,invoiceId:req.body.invoice_id,uploadedByAdminId:req.admin.id,notes:req.body.notes}));}
          catch(e){await storage.removeObjects(descriptor.uploadedPaths);throw e;}
        }
        res.status(201).json({media:created});
      }catch(e){next(e);}finally{await cleanupFiles(req.files);}
    });
  });
  router.get('/api/trailer-department/media/:id/signed-url',requirePermission('trailers.view','trailer_receipts.view'),asyncRoute(async(req,res)=>{
    const media=await db.getTrailerMedia(req.params.id);if(!media)return res.status(404).json({error:'Media not found.'});
    if(media.media_type==='payment_receipt'&&!can(req,'trailer_receipts.view'))return res.status(403).json({error:'Receipt permission required.'});
    const objectPath=req.query.preview==='true'&&media.preview_object_path?media.preview_object_path:media.object_path;
    res.json({url:await storage.createSignedUrl(objectPath,300),expires_in:300});
  }));

  router.get('/api/trailer-department/invoices',requirePermission('trailer_payments.view'),asyncRoute(async(req,res)=>res.json({invoices:await db.listTrailerInvoices(req.query)})));
  router.get('/api/trailer-department/invoices/:id',requirePermission('trailer_payments.view'),asyncRoute(async(req,res)=>{
    const invoice=await db.getTrailerInvoice(req.params.id);if(!invoice)return res.status(404).json({error:'Invoice not found.'});res.json({invoice});
  }));
  router.post('/api/trailer-department/invoices/:id/adjustments',requirePermission('trailer_payments.record'),asyncRoute(async(req,res)=>res.status(201).json(await db.addTrailerInvoiceAdjustment(req.params.id,req.body||{},actor(req)))));
  router.post('/api/trailer-department/payments',requirePermission('trailer_payments.record'),(req,res,next)=>{
    upload.single('receipt')(req,res,async(uploadError)=>{
      if(uploadError)return next(Object.assign(uploadError,{status:400}));
      let descriptor;
      try{
        if(!req.file&&!can(req,'trailer_payments.record_without_receipt'))return res.status(403).json({error:'Receipt bypass permission required.'});
        if(req.file)descriptor=await storeFile(req.file,'payment_receipt',req.body.invoice_id||'unassigned');
        const result=await db.recordTrailerPayment(req.body||{},actor(req),descriptor);
        if(result.duplicate&&descriptor?.uploadedPaths)await storage.removeObjects(descriptor.uploadedPaths);
        res.status(result.duplicate?200:201).json(result);
      }catch(e){if(descriptor?.uploadedPaths)await storage.removeObjects(descriptor.uploadedPaths);next(e);}finally{await cleanupFiles(req.file?[req.file]:[]);}
    });
  });
  router.post('/api/trailer-department/payments/:id/reverse',requirePermission('trailer_payments.reverse'),asyncRoute(async(req,res)=>res.json(await db.reverseTrailerPayment(req.params.id,req.body?.reason,actor(req)))));
  router.post('/api/trailer-department/notifications/:id/retry',requirePermission('trailer_payments.record','trailer_settings.manage'),asyncRoute(async(req,res)=>{
    const job=await db.retryTrailerNotification(req.params.id);if(!job)return res.status(404).json({error:'Failed notification not found.'});res.json({job});
  }));
  router.post('/api/trailer-department/invoices/:id/reminder-action',requirePermission('trailer_payments.record'),asyncRoute(async(req,res)=>{
    await db.updateInvoiceReminderState(req.params.id,req.body||{},actor(req));res.json({updated:true});
  }));

  router.get('/api/trailer-department/settings',requirePermission('trailer_settings.manage'),asyncRoute(async(req,res)=>res.json({settings:await db.getTrailerSettings(),storage_configured:storage.isConfigured()})));
  router.put('/api/trailer-department/settings',requirePermission('trailer_settings.manage'),asyncRoute(async(req,res)=>{
    if(req.body?.reminders_enabled){const current=await db.getTrailerSettings();if(!current.payment_group_tested_at||!current.overdue_group_tested_at)return res.status(409).json({error:'Test both Telegram groups successfully before enabling reminders.'});}
    res.json({settings:await db.updateTrailerSettings(req.body||{})});
  }));
  router.post('/api/trailer-department/settings/test/:target',requirePermission('trailer_settings.manage'),asyncRoute(async(req,res)=>{
    const settings=await db.getTrailerSettings();const payment=req.params.target==='payment';const chatId=payment?settings.payment_confirmation_group_id:settings.overdue_reminder_group_id;
    if(!chatId)return res.status(400).json({error:'Configure the Telegram group first.'});
    const sent=await telegram.sendMessage(chatId,`Trailer Department ${payment?'payment confirmation':'overdue reminder'} test — configuration is working.`);
    await db.query(`UPDATE trailer_settings SET ${payment?'payment_group_tested_at':'overdue_group_tested_at'}=NOW(),updated_at=NOW() WHERE id=1`);
    res.json({sent:true,message_id:sent.message_id});
  }));

  router.get('/api/trailer-department/map',requirePermission('trailer_map.view'),asyncRoute(async(req,res)=>{
    const trailers=await db.listDepartmentTrailers(req.query);res.json({trailers,without_coordinates:trailers.filter((t)=>t.current_lat==null||t.current_lng==null)});
  }));
  router.get('/api/trailer-department/reports/:name',requirePermission('trailer_reports.view'),asyncRoute(async(req,res)=>{
    const rows=await db.getTrailerReport(req.params.name);if(req.query.format==='csv')return sendCsv(res,req.params.name,rows);res.json({rows});
  }));
  router.get('/api/trailer-department/audit',requirePermission('trailer_reports.view'),asyncRoute(async(req,res)=>res.json({audit:await db.listTrailerAudit(req.query)})));

  router.use((error,_req,res,_next)=>{
    console.error('[TRAILER-DEPARTMENT]',error.message);
    const code=error.status|| (error.code==='23505'||error.code==='23P01'?409:500);
    res.status(code).json({error:code===500?'Trailer Department request failed.':error.message});
  });
  return router;
}

module.exports={createTrailerDepartmentRoutes,storeFile,sendCsv};
