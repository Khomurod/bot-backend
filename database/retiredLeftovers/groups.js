'use strict';

/**
 * Which tables each removed feature left behind — the ONLY names
 * `database/retiredLeftovers.js` can ever drop. Data, no I/O.
 *
 * Kept in its own file so the list can grow with each retirement without
 * pushing the module that acts on it past the 500-line limit.
 *
 * A TABLE IN THIS LIST MUST NOT BE CREATED BY THE BOOT BASELINE, or a drop
 * would not stay done (`tests/retiredLeftovers.test.js` enforces it). The one
 * allowed exception is a stub created ONLY on a brand-new database, before any
 * migration has run, so that an old migration which still alters the table can
 * run there — see `database/baseline/010_dispatch_teams.sql`, 014 and 019.
 */

/**
 * Every table a removed feature left behind, grouped by the feature that
 * created it. ONLY these names can ever be dropped through this module.
 */
const RETIRED_GROUPS = Object.freeze({
  trailer: Object.freeze({
    label: 'Trailer Department and Trailer Tracking',
    removedAt: '2026-09',
    note: 'Rental agreements, inspections, invoices, payments and the trailer '
      + 'master list. Dropping these permanently destroys rental and payment history.',
    tables: Object.freeze([
      'trailer_aliases',
      'trailer_audit_log',
      'trailer_company_credit_applications',
      'trailer_company_credits',
      'trailer_current_status',
      'trailer_events',
      'trailer_import_batches',
      'trailer_import_rows',
      'trailer_inspections',
      'trailer_invoice_adjustments',
      'trailer_invoice_lines',
      'trailer_invoices',
      'trailer_master_reconciliation_log',
      'trailer_media',
      'trailer_media_blobs',
      'trailer_notification_jobs',
      'trailer_payment_reversals',
      'trailer_payments',
      'trailer_pending_instructions',
      'trailer_reminder_history',
      'trailer_rental_agreements',
      'trailer_rental_amendments',
      'trailer_rental_items',
      'trailer_rental_movements',
      'trailer_rentals',
      'trailer_renter_companies',
      'trailer_settings',
      'trailer_unmatched_mentions',
      'trailers',
    ]),
  }),
  qbq_sos: Object.freeze({
    label: 'QBQ / SOS assessment and presentation',
    removedAt: '2026-09',
    note: 'Questionnaire submissions, answers and the saved presentation edits.',
    tables: Object.freeze([
      'sos_answers',
      'sos_submissions',
      'sos_settings',
      'qbq_presentation_edits',
    ]),
  }),
  fleetview: Object.freeze({
    label: 'FleetView Operations Platform',
    removedAt: '2026-07',
    note: 'Created lazily at runtime by code that no longer exists, so these '
      + 'were never part of the baseline schema and nothing has written to them since.',
    tables: Object.freeze([
      'fleet_audit_log',
      'fleet_settings',
      'fleet_snapshots',
      'fleet_sync_log',
      'fleet_sync_runs',
      'fleet_task_activity',
      'fleet_task_comments',
      'fleet_tasks',
      'fleet_unit_snapshots',
    ]),
  }),
  route_control: Object.freeze({
    label: 'Route Control',
    removedAt: '2026-10',
    note: 'Assigned routes, their screenshots and the off-route monitor log, plus the '
      + 'Google Maps settings row. Dropping these permanently destroys route history.',
    tables: Object.freeze([
      'route_monitor_events',
      'route_assignment_attachments',
      'route_assignments',
      'gmaps_settings',
    ]),
  }),
  driver_raise: Object.freeze({
    label: 'Driver raise review and dispatch teams',
    removedAt: '2026-10',
    note: 'Raise rounds, the teams\' submissions and picks, one-time codes, raise '
      + 'settings, and the dispatch teams with their drivers and members. Dropping '
      + 'these permanently destroys who was proposed for which raise.',
    tables: Object.freeze([
      'raise_otp',
      'raise_round_picks',
      'raise_round_submissions',
      'raise_rounds',
      'raise_settings',
      'dispatch_team_drivers',
      'dispatch_team_members',
      'dispatch_teams',
    ]),
  }),
  bol_pod: Object.freeze({
    label: 'BOL/POD document forwarding',
    removedAt: '2026-10',
    note: 'The record of every Datatruck document forwarded to a group, the '
      + 'forwarding settings, and the older test-monitor settings row.',
    tables: Object.freeze([
      'datatruck_document_deliveries',
      'bol_pod_forwarding_settings',
      'bol_pod_monitor_settings',
    ]),
  }),
  fuel: Object.freeze({
    label: 'Fuel stop reminders, fuel risk watch and Fuel Monitor',
    removedAt: '2026-10',
    note: 'Fuel-stop alerts, the Fuel Monitor inbox and stored truck fuel readings. '
      + 'Dropping these permanently destroys fuel-stop history.',
    tables: Object.freeze([
      'fuel_monitor_inbox',
      'fuel_stop_alerts',
      'truck_fuel_readings',
    ]),
  }),
  dispatch_eta: Object.freeze({
    label: 'Dispatcher ETA updates and pinned-load reading',
    removedAt: '2026-10',
    note: 'Per-group ETA schedules and their cached load context, the global ETA '
      + 'intervals, the stored recent loads and the pinned-message snapshots. '
      + 'Loads are read from the Dispatcher Board and Datatruck now.',
    tables: Object.freeze([
      'dispatch_eta_updates',
      'dispatch_eta_global_settings',
      'group_recent_loads',
      'group_pinned_messages',
    ]),
  }),
  earlier: Object.freeze({
    label: 'Earlier retired features',
    removedAt: 'various',
    note: 'The driver check-in/check-out monitor and the employee voting polls. '
      + 'Listed for completeness — review before selecting.',
    tables: Object.freeze([
      'driver_location_checkins',
      'driver_location_monitors',
      'employee_votes',
      'employee_votes_options',
      'employee_votes_polls',
    ]),
  }),
});

module.exports = { RETIRED_GROUPS };
