'use strict';

/**
 * Every background worker whose silence would matter, in one list. PURE.
 *
 * WHY A LIST AT ALL. Self-healing used to watch THREE things — recruiter
 * logins, AI providers and the notification queue — while twenty-five workers
 * ran unobserved beside them. A worker cannot be missed unless something knows
 * it should be there, and no amount of reading tables supplies that: a pass
 * that finds nothing writes nothing, so "never armed" and "nothing to do" are
 * the same empty result. This list is the expectation those results are
 * compared against.
 *
 * `expectedIntervalSeconds` is what makes staleness decidable. For a worker
 * whose cadence is configurable (Datatruck documents, Route Control) it is the
 * SLOWEST reasonable setting, because calling a correctly-configured slow
 * worker "stopped" is the way this stops being read.
 *
 * `configurable: true` marks a worker that legitimately does nothing until an
 * operator supplies something — a Telegram destination, an API key, a
 * recruiter's login. Those report `blocked` with the missing thing named, never
 * `failed`, because painting an unconfigured feature red is how a real outage
 * gets lost among things that were never switched on.
 *
 * `critical: true` is the set self-healing announces about. The rest are
 * recorded and visible on /api/health but do not raise anything by themselves —
 * a birthday greeting that missed a tick is not an operational incident.
 */

const CATALOG = Object.freeze([
  // ── the integrations the fleet depends on ──────────────────────────────────
  { key: 'samsara_safety_pipeline', label: 'Samsara safety events reaching Wenze', group: 'integration', expectedIntervalSeconds: 3600, critical: true },
  { key: 'eld_location_freshness', label: 'truck locations and fuel from the ELDs', group: 'integration', expectedIntervalSeconds: 3600, critical: true },
  { key: 'datatruck_documents', label: 'Datatruck document sync', group: 'integration', expectedIntervalSeconds: 3600, critical: true, configurable: true },
  { key: 'recruiter_logins', label: "recruiters' RingCentral logins", group: 'integration', expectedIntervalSeconds: 86400 * 2, critical: true, configurable: true },
  { key: 'ai_providers', label: 'the AI providers', group: 'integration', expectedIntervalSeconds: 86400 * 2, critical: true, configurable: true },
  { key: 'telegram_delivery', label: 'sending messages through Telegram', group: 'integration', expectedIntervalSeconds: 3600, critical: true },
  { key: 'leads_bot', label: 'the leads bot', group: 'integration', expectedIntervalSeconds: 3600, critical: false, configurable: true },

  // ── the queues ─────────────────────────────────────────────────────────────
  // TWO ENTRIES, ONE SUBJECT, AND THEY ANSWER DIFFERENT QUESTIONS. The drain
  // is a worker: did the timer fire. The queue is an integration: has
  // anything GIVEN UP undelivered — the failure that silences every other
  // feature's alarm. A single key would have made one of the two invisible,
  // and `notifications` keeps its name because `system_health_states` in
  // production already holds its announcement history under it.
  { key: 'notification_drain', label: 'the notification queue drain', group: 'queue', expectedIntervalSeconds: 1800, critical: true },
  { key: 'notifications', label: 'the notification queue', group: 'integration', expectedIntervalSeconds: 1800, critical: true },
  { key: 'facebook_webhooks', label: 'Facebook lead processing', group: 'queue', expectedIntervalSeconds: 3600, critical: true, configurable: true },
  { key: 'home_time_reminders', label: 'Home Time reminders and staff alerts', group: 'queue', expectedIntervalSeconds: 300, critical: true },

  // ── the operational engines ────────────────────────────────────────────────
  { key: 'consistency_sweep', label: 'the consistency sweep', group: 'engine', expectedIntervalSeconds: 900, critical: true },
  { key: 'self_healing', label: 'the self-healing watch', group: 'engine', expectedIntervalSeconds: 1800, critical: true },
  { key: 'learning_pass', label: 'learning from corrections', group: 'engine', expectedIntervalSeconds: 43200, critical: false },
  { key: 'load_lifecycle', label: 'the load lifecycle watch', group: 'engine', expectedIntervalSeconds: 600, critical: true },
  { key: 'fuel_risk', label: 'the fuel risk watch', group: 'engine', expectedIntervalSeconds: 1200, critical: true },
  { key: 'fuel_stop_alerts', label: 'fuel stop reminders', group: 'engine', expectedIntervalSeconds: 150, critical: true },
  { key: 'safety_coach', label: 'the safety coach', group: 'engine', expectedIntervalSeconds: 21600, critical: true },
  { key: 'retention_watch', label: 'driver retention', group: 'engine', expectedIntervalSeconds: 14400, critical: true },
  { key: 'return_to_road', label: 'Home Time return-to-road detection', group: 'engine', expectedIntervalSeconds: 720, critical: true },
  { key: 'route_control', label: 'route monitoring', group: 'engine', expectedIntervalSeconds: 1800, critical: true, configurable: true },
  { key: 'duplicate_unit_scan', label: 'the duplicate-unit scan', group: 'engine', expectedIntervalSeconds: 900, critical: true },
  { key: 'recruiter_call_sync', label: 'recruiter call history', group: 'engine', expectedIntervalSeconds: 3600, critical: false, configurable: true },
  { key: 'ai_policy_watcher', label: "the AI providers' terms watcher", group: 'engine', expectedIntervalSeconds: 86400 * 5, critical: false, configurable: true },
  { key: 'ai_model_maintenance', label: 'AI model maintenance', group: 'engine', expectedIntervalSeconds: 86400 * 2, critical: false, configurable: true },

  // ── the routine work ───────────────────────────────────────────────────────
  { key: 'scheduler', label: 'scheduled messages', group: 'routine', expectedIntervalSeconds: 300, critical: true },
  { key: 'dispatch_eta', label: 'dispatch ETA updates', group: 'routine', expectedIntervalSeconds: 600, critical: false },
  { key: 'group_status_ai', label: 'driver-group status classification', group: 'routine', expectedIntervalSeconds: 3600, critical: false },
  { key: 'road_bonus_notifier', label: 'road bonus announcements', group: 'routine', expectedIntervalSeconds: 3600, critical: false },
  { key: 'mileage_bonus', label: 'the weekly mileage bonus', group: 'routine', expectedIntervalSeconds: 86400 * 9, critical: false },
  { key: 'raise_approval', label: 'raise approvals', group: 'routine', expectedIntervalSeconds: 86400 * 2, critical: false },
]);

const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));

function getServiceEntry(key) {
  return BY_KEY.get(String(key || '')) || null;
}

function listCriticalServices() {
  return CATALOG.filter((e) => e.critical);
}

/** A label an operator recognises, falling back to the key rather than nothing. */
function serviceLabel(key) {
  return getServiceEntry(key)?.label || String(key || 'unknown');
}

module.exports = { CATALOG, getServiceEntry, listCriticalServices, serviceLabel };
