'use strict';

const express=require('express');
const multer=require('multer');
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const storage=require('../../services/trailerStorageService');
const {processTrailerUpload,safeFilename}=require('../../services/trailerImageService');
const {errorPayload}=require('../../services/trailerErrorMessages');
const {toCsv}=require('./csvSafe');

const upload=multer({
  storage:multer.diskStorage({destination:os.tmpdir(),filename:(_req,file,cb)=>cb(null,`trailer-${crypto.randomUUID()}-${safeFilename(file.originalname)}`)}),
  limits:{fileSize:15*1024*1024,files:10},
});

function asyncRoute(fn){return(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function actor(req){return{...req.admin,ipAddress:req.ip};}
function can(req,p){return new Set(req.admin?.permissions||[]).has(p);}
// csvCell/toCsv are formula-injection-safe (see ./csvSafe).
function sendCsv(res,name,rows){res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition',`attachment; filename="${name}.csv"`);res.send(toCsv(rows));}
function objectNamespace(mediaType){
  if(mediaType==='payment_receipt')return'payment-receipts';
  if(mediaType==='agreement_document')return'agreements';
  if(mediaType==='invoice_document')return'invoices';
  return'condition-photos';
}

/**
 * Validate and store one upload with whichever backend is active.
 *
 * Storage no longer requires Supabase: with no bucket configured the bytes go
 * into Postgres (services/trailerStorage), so photo upload — and therefore
 * pickup activation, which requires a photo — works out of the box.
 *
 * The returned descriptor carries `uploaded` so a caller whose metadata insert
 * fails can hand it straight back to storage.removeObjects and leave nothing
 * orphaned.
 */
async function storeFile(file,mediaType,entityKey,options={}){
  const processed=await processTrailerUpload(file);
  const base=`${objectNamespace(mediaType)}/${entityKey}/${crypto.randomUUID()}`;
  const extension=path.extname(processed.originalFilename).toLowerCase()|| (processed.mimeType==='application/pdf'?'.pdf':'.bin');
  const uploaded=[];
  try{
    const original=await storage.putObject({
      bytes:processed.original,contentType:processed.mimeType,filename:processed.originalFilename,
      checksum:processed.checksum,objectPath:`${base}/original${extension}`,
    },options);
    uploaded.push(original);
    let preview=null;
    if(processed.preview){
      preview=await storage.putObject({
        bytes:processed.preview,contentType:'image/webp',filename:'preview.webp',
        checksum:processed.checksum,objectPath:`${base}/preview.webp`,
      },options);
      uploaded.push(preview);
    }
    return{
      storageBackend:original.storageBackend,
      bucket:original.bucket||null,objectPath:original.objectPath||null,
      blobId:original.blobId||null,
      previewObjectPath:preview?.objectPath||null,previewBlobId:preview?.blobId||null,
      originalFilename:processed.originalFilename,mimeType:processed.mimeType,originalSize:processed.originalSize,
      previewSize:processed.previewSize,checksum:processed.checksum,uploaded,
    };
  }catch(e){await storage.removeObjects(uploaded);throw e;}
}

async function cleanupFiles(files){for(const file of files||[]){try{await fs.unlink(file.path);}catch(_){}}}

function createTrailerDepartmentRoutes({db,config,authMiddleware,requirePermission,telegram}){
  const router=express.Router();
  // Registered BEFORE the disabled-guard below so the admin UI can tell a
  // disabled department apart from a broken request. Authenticated, and it
  // reports nothing beyond the flag itself.
  router.get('/api/trailer-department/status',authMiddleware,(_req,res)=>res.json({enabled:Boolean(config.trailerDepartmentEnabled)}));
  router.use('/api/trailer-department',authMiddleware,(req,res,next)=>{
    if(!config.trailerDepartmentEnabled)return res.status(404).json({error:'Trailer Department is disabled.'});
    next();
  });

  router.use(require('./trailerDepartmentHomeRoutes').createTrailerHomeRouter({requirePermission}));

  router.get('/api/trailer-department/dashboard',requirePermission('trailers.view'),asyncRoute(async(req,res)=>res.json({dashboard:await db.getTrailerDashboard(req.query)})));
  router.get('/api/trailer-department/trailers',requirePermission('trailers.view'),asyncRoute(async(req,res)=>{
    const data=await db.listDepartmentTrailers(req.query);
    res.json(Array.isArray(data)?{trailers:data}:{...data,trailers:data.items});
  }));
  router.post('/api/trailer-department/trailers',requirePermission('trailers.create'),asyncRoute(async(req,res)=>res.status(201).json({trailer:await db.createDepartmentTrailer(req.body||{},actor(req))})));
  router.get('/api/trailer-department/trailers/:id',requirePermission('trailers.view'),asyncRoute(async(req,res)=>{
    const trailer=await db.getDepartmentTrailer(req.params.id);if(!trailer)return res.status(404).json({error:'Trailer not found.'});res.json({trailer});
  }));
  // The trailer detail page: rentals from both systems, movements, documents
  // (metadata only), invoices, aliases and the audit trail in one response.
  router.get('/api/trailer-department/trailers/:id/overview',requirePermission('trailers.view'),asyncRoute(async(req,res)=>{
    const overview=await db.getTrailerOverview(req.params.id);
    if(!overview)return res.status(404).json({error:'Trailer not found.'});
    res.json(overview);
  }));
  router.put('/api/trailer-department/trailers/:id',requirePermission('trailers.edit'),asyncRoute(async(req,res)=>{
    if(req.body?.active===false&&!can(req,'trailers.delete_or_archive'))return res.status(403).json({error:'Trailer archive permission required.'});
    const trailer=await db.updateDepartmentTrailer(req.params.id,req.body||{},actor(req));if(!trailer)return res.status(404).json({error:'Trailer not found.'});res.json({trailer});
  }));

  router.get('/api/trailer-department/companies',requirePermission('trailer_rentals.view','trailer_companies.manage'),asyncRoute(async(req,res)=>{
    const data=await db.listTrailerCompanies({q:req.query.q,active:req.query.active==null?undefined:req.query.active==='true',
      page:req.query.page,page_size:req.query.page_size});
    // Paged → the standard envelope (+ companies alias for old readers); else legacy bare array.
    res.json(Array.isArray(data)?{companies:data}:{...data,companies:data.items});
  }));
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
  // Saving answers ALWAYS produces a draft — `completed` in the body is ignored.
  // The frontend used to be able to mark an inspection complete before its photo
  // upload had succeeded, leaving a "completed" inspection with no photo that
  // then blocked activation.
  router.put('/api/trailer-department/rentals/:id/inspections/:type',requirePermission('trailer_inspections.manage'),asyncRoute(async(req,res)=>{
    const inspection=await db.saveInspection({...req.body,rental_id:req.params.id,inspection_type:req.params.type},actor(req));res.json({inspection});
  }));
  // The only way to complete one: transactional, and only after the required
  // fields are answered and the required photo's bytes genuinely exist.
  router.post('/api/trailer-department/rentals/:id/inspections/:type/complete',requirePermission('trailer_inspections.manage'),asyncRoute(async(req,res)=>{
    res.json({inspection:await db.completeInspection(req.params.id,req.params.type,actor(req))});
  }));
  router.post('/api/trailer-department/rentals/:id/activate',requirePermission('trailer_rentals.create'),asyncRoute(async(req,res)=>res.json(await db.activateTrailerRental(req.params.id,actor(req)))));
  router.post('/api/trailer-department/rentals/:id/return',requirePermission('trailer_rentals.close'),asyncRoute(async(req,res)=>res.json(await db.returnTrailerRental(req.params.id,req.body||{},actor(req)))));
  router.get('/api/trailer-department/rentals/:id/estimate',requirePermission('trailer_rentals.view'),asyncRoute(async(req,res)=>res.json({estimate:await db.estimateTrailerRental(req.params.id,req.query.end_at,req.query.timezone)})));
  router.post('/api/trailer-department/rentals/:id/status',requirePermission('trailer_rentals.edit'),asyncRoute(async(req,res)=>res.json({rental:await db.changeTrailerRentalStatus(req.params.id,req.body?.status,req.body?.reason,actor(req))})));
  router.post('/api/trailer-department/rentals/:id/link-event/:eventId',requirePermission('trailer_rentals.edit'),asyncRoute(async(req,res)=>{
    const event=await db.linkTrailerEventToRental(req.params.eventId,req.params.id,actor(req),{movementId:req.body?.movement_id});if(!event)return res.status(404).json({error:'Event or rental movement not found.'});res.json({event});
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
        // Item-scoped uploads: verify the agreement item exists (and matches the
        // agreement when both are given) so photos can never attach to nothing.
        let agreementId=req.body.agreement_id||null;
        const rentalItemId=req.body.rental_item_id||null;
        if(rentalItemId){
          const item=await db.getItemById(rentalItemId);
          if(!item||(agreementId&&Number(item.agreement_id)!==Number(agreementId)))return res.status(404).json({error:'Rental item not found.'});
          agreementId=agreementId||item.agreement_id;
        }
        for(const file of req.files){
          const descriptor=await storeFile(file,mediaType,rentalItemId||req.body.rental_id||req.body.trailer_id||'unassigned',{actor:actor(req)});
          // A failed metadata insert must not leave the bytes behind.
          try{created.push(await db.createTrailerMedia({...descriptor,mediaType,trailerId:req.body.trailer_id,rentalId:req.body.rental_id,
            agreementId,rentalItemId,
            inspectionId:req.body.inspection_id,invoiceId:req.body.invoice_id,uploadedByAdminId:req.admin.id,notes:req.body.notes}));}
          catch(e){await storage.removeObjects(descriptor.uploaded);throw e;}
        }
        res.status(201).json({media:created});
      }catch(e){next(e);}finally{await cleanupFiles(req.files);}
    });
  });
  // A short-lived URL the browser (or Telegram) can fetch. Works for BOTH
  // backends: Supabase mints its own signed URL, while a database-backed file
  // gets an HMAC-signed link to /api/trailer-media/:id. Never a permanent or
  // unsigned public URL, and the resulting URL is never logged.
  router.get('/api/trailer-department/media/:id/signed-url',requirePermission('trailers.view','trailer_receipts.view'),asyncRoute(async(req,res)=>{
    const media=await db.getTrailerMedia(req.params.id);if(!media)return res.status(404).json({error:'Media not found.'});
    if(media.media_type==='payment_receipt'&&!can(req,'trailer_receipts.view'))return res.status(403).json({error:'Receipt permission required.'});
    res.json({url:await storage.buildSignedMediaUrl(media,{preview:req.query.preview==='true'}),expires_in:storage.DEFAULT_TTL_SECONDS});
  }));
  // Documents/receipts attached to one invoice — metadata only, never bytes.
  // Receipt rows are hidden from callers without the receipt permission; the
  // signed-url route above enforces the same rule again at fetch time.
  router.get('/api/trailer-department/invoices/:id/media',requirePermission('trailer_payments.view'),asyncRoute(async(req,res)=>{
    res.json({media:await db.listInvoiceMedia(req.params.id,{includeReceipts:can(req,'trailer_receipts.view')})});
  }));

  router.get('/api/trailer-department/invoices',requirePermission('trailer_payments.view'),asyncRoute(async(req,res)=>{
    const data=await db.listTrailerInvoices({...req.query,companyId:req.query.companyId??req.query.company_id,
      agreementId:req.query.agreementId??req.query.agreement_id});
    res.json(Array.isArray(data)?{invoices:data}:{...data,invoices:data.items});
  }));
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
        // Overpayment is only allowed with the permission AND explicit confirmation.
        const allowOverpayment=can(req,'trailer_payments.record_overpayment')
          &&(req.body.confirm_overpayment==='true'||req.body.confirm_overpayment===true);
        const result=await db.recordTrailerPayment({...req.body,allow_overpayment:allowOverpayment},actor(req),descriptor);
        if(result.duplicate&&descriptor?.uploadedPaths)await storage.removeObjects(descriptor.uploadedPaths);
        res.status(result.duplicate?200:201).json(result);
      }catch(e){if(descriptor?.uploadedPaths)await storage.removeObjects(descriptor.uploadedPaths);next(e);}finally{await cleanupFiles(req.file?[req.file]:[]);}
    });
  });
  router.post('/api/trailer-department/payments/:id/reverse',requirePermission('trailer_payments.reverse'),asyncRoute(async(req,res)=>res.json(await db.reverseTrailerPayment(req.params.id,req.body?.reason,actor(req)))));
  router.get('/api/trailer-department/companies/:id/credits',requirePermission('trailer_payments.view'),asyncRoute(async(req,res)=>res.json({credits:await db.listCompanyCredits(req.params.id)})));
  router.post('/api/trailer-department/credits/:id/apply',requirePermission('trailer_payments.record'),asyncRoute(async(req,res)=>res.json({credit:await db.applyCompanyCredit({creditId:req.params.id,invoiceId:req.body?.invoice_id,amount:req.body?.amount,actor:actor(req)})})));
  router.post('/api/trailer-department/notifications/:id/retry',requirePermission('trailer_payments.record','trailer_settings.manage'),asyncRoute(async(req,res)=>{
    const job=await db.retryTrailerNotification(req.params.id);if(!job)return res.status(404).json({error:'Failed notification not found.'});res.json({job});
  }));
  router.post('/api/trailer-department/invoices/:id/reminder-action',requirePermission('trailer_payments.record'),asyncRoute(async(req,res)=>{
    await db.updateInvoiceReminderState(req.params.id,req.body||{},actor(req));res.json({updated:true});
  }));

  // storage_configured stays TRUE now: uploads always work, because with no
  // Supabase bucket the files go into the database. storage_backend tells the
  // settings screen which one is actually in use.
  router.get('/api/trailer-department/settings',requirePermission('trailer_settings.manage'),asyncRoute(async(req,res)=>res.json({
    settings:await db.getTrailerSettings(),
    storage_configured:storage.isConfigured(),
    storage_backend:storage.activeBackend(),
    supabase_configured:storage.isSupabaseConfigured(),
  })));
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
    const rows=await db.getTrailerReport(req.params.name,req.query);if(req.query.format==='csv')return sendCsv(res,req.params.name,rows);res.json({rows});
  }));
  router.get('/api/trailer-department/audit',requirePermission('trailer_reports.view'),asyncRoute(async(req,res)=>{
    const data=await db.listTrailerAudit(req.query);
    // Paged → the standard envelope (+ audit alias for old readers); else legacy bare array.
    res.json(Array.isArray(data)?{audit:data}:{...data,audit:data.items});
  }));

  router.use((error,_req,res,_next)=>{
    console.error('[TRAILER-DEPARTMENT]',error.message);
    const {status,payload}=errorPayload(error);
    res.status(status).json(payload);
  });
  return router;
}

module.exports={createTrailerDepartmentRoutes,storeFile,sendCsv};
