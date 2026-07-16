'use strict';

const { query, pool } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');

const PHYSICAL = new Set(['unknown','available','rented','under_inspection','maintenance','out_of_service','held_damage']);

async function listDepartmentTrailers(filters={}){
  const values=[];const where=[];
  if(filters.q){values.push(`%${String(filters.q).trim()}%`);where.push(`(t.unit_number ILIKE $${values.length} OR t.plate_number ILIKE $${values.length} OR t.vin ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`);}
  if(filters.physicalStatus){values.push(filters.physicalStatus);where.push(`t.physical_status=$${values.length}`);}
  const res=await query(
    `SELECT t.*,s.possession_status,s.cargo_status,s.display_status,s.current_location_text,
       s.current_lat,s.current_lng,s.location_source,s.location_confidence,s.last_event_at,
       r.id AS current_rental_id,r.agreement_number,r.start_at AS rental_start_at,
       r.expected_return_at,c.id AS current_company_id,c.display_name AS current_company_name,
       i.status AS invoice_status,
       GREATEST(COALESCE(i.total_amount,0)-COALESCE(p.total_paid,0),0) AS outstanding_balance
     FROM trailers t LEFT JOIN trailer_current_status s ON s.trailer_id=t.id
     LEFT JOIN trailer_rentals r ON r.trailer_id=t.id AND r.status='active'
     LEFT JOIN trailer_renter_companies c ON c.id=r.company_id
     LEFT JOIN LATERAL(SELECT * FROM trailer_invoices x WHERE x.rental_id=r.id ORDER BY created_at DESC LIMIT 1)i ON TRUE
     LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments WHERE invoice_id=i.id AND verification_status IN('recorded','verified'))p ON TRUE
     ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY t.active DESC,t.unit_number LIMIT 1000`,values);
  return res.rows;
}

async function getDepartmentTrailer(id){
  const rows=await listDepartmentTrailers();return rows.find((r)=>Number(r.id)===Number(id))||null;
}

async function updateDepartmentTrailer(id,data,actor){
  if(data.physical_status&&!PHYSICAL.has(data.physical_status))throw Object.assign(new Error('Invalid physical status.'),{status:400});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const before=await client.query('SELECT * FROM trailers WHERE id=$1 FOR UPDATE',[id]);
    if(!before.rows[0]){await client.query('ROLLBACK');return null;}
    if(data.physical_status==='available'){
      const active=await client.query(`SELECT id FROM trailer_rentals WHERE trailer_id=$1 AND status='active'`,[id]);
      if(active.rows[0])throw Object.assign(new Error('A trailer with an active rental cannot be made available.'),{status:409});
    }
    if(data.active===false){const active=await client.query(`SELECT id FROM trailer_rentals WHERE trailer_id=$1 AND status='active'`,[id]);if(active.rows[0])throw Object.assign(new Error('A trailer with an active rental cannot be archived.'),{status:409});}
    const allowed=['make','model','mc_number','plate_number','type','vin','year','ownership_status','active','physical_status','tracking_reference','notes','needs_review'];
    const params=[id,actor?.id||null];const sets=['updated_by_admin_id=$2','updated_at=NOW()'];
    for(const key of allowed)if(Object.prototype.hasOwnProperty.call(data,key)){params.push(data[key]);sets.push(`${key}=$${params.length}`);}
    const res=await client.query(`UPDATE trailers SET ${sets.join(',')} WHERE id=$1 RETURNING *`,params);
    await insertTrailerAudit({adminId:actor?.id,roleKeys:actor?.role_keys||[],ipAddress:actor?.ipAddress,
      action:'trailer.update',entityType:'trailer',entityId:id,oldValues:before.rows[0],newValues:res.rows[0],reason:data.reason},client);
    await client.query('COMMIT');return res.rows[0];
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function createDepartmentTrailer(data,actor){
  const unit=String(data.unit_number||'').trim().toUpperCase();if(!unit)throw Object.assign(new Error('Unit number is required.'),{status:400});
  if(data.physical_status&&!PHYSICAL.has(data.physical_status))throw Object.assign(new Error('Invalid physical status.'),{status:400});
  const client=await pool.connect();try{await client.query('BEGIN');const res=await client.query(
    `INSERT INTO trailers(unit_number,make,model,plate_number,type,vin,year,ownership_status,physical_status,tracking_reference,notes,needs_review,source,created_by_admin_id,updated_by_admin_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'admin_manual',$13,$13)RETURNING *`,
    [unit,data.make||null,data.model||null,data.plate_number||null,data.type||null,data.vin||null,data.year||null,data.ownership_status||null,data.physical_status||'unknown',data.tracking_reference||null,data.notes||null,data.needs_review!==false,actor?.id||null]);
    await insertTrailerAudit({adminId:actor?.id,roleKeys:actor?.role_keys||[],ipAddress:actor?.ipAddress,action:'trailer.create',entityType:'trailer',entityId:res.rows[0].id,newValues:res.rows[0]},client);await client.query('COMMIT');return res.rows[0];
  }catch(e){try{await client.query('ROLLBACK');}catch(_){}throw e;}finally{client.release();}
}

async function getActiveRentalForTrailer(trailerId){
  const res=await query(`SELECT r.*,c.display_name AS company_name FROM trailer_rentals r
    JOIN trailer_renter_companies c ON c.id=r.company_id WHERE r.trailer_id=$1 AND r.status='active' LIMIT 1`,[trailerId]);
  return res.rows[0]||null;
}

module.exports={listDepartmentTrailers,getDepartmentTrailer,createDepartmentTrailer,updateDepartmentTrailer,getActiveRentalForTrailer,PHYSICAL};
