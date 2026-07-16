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
  const utilization=Number(a.total_active)?Math.round((Number(r.active_rentals)/Number(a.total_active))*10000)/100:0;
  return{assets:a,rentals:r,finance:f,utilization_percent:utilization,revenue_by_trailer:revenueTrailer.rows,revenue_by_company:revenueCompany.rows,filters:{start,end}};
}

async function getTrailerReport(name){
  const reports={
    active_rentals:`SELECT r.agreement_number,t.unit_number,c.display_name company,r.start_at,r.expected_return_at,r.status FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id JOIN trailer_renter_companies c ON c.id=r.company_id WHERE r.status='active' ORDER BY r.expected_return_at`,
    overdue_returns:`SELECT r.agreement_number,t.unit_number,c.display_name company,r.expected_return_at,NOW()-r.expected_return_at overdue_for FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id JOIN trailer_renter_companies c ON c.id=r.company_id WHERE r.status='active' AND r.expected_return_at<NOW() ORDER BY r.expected_return_at`,
    missing_inspections:`SELECT r.agreement_number,t.unit_number,r.status FROM trailer_rentals r JOIN trailers t ON t.id=r.trailer_id LEFT JOIN trailer_inspections i ON i.rental_id=r.id WHERE r.status IN('active','returned') GROUP BY r.id,t.unit_number HAVING COUNT(i.id) FILTER(WHERE i.completed)=0`,
    missing_receipts:`SELECT p.receipt_number,i.invoice_number,p.amount,p.payment_at FROM trailer_payments p JOIN trailer_invoices i ON i.id=p.invoice_id WHERE p.receipt_media_id IS NULL`,
    partial_payments:`SELECT i.invoice_number,c.display_name company,i.total_amount,COALESCE(SUM(p.amount),0) paid,i.total_amount-COALESCE(SUM(p.amount),0) outstanding FROM trailer_invoices i JOIN trailer_renter_companies c ON c.id=i.company_id LEFT JOIN trailer_payments p ON p.invoice_id=i.id AND p.verification_status IN('recorded','verified') GROUP BY i.id,c.display_name HAVING SUM(p.amount)>0 AND SUM(p.amount)<i.total_amount`,
    aging:`SELECT i.invoice_number,c.display_name company,i.due_at,i.total_amount-COALESCE(p.total_paid,0) outstanding,CASE WHEN NOW()-i.due_at<INTERVAL '8 days' THEN '1-7' WHEN NOW()-i.due_at<INTERVAL '31 days' THEN '8-30' WHEN NOW()-i.due_at<INTERVAL '61 days' THEN '31-60' ELSE '61+' END aging_bucket FROM trailer_invoices i JOIN trailer_renter_companies c ON c.id=i.company_id LEFT JOIN LATERAL(SELECT SUM(amount) total_paid FROM trailer_payments WHERE invoice_id=i.id AND verification_status IN('recorded','verified'))p ON TRUE WHERE i.due_at<NOW() AND i.status NOT IN('paid','voided','disputed')`,
  };
  if(!reports[name])throw Object.assign(new Error('Unknown report.'),{status:404});
  return(await query(reports[name])).rows;
}

module.exports={getTrailerDashboard,getTrailerReport};
