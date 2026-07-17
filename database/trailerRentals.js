'use strict';

const { pool, query } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');
const { calculateInvoice } = require('../services/trailerBillingService');

const REQUIRED_INSPECTION_FIELDS = ['overall_condition','tires','lights','doors','roof','floor','exterior','interior','landing_gear'];

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function actorMeta(actor) { return { adminId: actor?.id, roleKeys: actor?.role_keys || [], ipAddress: actor?.ipAddress }; }

async function nextNumber(client, table, column, prefix) {
  const year = new Date().getUTCFullYear();
  const stem = `${prefix}-${year}-`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${stem}`]);
  const allowed = { trailer_rentals: 'agreement_number', trailer_invoices: 'invoice_number', trailer_payments: 'receipt_number' };
  if (allowed[table] !== column) throw new Error('Invalid document sequence.');
  const res = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(${column}, '^.*-', ''), '')::int),0)+1 AS next
       FROM ${table} WHERE ${column} LIKE $1`,
    [`${stem}%`],
  );
  return `${stem}${String(res.rows[0].next).padStart(6, '0')}`;
}

async function listTrailerRentals(filters = {}) {
  const values = [];
  const where = [];
  for (const [column, value] of [['r.status', filters.status], ['r.company_id', filters.companyId], ['r.trailer_id', filters.trailerId]]) {
    if (value != null && value !== '') { values.push(value); where.push(`${column} = $${values.length}`); }
  }
  if (filters.q) {
    values.push(`%${String(filters.q).trim()}%`);
    where.push(`(r.agreement_number ILIKE $${values.length} OR t.unit_number ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`);
  }
  const res = await query(
    `SELECT r.*, t.unit_number, t.physical_status, t.needs_review AS trailer_needs_review,
            c.display_name AS company_name,
            i.id AS invoice_id, i.invoice_number, i.total_amount,
            COALESCE(pay.total_paid,0) AS total_paid,
            GREATEST(COALESCE(i.total_amount,0)-COALESCE(pay.total_paid,0),0) AS outstanding_balance
       FROM trailer_rentals r
       JOIN trailers t ON t.id=r.trailer_id
       JOIN trailer_renter_companies c ON c.id=r.company_id
       LEFT JOIN LATERAL (SELECT * FROM trailer_invoices x WHERE x.rental_id=r.id ORDER BY x.created_at DESC LIMIT 1) i ON TRUE
       LEFT JOIN LATERAL (SELECT SUM(p.amount) AS total_paid FROM trailer_payments p
         WHERE p.invoice_id=i.id AND p.verification_status IN ('recorded','verified')) pay ON TRUE
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC LIMIT 500`,
    values,
  );
  return res.rows;
}

async function getTrailerRental(id) {
  const res = await query(
    `SELECT r.*, t.unit_number, t.physical_status, t.needs_review AS trailer_needs_review,
            c.display_name AS company_name, c.legal_name AS company_legal_name
       FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id
       JOIN trailer_renter_companies c ON c.id=r.company_id WHERE r.id=$1`, [id],
  );
  if (!res.rows[0]) return null;
  const [inspections, movements, invoices, media] = await Promise.all([
    query('SELECT * FROM trailer_inspections WHERE rental_id=$1 ORDER BY inspected_at', [id]),
    query('SELECT * FROM trailer_rental_movements WHERE rental_id=$1 ORDER BY event_at', [id]),
    query(`SELECT i.*, COALESCE(p.total_paid,0) AS total_paid,
      GREATEST(i.total_amount-COALESCE(p.total_paid,0),0) AS outstanding_balance
      FROM trailer_invoices i LEFT JOIN LATERAL (SELECT SUM(amount) total_paid FROM trailer_payments
      WHERE invoice_id=i.id AND verification_status IN ('recorded','verified')) p ON TRUE
      WHERE i.rental_id=$1 ORDER BY i.created_at`, [id]),
    query('SELECT * FROM trailer_media WHERE rental_id=$1 ORDER BY created_at', [id]),
  ]);
  return { ...res.rows[0], inspections: inspections.rows, movements: movements.rows, invoices: invoices.rows, media: media.rows };
}

function validateRentalInput(data, partial = false) {
  if (!partial && (!data.trailer_id || !data.company_id)) throw httpError('Trailer and renter company are required.');
  if (data.currency && data.currency !== 'USD') throw httpError('Only USD is supported.');
  const methods = ['calendar_day','twenty_four_hour','manual_days','flat_rate'];
  if (data.billing_method && !methods.includes(data.billing_method)) throw httpError('Invalid billing method.');
  if (data.billing_method === 'manual_days' && (!Number.isInteger(Number(data.manual_billable_days)) || !String(data.manual_days_reason || '').trim())) {
    throw httpError('Manual billable days and a reason are required.');
  }
}

async function createTrailerRental(data, actor) {
  validateRentalInput(data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const agreement = await nextNumber(client, 'trailer_rentals', 'agreement_number', 'RENT');
    const res = await client.query(
      `INSERT INTO trailer_rentals
       (agreement_number,trailer_id,company_id,status,start_at,expected_return_at,billing_method,
        daily_rate,flat_rate,currency,deposit_amount,discount_amount,late_fee_rule,grace_period_days,
        payment_due_at,payment_terms,pickup_location,pickup_lat,pickup_lng,manual_billable_days,
        manual_days_reason,manual_days_by_admin_id,manual_days_recorded_at,notes,created_by_admin_id,updated_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'USD',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)
       RETURNING *`,
      [agreement,data.trailer_id,data.company_id,data.status || 'draft',data.start_at || null,
       data.expected_return_at || null,data.billing_method || 'calendar_day',data.daily_rate ?? null,
       data.flat_rate ?? null,data.deposit_amount || 0,data.discount_amount || 0,data.late_fee_rule || null,
       data.grace_period_days || 0,data.payment_due_at || null,data.payment_terms || null,
       data.pickup_location || null,data.pickup_lat ?? null,data.pickup_lng ?? null,
       data.manual_billable_days ?? null,data.manual_days_reason || null,
       data.billing_method==='manual_days'?actor?.id||null:null,data.billing_method==='manual_days'?new Date().toISOString():null,
       data.notes || null,actor?.id || null],
    );
    await insertTrailerAudit({ ...actorMeta(actor), action: 'rental.create', entityType: 'rental', entityId: res.rows[0].id, newValues: res.rows[0] }, client);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function updateTrailerRental(id, data, actor) {
  validateRentalInput(data, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM trailer_rentals WHERE id=$1 FOR UPDATE', [id]);
    if (!before.rows[0]) { await client.query('ROLLBACK'); return null; }
    if (!['draft','scheduled','disputed'].includes(before.rows[0].status)) throw httpError('This rental can no longer be edited.', 409);
    const allowed = ['company_id','start_at','expected_return_at','billing_method','daily_rate','flat_rate','deposit_amount','discount_amount','late_fee_rule','grace_period_days','payment_due_at','payment_terms','pickup_location','pickup_lat','pickup_lng','manual_billable_days','manual_days_reason','notes'];
    const sets = ['updated_by_admin_id=$2','updated_at=NOW()'];
    const params = [id, actor?.id || null];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(data, key)) { params.push(data[key]); sets.push(`${key}=$${params.length}`); }
    if(data.billing_method==='manual_days'||data.manual_billable_days!=null){params.push(actor?.id||null);sets.push(`manual_days_by_admin_id=$${params.length}`,`manual_days_recorded_at=NOW()`);}
    const res = await client.query(`UPDATE trailer_rentals SET ${sets.join(',')} WHERE id=$1 RETURNING *`, params);
    await insertTrailerAudit({ ...actorMeta(actor), action: 'rental.update', entityType: 'rental', entityId: id, oldValues: before.rows[0], newValues: res.rows[0], reason: data.reason }, client);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (error) { try { await client.query('ROLLBACK'); } catch (_) {} throw error; } finally { client.release(); }
}

/** The photo an inspection of this type cannot be completed without. */
const REQUIRED_INSPECTION_MEDIA = {
  pickup: 'pickup_condition_photo',
  return: 'return_condition_photo',
};

/**
 * Save inspection answers. ALWAYS as a draft.
 *
 * `completed` is deliberately ignored here. The frontend used to be able to
 * mark an inspection complete before its photo upload had succeeded, which left
 * a "completed" inspection with no photo and blocked activation with a
 * confusing error. Completion now happens ONLY through completeInspection(),
 * which verifies the media really exists first.
 */
async function saveInspection(data, actor) {
  if (!['pickup','return','damage','maintenance'].includes(data.inspection_type)) throw httpError('Invalid inspection type.');
  const client=await pool.connect();try{await client.query('BEGIN');
  const rental = await client.query('SELECT trailer_id FROM trailer_rentals WHERE id=$1', [data.rental_id]);
  if (!rental.rows[0]) throw httpError('Rental not found.', 404);
  const before=await client.query('SELECT * FROM trailer_inspections WHERE rental_id=$1 AND inspection_type=$2 FOR UPDATE',[data.rental_id,data.inspection_type]);
  const res = await client.query(
    `INSERT INTO trailer_inspections
     (rental_id,trailer_id,inspection_type,overall_condition,tires,lights,doors,roof,floor,exterior,
      interior,landing_gear,brakes,existing_damage,new_damage,missing_equipment,notes,inspector_admin_id,inspected_at,completed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,NOW()),$20)
     ON CONFLICT (rental_id,inspection_type) DO UPDATE SET
      overall_condition=EXCLUDED.overall_condition,tires=EXCLUDED.tires,lights=EXCLUDED.lights,
      doors=EXCLUDED.doors,roof=EXCLUDED.roof,floor=EXCLUDED.floor,exterior=EXCLUDED.exterior,
      interior=EXCLUDED.interior,landing_gear=EXCLUDED.landing_gear,brakes=EXCLUDED.brakes,
      existing_damage=EXCLUDED.existing_damage,new_damage=EXCLUDED.new_damage,
      missing_equipment=EXCLUDED.missing_equipment,notes=EXCLUDED.notes,
      inspector_admin_id=EXCLUDED.inspector_admin_id,inspected_at=EXCLUDED.inspected_at,
      -- completed is owned solely by completeInspection(). Saving answers must
      -- neither complete an inspection nor silently un-complete one.
      completed=trailer_inspections.completed,updated_at=NOW() RETURNING *`,
    [data.rental_id,rental.rows[0].trailer_id,data.inspection_type,data.overall_condition || null,
     data.tires || null,data.lights || null,data.doors || null,data.roof || null,data.floor || null,
     data.exterior || null,data.interior || null,data.landing_gear || null,data.brakes || null,
     data.existing_damage || null,data.new_damage || null,data.missing_equipment || null,
     data.notes || null,actor?.id || null,data.inspected_at || null,false],
  );
  await insertTrailerAudit({...actorMeta(actor),action:`inspection.${before.rows[0]?'update':'create'}`,entityType:'inspection',entityId:res.rows[0].id,oldValues:before.rows[0]||null,newValues:res.rows[0]},client);
  await client.query('COMMIT');return res.rows[0];
  }catch(error){try{await client.query('ROLLBACK');}catch(_){}throw error;}finally{client.release();}
}

/**
 * Complete an inspection — the ONLY path that sets completed=true.
 *
 * Transactional and verifying: every required field must be answered AND the
 * required photo must genuinely exist, metadata *and* bytes. A failed upload
 * therefore leaves the inspection incomplete and retryable, instead of
 * producing a "completed" inspection with nothing behind it.
 *
 * For database-backed media the bytes are checked by joining the blob and
 * confirming it is non-empty — the metadata row alone is not proof the file
 * landed.
 */
async function completeInspection(rentalId, type, actor) {
  if (!['pickup','return','damage','maintenance'].includes(type)) throw httpError('Invalid inspection type.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT * FROM trailer_inspections WHERE rental_id=$1 AND inspection_type=$2 FOR UPDATE',
      [rentalId, type],
    );
    const inspection = found.rows[0];
    if (!inspection) throw httpError('Save the inspection before completing it.', 404);

    const missing = REQUIRED_INSPECTION_FIELDS.filter((key) => !String(inspection[key] || '').trim());
    if (missing.length) {
      throw httpError(`Answer every required inspection field first. Missing: ${missing.join(', ')}.`);
    }

    const requiredMedia = REQUIRED_INSPECTION_MEDIA[type];
    if (requiredMedia) {
      // Metadata AND bytes: a row whose blob vanished is not a stored photo.
      const media = await client.query(
        `SELECT m.id
           FROM trailer_media m
           LEFT JOIN trailer_media_blobs b ON b.id = m.blob_id
          WHERE m.inspection_id = $1
            AND m.media_type = $2
            AND (m.storage_backend = 'supabase' OR (b.id IS NOT NULL AND b.byte_size > 0))
          LIMIT 1`,
        [inspection.id, requiredMedia],
      );
      if (!media.rows[0]) {
        throw httpError(
          `At least one ${type} photo must be uploaded before this inspection can be completed.`,
          422,
        );
      }
    }

    const updated = await client.query(
      `UPDATE trailer_inspections SET completed=TRUE, inspector_admin_id=COALESCE($2,inspector_admin_id),
              updated_at=NOW() WHERE id=$1 RETURNING *`,
      [inspection.id, actor?.id || null],
    );
    await insertTrailerAudit({
      ...actorMeta(actor), action: 'inspection.complete', entityType: 'inspection',
      entityId: inspection.id, oldValues: inspection, newValues: updated.rows[0],
    }, client);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters more */ }
    throw error;
  } finally {
    client.release();
  }
}

async function createAuthoritativeMovement(client, { rental, inspection, type, at, location, lat, lng, actor }) {
  const movement = await client.query(
    `INSERT INTO trailer_rental_movements
      (trailer_id,rental_id,movement_type,to_location,to_lat,to_lng,event_at,employee_admin_id,inspection_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [rental.trailer_id,rental.id,type,location || null,lat ?? null,lng ?? null,at,actor?.id || null,inspection.id],
  );
  const eventType = type === 'rental_pickup' ? 'pickup' : 'dropoff';
  const possession = eventType === 'pickup' ? 'with_driver' : 'dropped';
  const cargo = eventType === 'pickup' ? 'unknown' : 'empty';
  const event = await client.query(
    `INSERT INTO trailer_events
      (trailer_id,trailer_unit_number,event_type,possession_status,cargo_status,confidence,
       reported_by_name,location_text,location_lat,location_lng,location_source,location_missing,
       condition_text,event_time,review_status,source,beta_mode,rental_movement_id)
     SELECT $1,t.unit_number,$2,$3,$4,100,$5,$6,$7,$8,'manual',$9,$10,$11,'accepted','rental_manual',FALSE,$12
       FROM trailers t WHERE t.id=$1 RETURNING *`,
    [rental.trailer_id,eventType,possession,cargo,actor?.username || 'Trailer Department',location || null,
     lat ?? null,lng ?? null,!location,inspection.overall_condition || null,at,movement.rows[0].id],
  );
  await client.query('UPDATE trailer_rental_movements SET trailer_event_id=$2 WHERE id=$1', [movement.rows[0].id,event.rows[0].id]);
  await client.query(
    `INSERT INTO trailer_current_status
      (trailer_id,unit_number,current_status,possession_status,cargo_status,display_status,
       current_location_text,current_lat,current_lng,current_condition,last_reporter_name,
       last_event_id,last_event_type,last_event_at,needs_review,location_source,updated_at)
     SELECT t.id,t.unit_number,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,'manual',NOW()
       FROM trailers t WHERE t.id=$1
     ON CONFLICT (trailer_id) DO UPDATE SET current_status=EXCLUDED.current_status,
       possession_status=EXCLUDED.possession_status,cargo_status=EXCLUDED.cargo_status,
       display_status=EXCLUDED.display_status,current_location_text=EXCLUDED.current_location_text,
       current_lat=EXCLUDED.current_lat,current_lng=EXCLUDED.current_lng,
       current_condition=EXCLUDED.current_condition,last_reporter_name=EXCLUDED.last_reporter_name,
       last_event_id=EXCLUDED.last_event_id,last_event_type=EXCLUDED.last_event_type,
       last_event_at=EXCLUDED.last_event_at,needs_review=FALSE,pending_event_id=NULL,
       location_source='manual',updated_at=NOW()`,
    [rental.trailer_id,possession,cargo,eventType === 'pickup' ? 'With driver / Unknown cargo' : 'Dropped / Empty',
     location || null,lat ?? null,lng ?? null,inspection.overall_condition || null,
     actor?.username || 'Trailer Department',event.rows[0].id,eventType,at],
  );
  return { movement: movement.rows[0], event: event.rows[0] };
}

async function validateInspectionMedia(client, rentalId, type) {
  const inspection = await client.query('SELECT * FROM trailer_inspections WHERE rental_id=$1 AND inspection_type=$2 AND completed=TRUE', [rentalId,type]);
  if (!inspection.rows[0]) throw httpError(`A completed ${type} inspection is required.`);
  const media = await client.query(
    `SELECT COUNT(*)::int AS count FROM trailer_media WHERE inspection_id=$1
      AND media_type = $2`,
    [inspection.rows[0].id, type === 'pickup' ? 'pickup_condition_photo' : 'return_condition_photo'],
  );
  if (!media.rows[0].count) throw httpError(`${type === 'pickup' ? 'Pickup' : 'Return'} condition photos are required.`);
  return inspection.rows[0];
}

async function activateTrailerRental(id, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query('SELECT * FROM trailer_rentals WHERE id=$1 FOR UPDATE', [id]);
    const rental = res.rows[0];
    if (!rental) throw httpError('Rental not found.', 404);
    if (!['draft','scheduled'].includes(rental.status)) throw httpError('Only draft or scheduled rentals can be activated.', 409);
    const trailer = await client.query('SELECT * FROM trailers WHERE id=$1 FOR UPDATE', [rental.trailer_id]);
    if (!trailer.rows[0] || !trailer.rows[0].active || trailer.rows[0].needs_review || trailer.rows[0].physical_status !== 'available') {
      throw httpError('Trailer must be active, reviewed, and available.', 409);
    }
    // Master-list authority: a trailer that is pending review, archived or
    // merged is not an official asset and can never start a rental, however
    // available it looks physically.
    if (trailer.rows[0].master_status !== 'active') {
      const reason = {
        pending_master_review: 'This trailer is pending master-list review and cannot be rented until it is verified.',
        archived: 'This trailer is archived and cannot be rented.',
        merged: 'This trailer was merged into another record and cannot be rented.',
      };
      throw httpError(reason[trailer.rows[0].master_status] || 'Trailer is not on the official master list.', 409);
    }
    if (!rental.start_at || !rental.expected_return_at || !rental.pickup_location) throw httpError('Start, expected return, and pickup location are required.');
    if (rental.currency !== 'USD') throw httpError('Only USD is supported.');
    if (rental.billing_method === 'flat_rate' && (rental.flat_rate == null || Number(rental.flat_rate) < 0)) throw httpError('A flat rate is required.');
    if (rental.billing_method !== 'flat_rate' && (rental.daily_rate == null || Number(rental.daily_rate) < 0)) throw httpError('A daily rate is required.');
    if (rental.billing_method === 'manual_days' && (!rental.manual_billable_days || !rental.manual_days_reason || !rental.manual_days_by_admin_id)) throw httpError('Manual day count, reason, and employee are required.');
    const company = await client.query('SELECT active FROM trailer_renter_companies WHERE id=$1', [rental.company_id]);
    if (!company.rows[0]?.active) throw httpError('Renter company is inactive.', 409);
    const inspection = await validateInspectionMedia(client, id, 'pickup');
    const conflict = await client.query(`SELECT id FROM trailer_rentals WHERE trailer_id=$1 AND status='active' AND id<>$2`, [rental.trailer_id,id]);
    if (conflict.rows[0]) throw httpError('Trailer already has an active rental.', 409);
    const updated = await client.query(`UPDATE trailer_rentals SET status='active',updated_by_admin_id=$2,updated_at=NOW() WHERE id=$1 RETURNING *`, [id,actor?.id || null]);
    await client.query(`UPDATE trailers SET physical_status='rented',updated_by_admin_id=$2,updated_at=NOW() WHERE id=$1`, [rental.trailer_id,actor?.id || null]);
    const linked = await createAuthoritativeMovement(client,{rental:updated.rows[0],inspection,type:'rental_pickup',at:rental.start_at,location:rental.pickup_location,lat:rental.pickup_lat,lng:rental.pickup_lng,actor});
    await insertTrailerAudit({ ...actorMeta(actor), action:'rental.activate',entityType:'rental',entityId:id,oldValues:rental,newValues:updated.rows[0] },client);
    await client.query('COMMIT');
    return { rental:updated.rows[0],...linked };
  } catch(error) { try { await client.query('ROLLBACK'); } catch(_){} throw error; } finally { client.release(); }
}

async function returnTrailerRental(id, data, actor) {
  const allowedStatuses = ['available','under_inspection','maintenance','out_of_service','held_damage'];
  if (!allowedStatuses.includes(data.physical_status)) throw httpError('Choose the trailer status after return.');
  if ((data.new_damage || data.serious_damage) && data.physical_status === 'available') throw httpError('A damaged trailer cannot be marked available.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM trailer_rentals WHERE id=$1 FOR UPDATE', [id]);
    const rental = current.rows[0];
    if (!rental) throw httpError('Rental not found.',404);
    if (rental.status !== 'active') throw httpError('Only an active rental can be returned.',409);
    await client.query('SELECT id FROM trailers WHERE id=$1 FOR UPDATE',[rental.trailer_id]);
    const inspection = await validateInspectionMedia(client,id,'return');
    const actualReturn = data.actual_return_at || new Date().toISOString();
    const totals = calculateInvoice({
      startAt:rental.start_at,endAt:actualReturn,billingMethod:rental.billing_method,
      timezone:data.timezone || 'America/Chicago',manualDays:data.manual_billable_days ?? rental.manual_billable_days,
      manualReason:data.manual_days_reason || rental.manual_days_reason,dailyRate:rental.daily_rate,
      flatRate:rental.flat_rate,depositCredit:rental.deposit_amount,discountAmount:rental.discount_amount,
      damageCharge:data.damage_charge,cleaningCharge:data.cleaning_charge,lateFee:data.late_fee,
      otherCharges:data.other_charges,currency:'USD',
    });
    const updated = await client.query(
      `UPDATE trailer_rentals SET status='returned',actual_return_at=$2,return_location=$3,
       return_lat=$4,return_lng=$5,billable_days=$6,elapsed_days=$7,updated_by_admin_id=$8,
       closed_by_admin_id=$8,closed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id,actualReturn,data.return_location || null,data.return_lat ?? null,data.return_lng ?? null,
       totals.billableDays,totals.elapsedDays,actor?.id || null],
    );
    await client.query('UPDATE trailers SET physical_status=$2,updated_by_admin_id=$3,updated_at=NOW() WHERE id=$1',[rental.trailer_id,data.physical_status,actor?.id || null]);
    const invoiceNumber = await nextNumber(client,'trailer_invoices','invoice_number','INV');
    // due_at is the payment DEADLINE only — grace is NOT baked in here. The
    // grace period is applied exactly once, at reminder time (the first reminder
    // fires after due_at + grace). Adding it here too would double-count it.
    const dueAt = data.due_at || rental.payment_due_at || new Date(actualReturn).toISOString();
    const invoice = await client.query(
      `INSERT INTO trailer_invoices
       (invoice_number,rental_id,trailer_id,company_id,billing_period_start,billing_period_end,
        billing_method,billable_days,daily_rate,flat_rate,base_amount,deposit_credit,discount_amount,
        damage_charge,cleaning_charge,late_fee,other_charges,total_amount,late_fee_rule,grace_period_days,
        calculation_inputs,due_at,currency,status,
        notes,created_by_admin_id,finalized_by_admin_id,finalized_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'USD','issued',$23,$24,$24,NOW()) RETURNING *`,
      [invoiceNumber,id,rental.trailer_id,rental.company_id,rental.start_at,actualReturn,rental.billing_method,
       totals.billableDays,rental.daily_rate,rental.flat_rate,totals.baseAmount,totals.depositCredit,
       totals.discountAmount,totals.damageCharge,totals.cleaningCharge,totals.lateFee,totals.otherCharges,
       totals.totalAmount,rental.late_fee_rule,rental.grace_period_days,JSON.stringify({
         start_at:rental.start_at,end_at:actualReturn,timezone:data.timezone||'America/Chicago',
         billing_method:rental.billing_method,manual_days_reason:rental.manual_days_reason,
         manual_days_by_admin_id:rental.manual_days_by_admin_id,deposit_amount:rental.deposit_amount,
         discount_amount:rental.discount_amount,charges:{damage:data.damage_charge||0,cleaning:data.cleaning_charge||0,late:data.late_fee||0,other:data.other_charges||0},
       }),dueAt,data.notes || null,actor?.id || null],
    );
    const linked = await createAuthoritativeMovement(client,{rental:updated.rows[0],inspection,type:'rental_return',at:actualReturn,location:data.return_location,lat:data.return_lat,lng:data.return_lng,actor});
    await insertTrailerAudit({ ...actorMeta(actor),action:'rental.return',entityType:'rental',entityId:id,oldValues:rental,newValues:updated.rows[0],reason:data.notes },client);
    await insertTrailerAudit({ ...actorMeta(actor),action:'invoice.finalize',entityType:'invoice',entityId:invoice.rows[0].id,newValues:invoice.rows[0] },client);
    await client.query('COMMIT');
    return { rental:updated.rows[0],invoice:invoice.rows[0],...linked };
  } catch(error) { try { await client.query('ROLLBACK'); } catch(_){} throw error; } finally { client.release(); }
}

/**
 * Link a trailer event to a SPECIFIC rental movement — never "the newest one".
 *
 * The old implementation guessed the newest movement of the rental, which could
 * attach an event to the wrong trip and silently overwrite an existing link.
 * This now validates an explicit movementId: it must belong to the rental, must
 * not already be linked to another event, the event itself must not already be
 * linked, and the event's trailer must match the movement's trailer. When no
 * movementId is given and the rental has exactly one movement, that unambiguous
 * one is used; otherwise the caller must choose.
 */
async function linkTrailerEventToRental(eventId,rentalId,actor,options={}) {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const before=await client.query('SELECT * FROM trailer_events WHERE id=$1 FOR UPDATE',[eventId]);
    const event=before.rows[0];
    if(!event)throw httpError('Event not found.',404);
    if(event.rental_movement_id)throw httpError('This event is already linked to a movement.',409);
    let movementId=options.movementId!=null?Number(options.movementId):null;
    const movements=await client.query('SELECT id,trailer_id FROM trailer_rental_movements WHERE rental_id=$1',[rentalId]);
    if(movementId==null){
      if(movements.rows.length===1)movementId=movements.rows[0].id;
      else throw httpError('Specify which rental movement to link this event to.',422);
    }
    const movement=movements.rows.find((m)=>Number(m.id)===movementId);
    if(!movement)throw httpError('That movement does not belong to this rental.',404);
    if(event.trailer_id!=null&&movement.trailer_id!=null&&Number(event.trailer_id)!==Number(movement.trailer_id)){
      throw httpError('The event and movement are for different trailers.',409);
    }
    const taken=await client.query(`SELECT id FROM trailer_events WHERE rental_movement_id=$1 AND id<>$2`,[movementId,eventId]);
    if(taken.rows[0])throw httpError('That movement is already linked to another event.',409);
    const res=await client.query(`UPDATE trailer_events SET rental_movement_id=$1,review_status='accepted',reviewed_by=$3,reviewed_at=NOW() WHERE id=$2 RETURNING *`,[movementId,eventId,actor?.username || 'admin']);
    await insertTrailerAudit({...actorMeta(actor),action:'rental.event_link',entityType:'trailer_event',entityId:eventId,oldValues:before.rows[0],newValues:res.rows[0],reason:`movement:${movementId}`},client);
    await client.query('COMMIT');
    return res.rows[0]||null;
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function changeTrailerRentalStatus(id,status,reason,actor){
  if(!['cancelled','disputed'].includes(status)||!String(reason||'').trim())throw httpError('A valid status and reason are required.');
  const client=await pool.connect();try{await client.query('BEGIN');const before=await client.query('SELECT * FROM trailer_rentals WHERE id=$1 FOR UPDATE',[id]);if(!before.rows[0])throw httpError('Rental not found.',404);
    if(status==='cancelled'&&!['draft','scheduled'].includes(before.rows[0].status))throw httpError('Only draft or scheduled rentals can be cancelled.',409);
    if(status==='disputed'&&['closed','cancelled'].includes(before.rows[0].status))throw httpError('This rental cannot be disputed.',409);
    const res=await client.query(`UPDATE trailer_rentals SET status=$2,notes=concat_ws(E'\n',notes,$3),updated_by_admin_id=$4,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,status,reason,actor?.id||null]);
    await insertTrailerAudit({...actorMeta(actor),action:`rental.${status}`,entityType:'rental',entityId:id,oldValues:before.rows[0],newValues:res.rows[0],reason},client);await client.query('COMMIT');return res.rows[0];
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function estimateTrailerRental(id,endAt,timezone='America/Chicago'){
  const rental=await query('SELECT * FROM trailer_rentals WHERE id=$1',[id]);if(!rental.rows[0])throw httpError('Rental not found.',404);const r=rental.rows[0];
  return calculateInvoice({startAt:r.start_at,endAt:endAt||new Date().toISOString(),billingMethod:r.billing_method,timezone,manualDays:r.manual_billable_days,manualReason:r.manual_days_reason,dailyRate:r.daily_rate,flatRate:r.flat_rate,depositCredit:r.deposit_amount,discountAmount:r.discount_amount,currency:'USD'});
}

module.exports={ nextNumber,listTrailerRentals,getTrailerRental,createTrailerRental,updateTrailerRental,saveInspection,completeInspection,activateTrailerRental,returnTrailerRental,linkTrailerEventToRental,changeTrailerRentalStatus,estimateTrailerRental };
