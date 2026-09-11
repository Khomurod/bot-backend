'use strict';

/**
 * Every background service this application runs, started and stopped in one
 * place.
 *
 * Split out of index.js when that file passed the 500-line limit. It is a
 * ROSTER, not a framework: no registry, no lifecycle abstraction, no plugin
 * loader. Two functions and a list of calls, in the order they have always
 * been made, so that "what runs in the background" is answerable by reading
 * one screen instead of grepping a boot file for `start`.
 *
 * The comments beside each call are the point of the file. Several of these
 * services can send a message to a driver or spend money, and the sentence
 * saying which is the thing somebody needs before they reorder anything here.
 *
 * WHAT STAYED IN index.js, and why: the bot, the HTTP server, the database, the
 * leads child process and the memory watchdog. Those are the process itself —
 * they decide whether there is an application at all, and the ordering around
 * them (database before anything, bot before the services that post through it)
 * is boot sequencing rather than a roster.
 *
 * A failure to STOP is logged and swallowed, one service at a time. A shutdown
 * that aborts halfway leaves the rest running and the process wedged, which is
 * worse than a stop that did not work.
 */
const { startScheduler, stopScheduler } = require('./schedulerService');
const { startBirthdayService, stopBirthdayService } = require('./birthdayService');
const {
  startGroupStatusAiService,
  stopGroupStatusAiService,
} = require('./groupStatusAiService');
const {
  startEmployeeBirthdayWishService,
  stopEmployeeBirthdayWishService,
} = require('./employeeBirthdayWishService');
const {
  configureFacebookLeadTelegram,
  startFacebookWebhookWorker,
  stopFacebookWebhookWorker,
} = require('./facebookWebhookService');
const {
  configureDispatchEtaTelegram,
  startDispatchEtaScheduler,
  stopDispatchEtaScheduler,
} = require('./dispatchEtaUpdateService');
const {
  startMileageBonusService,
  stopMileageBonusService,
} = require('./mileageBonusService');
const {
  startDatatruckDocumentService,
  stopDatatruckDocumentService,
} = require('./datatruckDocumentService');
const {
  startRaiseApprovalService,
  stopRaiseApprovalService,
} = require('./raiseApprovalService');
const {
  startFuelStopAlertService,
  stopFuelStopAlertService,
} = require('./fuelStopAlertService');
const {
  startRecruiterCallSyncService,
  stopRecruiterCallSyncService,
} = require('./recruiterCallSyncService');
const {
  startRingCentralTokenRefreshService,
  stopRingCentralTokenRefreshService,
} = require('./ringCentralTokenRefreshService');
const {
  startRoadBonusNotifierService,
  stopRoadBonusNotifierService,
} = require('./roadBonusNotifierService');
const {
  startHomeTimeReminderService,
  stopHomeTimeReminderService,
} = require('./homeTimeReminderService');
const {
  startReturnToRoadWatch,
  stopReturnToRoadWatch,
} = require('./homeTime/returnToRoadWatch');
const {
  startLoadLifecycleWatch,
  stopLoadLifecycleWatch,
} = require('./loads/lifecycleWatch');
const {
  startFuelRiskWatch,
  stopFuelRiskWatch,
} = require('./fuelStop/riskWatch');
const {
  startSafetyCoach,
  stopSafetyCoach,
} = require('./safety/coach');
const {
  startRetentionWatch,
  stopRetentionWatch,
} = require('./retention/watch');
const {
  startSelfHealingWatch,
  stopSelfHealingWatch,
} = require('./operations/selfHealing');
const {
  startLearningPass,
  stopLearningPass,
} = require('./operations/learningPass');
const { registerKnownCapabilities } = require('./ai/capabilityRegistry');
const {
  startRouteControlService,
  stopRouteControlService,
} = require('./routeControlService');
const {
  startDuplicateUnitCheckService,
  stopDuplicateUnitCheckService,
} = require('./duplicateUnitCheckService');
const {
  startConsistencyService,
  stopConsistencyService,
} = require('./operations/consistencyService');
const {
  startPolicyWatcher,
  stopPolicyWatcher,
} = require('./ai/policy/policyService');
const {
  startModelMaintenance,
  stopModelMaintenance,
} = require('./ai/discovery/modelMaintenance');
const { setModelRefusalListener } = require('./ai/router');
const { onProfileSaved } = require('./identity/personResolver');
const { setProfileSavedHook } = require('../database/driverProfiles');

/**
 * Start everything.
 *
 * `telegram` is the only argument, and it is the main bot's client: the
 * services that post to driver groups take it explicitly rather than reaching
 * for a singleton, so a test can hand them a fake. Everything else this needs
 * is required above — the three wiring functions were briefly parameters as
 * well, which shadowed the imports of the same name and left two ways to say
 * the same thing with nothing to choose between them.
 */
function startBackgroundServices({ telegram }) {
  // Which Telegram client each service posts through, decided here rather than
  // reached for. Dispatch ETA uses the main bot; Facebook leads use the leads
  // bot, which is a DIFFERENT token posting into a different group, and mixing
  // them up sends a candidate's SMS into a driver chat.
  configureDispatchEtaTelegram(telegram);
  // eslint-disable-next-line global-require
  const { getLeadsTelegram } = require('./leadsTelegramClient');
  configureFacebookLeadTelegram(getLeadsTelegram());
  console.log('[BOOT] Facebook lead Telegram delivery uses TELEGRAM_BOT_TOKEN (WenzeLeadBots).');

  startScheduler();
  startDispatchEtaScheduler();
  startBirthdayService();
  startEmployeeBirthdayWishService();
  startGroupStatusAiService();
  startMileageBonusService();
  startDatatruckDocumentService();
  startRaiseApprovalService();
  startFuelStopAlertService(telegram);
  startRecruiterCallSyncService();
  startRingCentralTokenRefreshService();
  startRoadBonusNotifierService(telegram);
  startHomeTimeReminderService(telegram);
  // Notices when a driver who is home goes back to work — a Datatruck load plus
  // the truck's own movement, never one of them alone.
  startReturnToRoadWatch();
  // Works out what each load is actually doing from where the truck is, because
  // a board status is a plan and is routinely days out of date.
  startLoadLifecycleWatch();
  // Fuel RISK, beside the existing fuel-stop reminder: can the truck reach the
  // stop, did it go past, is the instruction from last trip. Reports to the
  // operations chat only while it is new — never to a driver.
  startFuelRiskWatch();
  // Reads safety events as a PATTERN rather than one incident at a time, and
  // says one useful thing to a driver who has a habit. Whether to speak is
  // arithmetic; a model only words the sentence.
  startSafetyCoach();
  // Reads what the COMPANY has done to a driver — a home window promised and
  // missed, a bonus earned and unpaid, weeks past the allowance — plus what the
  // driver said in their own words, and says so while somebody can still act.
  // Operations chat only, never the driver's; no employment decision, ever.
  startRetentionWatch();
  // Notices when a part of Wenze breaks, and when it puts itself right. It adds
  // no recovery — every recovery it reports already ran silently. A blip that
  // self-corrects produces NO message; only a real outage and its recovery do.
  startSelfHealingWatch();
  // Notices that Wenze has been corrected the same way three times and proposes
  // something about it. Proposes only: nothing here changes a rule, and a
  // suggestion sits at 'proposed' until an administrator agrees.
  startLearningPass();
  // Put the AI responsibilities catalogue into the database, so Settings → AI
  // has something to show and an administrator has something to switch off.
  // Descriptive columns only — a capability switched off stays off.
  registerKnownCapabilities().catch((err) => {
    console.warn('[AI CAPABILITIES] registration pass failed:', err.message);
  });
  startRouteControlService(telegram);
  startDuplicateUnitCheckService();
  // Runs beside the duplicate-unit scan, whose three report types it generalises;
  // that service keeps running until its checks are folded in.
  startConsistencyService();
  // A saved driver profile keeps the person layer current (unit change,
  // Telegram id). Registered here so database/ never depends upward.
  setProfileSavedHook(onProfileSaved);
  startPolicyWatcher({ telegram: telegram || null });
  // Daily model refresh, plus a debounced look whenever the router is refused a
  // model. Its Telegram lines ride the policy watcher's outbox above.
  startModelMaintenance({ setModelRefusalListener });
}

/** Stop everything, one at a time, never letting one failure stop the rest. */
function stopBackgroundServices() {
  try { stopScheduler(); } catch (err) { console.error('[SHUTDOWN] stopScheduler failed:', err.message); }
  try { stopDispatchEtaScheduler(); } catch (err) { console.error('[SHUTDOWN] stopDispatchEtaScheduler failed:', err.message); }
  try { stopBirthdayService(); } catch (err) { console.error('[SHUTDOWN] stopBirthdayService failed:', err.message); }
  try { stopEmployeeBirthdayWishService(); } catch (err) { console.error('[SHUTDOWN] stopEmployeeBirthdayWishService failed:', err.message); }
  try { stopGroupStatusAiService(); } catch (err) { console.error('[SHUTDOWN] stopGroupStatusAiService failed:', err.message); }
  try { stopMileageBonusService(); } catch (err) { console.error('[SHUTDOWN] stopMileageBonusService failed:', err.message); }
  try { stopDatatruckDocumentService(); } catch (err) { console.error('[SHUTDOWN] stopDatatruckDocumentService failed:', err.message); }
  try { stopRaiseApprovalService(); } catch (err) { console.error('[SHUTDOWN] stopRaiseApprovalService failed:', err.message); }
  try { stopFuelStopAlertService(); } catch (err) { console.error('[SHUTDOWN] stopFuelStopAlertService failed:', err.message); }
  try { stopRecruiterCallSyncService(); } catch (err) { console.error('[SHUTDOWN] stopRecruiterCallSyncService failed:', err.message); }
  try { stopRingCentralTokenRefreshService(); } catch (err) { console.error('[SHUTDOWN] stopRingCentralTokenRefreshService failed:', err.message); }
  try { stopRoadBonusNotifierService(); } catch (err) { console.error('[SHUTDOWN] stopRoadBonusNotifierService failed:', err.message); }
  try { stopHomeTimeReminderService(); } catch (err) { console.error('[SHUTDOWN] stopHomeTimeReminderService failed:', err.message); }
  try { stopReturnToRoadWatch(); } catch (err) { console.error('[SHUTDOWN] stopReturnToRoadWatch failed:', err.message); }
  try { stopLoadLifecycleWatch(); } catch (err) { console.error('[SHUTDOWN] stopLoadLifecycleWatch failed:', err.message); }
  try { stopFuelRiskWatch(); } catch (err) { console.error('[SHUTDOWN] stopFuelRiskWatch failed:', err.message); }
  try { stopSafetyCoach(); } catch (err) { console.error('[SHUTDOWN] stopSafetyCoach failed:', err.message); }
  try { stopRetentionWatch(); } catch (err) { console.error('[SHUTDOWN] stopRetentionWatch failed:', err.message); }
  try { stopSelfHealingWatch(); } catch (err) { console.error('[SHUTDOWN] stopSelfHealingWatch failed:', err.message); }
  try { stopLearningPass(); } catch (err) { console.error('[SHUTDOWN] stopLearningPass failed:', err.message); }
  try { stopRouteControlService(); } catch (err) { console.error('[SHUTDOWN] stopRouteControlService failed:', err.message); }
  try { stopDuplicateUnitCheckService(); } catch (err) { console.error('[SHUTDOWN] stopDuplicateUnitCheckService failed:', err.message); }
  try { stopConsistencyService(); } catch (err) { console.error('[SHUTDOWN] stopConsistencyService failed:', err.message); }
  try { stopPolicyWatcher(); } catch (err) { console.error('[SHUTDOWN] stopPolicyWatcher failed:', err.message); }
  try { stopModelMaintenance(); } catch (err) { console.error('[SHUTDOWN] stopModelMaintenance failed:', err.message); }
}

module.exports = { startBackgroundServices, stopBackgroundServices };
