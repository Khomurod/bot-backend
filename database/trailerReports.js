'use strict';

const { query } = require('./pool');

async function getTrailerDashboard(filters={}){
  const start=filters.start||new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString();
  const end=filters.end||new Date().toISOString();
  const [assets,rentals,finance,revenueTrailer,revenueCompany]=await Promise.all([
    query(`SELECT COUNT(*) FILTER(WHERE active)::int total_active,
      COUNT(*) FILTER(WHERE active AND physical_status='available')::int available,
      COUNT(*) FILTER(WHERE physical_status='rented')::int rented,
      COUNT(*) FILTER(WHERE physical_status='maintenance')::int maintenance,
      COUNT(*) FILTER(WHERE s.current_lat IS NULL OR s.current_lng IS NULL)::int unknown_location
      FROM trailers t LEFT JOIN trailer_current_status s ON s.trailer_id=t.id`),
    query(`SELECT COUNT(*) FILTER(WHERE status='active' AND expected_return_at BETWEEN NOW() AND NOW()+INTERVAL '7 days')::int ending_soon,
      COUNT(*) FILTER(WHERE status='active' AND expected_return_at<NOW())::int overdue_returns,
      COUNT(*) FILTER(WHERE status='active')::int active_rentals,
      COUNT(*) FILTER(WHERE status IN('returned','closed'))::int completed_rentals FROM trailer_rentals`),
    query(`SELECT COALESCE(SUM(i.total_amount) FILTER(WHERE i.created_at BETWEEN $1 AND $2 AND i.status<>'voided'),0) invoiced,
      COALESCE((SELECT SUM(amount) FROM trailer_payments WHERE payment_at BETWEEN $1 AND $2 AND verification_status IN('recorded','verified')),0) collected,
      COALESCE(SUM(GREATEST(i.total_amount-COALESCE(p.total_paid,0),0)) FILTER(WHERE i.status NOT IN('voided','paid')),0) outstanding,
      COALESCE(SUM(GREATEST(i.total_amount-COALESCE(p.total_paid,0),0)) FILTER(WHERE i.due_at<NOW() AND i.status NOT IN('voided','paid','disputed')),0) overdue,
      COALESCE(SUM(GREATEST(i.total_amount-COALESCE(p.total_paid,0),0)) FILTER(WHERE COALESCE(p.total_paid,0)>0 AND COALESCE(p.total_paid,0)<i.total_amount),0) partial_balance
      FROM trailer_invoices i LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments
      WHERE invoice_id=i.id AND verification_status IN('recorded','verified'))p ON TRUE`,[start,end]),
    query(`SELECT t.unit_number,COALESCE(SUM(i.total_amount),0) revenue FROM trailers t LEFT JOIN trailer_invoices i ON i.trailer_id=t.id AND i.status<>'voided' AND i.created_at BETWEEN $1 AND $2 GROUP BY t.id ORDER BY revenue DESC LIMIT 10`,[start,end]),
    query(`SELECT c.display_name,COALESCE(SUM(i.total_amount),0) revenue FROM trailer_renter_companies c LEFT JOIN trailer_invoices i ON i.company_id=c.id AND i.status<>'voided' AND i.created_at BETWEEN $1 AND $2 GROUP BY c.id ORDER BY revenue DESC LIMIT 10`,[start,end]),
  ]);
  const a=assets.rows[0],r=rentals.rows[0],f=finance.rows[0];
  // Current Occupancy: point-in-time share of official trailers rented right now.
  const currentOccupancy=Number(a.total_active)?Math.round((Number(r.active_rentals)/Number(a.total_active))*10000)/100:0;
  // Period Utilization: rented trailer-time ÷ available trailer-time over the
  // selected period, correctly handling trailers created/archived mid-period and
  // rentals that only partially overlap the window.
  const periodUtilization=await getPeriodUtilization(start,end);
  return{assets:a,rentals:r,finance:f,
    current_occupancy:currentOccupancy,
    utilization_percent:currentOccupancy, // legacy alias — same point-in-time metric
    period_utilization:periodUtilization,
    revenue_by_trailer:revenueTrailer.rows,revenue_by_company:revenueCompany.rows,filters:{start,end}};
}

/** True time-weighted utilization over [start,end]. Returns a percent (0-100). */
async function getPeriodUtilization(start,end){
  const res=await query(
    `WITH p AS (SELECT $1::timestamptz s, $2::timestamptz e),
     avail AS (
       SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
         LEAST(p.e, COALESCE(t.archived_at, p.e)) - GREATEST(p.s, t.created_at)))),0) sec
       FROM trailers t, p
       WHERE t.created_at < p.e AND (t.archived_at IS NULL OR t.archived_at > p.s)
         AND GREATEST(p.s,t.created_at) < LEAST(p.e, COALESCE(t.archived_at,p.e))),
     rented AS (
       SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
         LEAST(p.e, COALESCE(r.actual_return_at, r.expected_return_at, p.e)) - GREATEST(p.s, r.start_at)))),0) sec
       FROM trailer_rentals r, p
       WHERE r.status IN ('active','returned','closed') AND r.start_at IS NOT NULL
         AND r.start_at < p.e AND COALESCE(r.actual_return_at, r.expected_return_at, p.e) > p.s
         AND GREATEST(p.s,r.start_at) < LEAST(p.e, COALESCE(r.actual_return_at, r.expected_return_at, p.e)))
     SELECT CASE WHEN avail.sec>0 THEN ROUND((rented.sec/avail.sec*100)::numeric,2) ELSE 0 END pct
       FROM avail, rented`,[start,end]);
  return Number(res.rows[0]?.pct||0);
}

async function getTrailerReport(name, filters = {}){
  const reports={
    active_rentals:`SELECT r.agreement_number,t.unit_number,c.display_name company,r.start_at,r.expected_return_at,r.status FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id JOIN trailer_renter_companies c ON c.id=r.company_id WHERE r.status='active' ORDER BY r.expected_return_at`,
    overdue_returns:`SELECT r.agreement_number,t.unit_number,c.display_name company,r.expected_return_at,NOW()-r.expected_return_at overdue_for FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id JOIN trailer_renter_companies c ON c.id=r.company_id WHERE r.status='active' AND r.expected_return_at<NOW() ORDER BY r.expected_return_at`,
    missing_inspections:`SELECT r.agreement_number,t.unit_number,r.status FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id LEFT JOIN trailer_inspections i ON i.rental_id=r.id WHERE r.status IN('active','returned') GROUP BY r.id,t.unit_number HAVING COUNT(i.id) FILTER(WHERE i.completed)=0`,
    missing_receipts:`SELECT p.receipt_number,i.invoice_number,p.amount,p.payment_at FROM trailer_payments p JOIN trailer_invoices i ON i.id=p.invoice_id WHERE p.receipt_media_id IS NULL`,
    partial_payments:`SELECT i.invoice_number,c.display_name company,i.total_amount,COALESCE(SUM(p.amount),0) paid,i.total_amount-COALESCE(SUM(p.amount),0) outstanding FROM trailer_invoices i JOIN trailer_renter_companies c ON c.id=i.company_id LEFT JOIN trailer_payments p ON p.invoice_id=i.id AND p.verification_status IN('recorded','verified') GROUP BY i.id,c.display_name HAVING SUM(p.amount)>0 AND SUM(p.amount)<i.total_amount`,
    aging:`SELECT i.invoice_number,c.display_name company,i.due_at,i.total_amount-COALESCE(p.total_paid,0) outstanding,CASE WHEN NOW()-i.due_at<INTERVAL '8 days' THEN '1-7' WHEN NOW()-i.due_at<INTERVAL '31 days' THEN '8-30' WHEN NOW()-i.due_at<INTERVAL '61 days' THEN '31-60' ELSE '61+' END aging_bucket FROM trailer_invoices i JOIN trailer_renter_companies c ON c.id=i.company_id LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments WHERE invoice_id=i.id AND verification_status IN('recorded','verified'))p ON TRUE WHERE i.due_at<NOW() AND i.status NOT IN('paid','voided','disputed')`,
    company_credits:`SELECT c.display_name company,cc.original_amount,cc.remaining_amount,cc.status,cc.reason,cc.created_at FROM trailer_company_credits cc JOIN trailer_renter_companies c ON c.id=cc.company_id ORDER BY cc.created_at DESC`,
    overpayments:`SELECT c.display_name company,cc.original_amount excess,cc.remaining_amount unapplied,cc.created_at FROM trailer_company_credits cc JOIN trailer_renter_companies c ON c.id=cc.company_id WHERE cc.source_payment_id IS NOT NULL ORDER BY cc.created_at DESC`,
    amendments:`SELECT a.agreement_number,am.amendment_number,am.amendment_type,am.effective_date,am.previous_amount,am.new_amount,am.reason FROM trailer_rental_amendments am JOIN trailer_rental_agreements a ON a.id=am.agreement_id ORDER BY am.created_at DESC`,
    unmatched_mentions:`SELECT raw_unit_number,normalized_unit_number,telegram_group_title,sender_name,detected_at,ai_confidence,extracted_action,review_status FROM trailer_unmatched_mentions WHERE review_status='pending' ORDER BY detected_at DESC`,
    pending_master_review:`SELECT unit_number,master_status,master_review_reason,source,created_at FROM trailers WHERE master_status='pending_master_review' ORDER BY created_at DESC`,
    archived_trailers:`SELECT unit_number,master_status,archived_at,master_review_reason FROM trailers WHERE master_status IN('archived','merged') ORDER BY archived_at DESC NULLS LAST`,
    active_agreements:`SELECT a.agreement_number,c.display_name company,a.status,a.pricing_mode,a.current_agreed_amount,(SELECT COUNT(*) FROM trailer_rental_items it WHERE it.agreement_id=a.id) items FROM trailer_rental_agreements a JOIN trailer_renter_companies c ON c.id=a.company_id WHERE a.status IN('active','partially_active','partially_returned','scheduled') ORDER BY a.created_at DESC`,
    missing_pickup_photos:`SELECT r.agreement_number,t.unit_number FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id WHERE r.status IN('active','returned') AND NOT EXISTS(SELECT 1 FROM trailer_media m WHERE m.rental_id=r.id AND m.media_type='pickup_condition_photo') ORDER BY r.start_at`,
    upcoming_pickups:`SELECT a.agreement_number,t.unit_number,c.display_name company,it.scheduled_pickup_at AS pickup_at,it.pickup_location FROM trailer_rental_items it JOIN trailer_rental_agreements a ON a.id=it.agreement_id JOIN trailers t ON t.id=it.trailer_id JOIN trailer_renter_companies c ON c.id=a.company_id WHERE it.item_status IN('scheduled','ready_for_pickup') AND it.scheduled_pickup_at>=NOW()-INTERVAL '1 day' ORDER BY it.scheduled_pickup_at`,
    missing_return_inspections:`SELECT a.agreement_number,t.unit_number,it.actual_return_at FROM trailer_rental_items it JOIN trailer_rental_agreements a ON a.id=it.agreement_id JOIN trailers t ON t.id=it.trailer_id WHERE it.item_status='returned' AND NOT EXISTS(SELECT 1 FROM trailer_inspections ins WHERE ins.rental_item_id=it.id AND ins.inspection_type='return' AND ins.completed) ORDER BY it.actual_return_at DESC NULLS LAST`,
    missing_return_photos:`SELECT a.agreement_number,t.unit_number,it.actual_return_at FROM trailer_rental_items it JOIN trailer_rental_agreements a ON a.id=it.agreement_id JOIN trailers t ON t.id=it.trailer_id WHERE it.item_status='returned' AND NOT EXISTS(SELECT 1 FROM trailer_media m WHERE m.rental_item_id=it.id AND m.media_type='return_condition_photo') ORDER BY it.actual_return_at DESC NULLS LAST`,
    damage_holds:`SELECT t.unit_number,cs.current_location_text,cs.last_event_at,COALESCE(c.display_name,ic.display_name) company FROM trailers t LEFT JOIN trailer_current_status cs ON cs.trailer_id=t.id LEFT JOIN trailer_rentals r ON r.trailer_id=t.id AND r.status='active' LEFT JOIN trailer_renter_companies c ON c.id=r.company_id LEFT JOIN LATERAL(SELECT * FROM trailer_rental_items x WHERE x.trailer_id=t.id AND x.item_status='active' LIMIT 1)it ON TRUE LEFT JOIN trailer_rental_agreements ia ON ia.id=it.agreement_id LEFT JOIN trailer_renter_companies ic ON ic.id=ia.company_id WHERE t.physical_status='held_damage' AND t.active ORDER BY t.unit_number`,
    failed_notifications:`SELECT j.job_type,j.entity_type,j.entity_id,j.attempts,j.last_error,j.created_at FROM trailer_notification_jobs j WHERE j.status='failed' ORDER BY j.created_at DESC`,
    missing_trailer_locations:`SELECT t.unit_number,t.physical_status,cs.last_event_at FROM trailers t LEFT JOIN trailer_current_status cs ON cs.trailer_id=t.id WHERE t.active AND t.master_status='active' AND (cs.current_lat IS NULL OR cs.current_lng IS NULL) ORDER BY t.unit_number`,
    storage_usage:`SELECT m.media_type,m.storage_backend,COUNT(*)::int files,COALESCE(SUM(m.original_size_bytes),0)::bigint total_bytes FROM trailer_media m GROUP BY m.media_type,m.storage_backend ORDER BY total_bytes DESC`,
  };
  if(!reports[name])throw Object.assign(new Error('Unknown report.'),{status:404});

  // Apply the optional filters the route forwards from req.query. A report is
  // filtered only on columns it actually exposes (below); reports without a
  // matching column are returned unfiltered rather than erroring. Everything is
  // parameterized — no filter value is interpolated into SQL.
  const filterable = REPORT_FILTERS[name];
  if (filterable && hasAnyFilter(filters)) {
    return (await query(...applyReportFilters(reports[name], filterable, filters))).rows;
  }
  return (await query(reports[name])).rows;
}

// Which PROJECTED columns each report exposes for filtering (the wrapper filters
// on the report's output columns, so these are the SELECT aliases, not the inner
// table columns). A report absent here is returned unfiltered.
const REPORT_FILTERS = {
  active_rentals: { date: 'start_at', company: 'company' },
  overdue_returns: { date: 'expected_return_at', company: 'company' },
  missing_receipts: { date: 'payment_at' },
  partial_payments: { company: 'company' },
  aging: { date: 'due_at', company: 'company' },
  company_credits: { date: 'created_at', company: 'company' },
  overpayments: { date: 'created_at', company: 'company' },
  amendments: { date: 'effective_date' },
  active_agreements: { company: 'company' },
  upcoming_pickups: { date: 'pickup_at', company: 'company' },
  missing_return_inspections: { date: 'actual_return_at' },
  missing_return_photos: { date: 'actual_return_at' },
  damage_holds: { company: 'company' },
  failed_notifications: { date: 'created_at' },
};

function hasAnyFilter(filters = {}) {
  return ['start', 'end', 'company'].some((k) => filters[k] != null && filters[k] !== '');
}

/**
 * Wrap a report query as an outer SELECT with a parameterized WHERE on its
 * PROJECTED columns, so filters apply regardless of the inner query's
 * GROUP BY / HAVING / ORDER BY, and the inner ordering is preserved. Returns
 * [text, values] for query(). No filter value is interpolated into SQL.
 */
function applyReportFilters(sql, cols, filters) {
  const conds = [];
  const values = [];
  if (cols.date && filters.start) { values.push(filters.start); conds.push(`r.${cols.date} >= $${values.length}`); }
  if (cols.date && filters.end) { values.push(filters.end); conds.push(`r.${cols.date} <= $${values.length}`); }
  if (cols.company && filters.company) { values.push(String(filters.company)); conds.push(`r.${cols.company} = $${values.length}`); }
  if (!conds.length) return [sql];
  return [`SELECT * FROM (${sql}) r WHERE ${conds.join(' AND ')}`, values];
}

module.exports={getTrailerDashboard,getTrailerReport,getPeriodUtilization};
