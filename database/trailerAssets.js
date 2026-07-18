'use strict';

const { query, pool } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');

const PHYSICAL = new Set(['unknown','available','rented','under_inspection','maintenance','out_of_service','held_damage']);

/**
 * Department trailer list.
 *
 * Defaults to OFFICIAL trailers only (active + master_status='active'). A
 * pending-review, archived or merged trailer keeps its whole history but is not
 * an asset: it must not appear in the department list, on the map, or in a
 * rental picker. Pass `master_status` to target one group (the master-list
 * review section), or `include_unofficial` to see everything (detail lookups).
 */
async function listDepartmentTrailers(filters={}){
  const values=[];const where=[];
  if(filters.q){values.push(`%${String(filters.q).trim()}%`);where.push(`(t.unit_number ILIKE $${values.length} OR t.plate_number ILIKE $${values.length} OR t.vin ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`);}
  if(filters.physicalStatus){values.push(filters.physicalStatus);where.push(`t.physical_status=$${values.length}`);}
  if(filters.master_status){values.push(filters.master_status);where.push(`t.master_status=$${values.length}`);}
  else if(filters.include_unofficial!==true&&filters.include_unofficial!=='true'){where.push(`t.active=TRUE AND t.master_status='active'`);}
  // The current renter comes from EITHER system: an active legacy rental or an
  // active agreement item (via its agreement's company).
  const select=`SELECT t.*,s.possession_status,s.cargo_status,s.display_status,s.current_location_text,
       s.current_lat,s.current_lng,s.location_source,s.location_confidence,s.last_event_at,
       r.id AS current_rental_id,COALESCE(r.agreement_number,ia.agreement_number) AS agreement_number,
       COALESCE(r.start_at,it.actual_pickup_at) AS rental_start_at,
       COALESCE(r.expected_return_at,it.expected_return_at) AS expected_return_at,
       COALESCE(c.id,ic.id) AS current_company_id,COALESCE(c.display_name,ic.display_name) AS current_company_name,
       it.id AS current_item_id,ia.id AS current_agreement_id,
       i.status AS invoice_status,
       GREATEST(COALESCE(i.total_amount,0)-COALESCE(p.total_paid,0),0) AS outstanding_balance
     FROM trailers t LEFT JOIN trailer_current_status s ON s.trailer_id=t.id
     LEFT JOIN trailer_rentals r ON r.trailer_id=t.id AND r.status='active'
     LEFT JOIN trailer_renter_companies c ON c.id=r.company_id
     LEFT JOIN LATERAL(SELECT * FROM trailer_rental_items x WHERE x.trailer_id=t.id AND x.item_status='active' LIMIT 1)it ON TRUE
     LEFT JOIN trailer_rental_agreements ia ON ia.id=it.agreement_id
     LEFT JOIN trailer_renter_companies ic ON ic.id=ia.company_id
     LEFT JOIN LATERAL(SELECT * FROM trailer_invoices x WHERE x.rental_id=r.id ORDER BY created_at DESC LIMIT 1)i ON TRUE
     LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments WHERE invoice_id=i.id AND verification_status IN('recorded','verified'))p ON TRUE`;
  const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
  if(filters.page){
    const page=Math.max(Number(filters.page)||1,1);
    const size=Math.min(Math.max(Number(filters.page_size??filters.pageSize)||25,1),200);
    const total=await query(
      `SELECT COUNT(*)::int AS total FROM trailers t
       LEFT JOIN trailer_rentals r ON r.trailer_id=t.id AND r.status='active'
       LEFT JOIN trailer_renter_companies c ON c.id=r.company_id ${clause}`,values);
    const res=await query(`${select} ${clause} ORDER BY t.active DESC,t.unit_number LIMIT ${size} OFFSET ${(page-1)*size}`,values);
    return {items:res.rows,page,page_size:size,total:total.rows[0].total};
  }
  const res=await query(`${select} ${clause} ORDER BY t.active DESC,t.unit_number LIMIT 1000`,values);
  return res.rows;
}

/**
 * One trailer by id, WHATEVER its master status — a detail page must still open
 * for a pending-review or archived trailer so its history stays reachable and a
 * reviewer can act on it.
 */
async function getDepartmentTrailer(id){
  const rows=await listDepartmentTrailers({include_unofficial:true});return rows.find((r)=>Number(r.id)===Number(id))||null;
}

async function updateDepartmentTrailer(id,data,actor){
  if(data.physical_status&&!PHYSICAL.has(data.physical_status))throw Object.assign(new Error('Invalid physical status.'),{status:400});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const before=await client.query('SELECT * FROM trailers WHERE id=$1 FOR UPDATE',[id]);
    if(!before.rows[0]){await client.query('ROLLBACK');return null;}
    if(data.version!==undefined&&data.version!==null&&Number(before.rows[0].version)!==Number(data.version)){
      throw Object.assign(new Error('This record changed while you were editing. Reload and try again.'),
        {status:409,code:'VERSION_CONFLICT',currentVersion:before.rows[0].version});
    }
    if(data.physical_status==='available'){
      const active=await client.query(`SELECT id FROM trailer_rentals WHERE trailer_id=$1 AND status='active'`,[id]);
      if(active.rows[0])throw Object.assign(new Error('A trailer with an active rental cannot be made available.'),{status:409});
    }
    if(data.active===false){const active=await client.query(`SELECT id FROM trailer_rentals WHERE trailer_id=$1 AND status='active'`,[id]);if(active.rows[0])throw Object.assign(new Error('A trailer with an active rental cannot be archived.'),{status:409});}
    const allowed=['make','model','mc_number','plate_number','type','vin','year','ownership_status','active','physical_status','tracking_reference','notes','needs_review'];
    const params=[id,actor?.id||null];const sets=['updated_by_admin_id=$2','updated_at=NOW()','version=version+1'];
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
