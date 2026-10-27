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
  startMileageBonusService,
  stopMileageBonusService,
} = require('./mileageBonusService');
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
  startBoardPresenceWatch,
  stopBoardPresenceWatch,
} = require('./homeTime/boardPresenceWatch');
const { startViolationAlerts, stopViolationAlerts } = require('./homeTime/violationAlerts');
const { startMetaCrmStageSync, stopMetaCrmStageSync } = require('./metaCrm/stageSync');
const {
  startLoadLifecycleWatch,
  stopLoadLifecycleWatch,
} = require('./loads/lifecycleWatch');
const {
  startSafetyCoach,
  stopSafetyCoach,
} = require('./safety/coach');
const {
  startRetentionWatch,
  stopRetentionWatch,
} = require('./retention/watch');
const { startChatAnnotator, stopChatAnnotator } = require('./retention/chatAnnotator');
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
  startDuplicateUnitCheckService,
  stopDuplicateUnitCheckService,
} = require('./duplicateUnitCheckService');
const {
  startConsistencyService,
  stopConsistencyService,
} = require('./operations/consistencyService');
const {
  startDispatchBoardPoller,
  stopDispatchBoardPoller,
} = require('./dispatchBoard/poller');
const { reconcileTitles } = require('./driverGroupTitleSync');
const {
  startSafetyApprovalWorker,
  stopSafetyApprovalWorker,
} = require('./safetyApprovals/worker');
const {
  startHiringStageWorker,
  stopHiringStageWorker,
} = require('./hiringStages/worker');
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
const { startTelegramDestinationProbe, stopTelegramDestinationProbe } = require('./telegramDestinationProbe');
const { setProfileSavedHook } = require('../database/driverProfiles');
const {
  launchUnlessPaused,
  scheduleEconomyEnd,
  cancelEconomyEnd,
  notePausedServices,
  describeEconomyAtBoot,
} = require('./operations/economy');

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
  // ECONOMY MODE (services/operations/economy.js). While ECONOMY_MODE_UNTIL is a
  // date in the future, a service whose every pass is on the owner's pause list
  // is not started here at all — `launchUnlessPaused` holds it and starts it
  // when the date passes. Services that share a timer with work that must keep
  // running are started normally; their paused passes are refused inside
  // `withRunRecord`. Unset, the wrapper is a plain call.
  const economyLine = describeEconomyAtBoot();
  if (economyLine) console.log(economyLine);

  // Which Telegram client each service posts through, decided here rather than
  // reached for. Facebook leads use the leads bot, which is a DIFFERENT token
  // from the main bot's, posting into a different group, and mixing them up
  // sends a candidate's SMS into a driver chat.
  // eslint-disable-next-line global-require
  const { getLeadsTelegram } = require('./leadsTelegramClient');
  configureFacebookLeadTelegram(getLeadsTelegram());
  console.log('[BOOT] Facebook lead Telegram delivery uses TELEGRAM_BOT_TOKEN (WenzeLeadBots).');

  startScheduler();
  startBirthdayService();
  startEmployeeBirthdayWishService();
  launchUnlessPaused(['group_status_ai'], () => startGroupStatusAiService());
  startMileageBonusService();
  startRecruiterCallSyncService();
  startRingCentralTokenRefreshService();
  startRoadBonusNotifierService(telegram);
  startHomeTimeReminderService(telegram);
  // Notices when a driver who is home goes back to work — a Datatruck load plus
  // the truck's own movement, never one of them alone.
  startReturnToRoadWatch();
  // The other half of the same question: WHEN A DRIVER GOES HOME. Dispatch
  // records it on the board because they work from it, so Wenze reads it there
  // rather than waiting for somebody to type a date.
  startBoardPresenceWatch(telegram);
  // Bitrix pipeline 33 → accounting: the thirty-minute pass under the robot's
  // webhook. Idle until switched on with a group (Home Time → Settings).
  startViolationAlerts(telegram);
  // Bitrix hiring stages → Meta's Conversions API for CRM, so Facebook ad
  // delivery learns which leads become drivers. Idle (`blocked`) until a
  // dataset id and token are saved in Settings → Facebook ↔ Bitrix (or set as
  // META_CRM_* env fallbacks), or while that page's switch is off.
  startMetaCrmStageSync();
  // Works out what each load is actually doing from where the truck is, because
  // a board status is a plan and is routinely days out of date.
  launchUnlessPaused(['load_lifecycle'], () => startLoadLifecycleWatch());
  // Reads safety events as a PATTERN rather than one incident at a time, and
  // says one useful thing to a driver who has a habit. Whether to speak is
  // arithmetic; a model only words the sentence.
  launchUnlessPaused(['safety_coach'], () => startSafetyCoach());
  // Reads what the COMPANY has done to a driver — a home window promised and
  // missed, a bonus earned and unpaid, weeks past the allowance — plus what the
  // driver said in their own words, and says so while somebody can still act.
  // Operations chat only, never the driver's; no employment decision, ever.
  launchUnlessPaused(['retention_watch'], () => startRetentionWatch());
  // Classifies the driver messages recorded since the owner switched capture
  // on (2026-10-06): saying they are leaving, complaints, sentiment. Bounded
  // per pass; reports `blocked` while capture is off.
  launchUnlessPaused(['chat_annotation'], () => startChatAnnotator());
  // Notices when a part of Wenze breaks, and when it puts itself right. It adds
  // no recovery — every recovery it reports already ran silently. A blip that
  // self-corrects produces NO message; only a real outage and its recovery do.
  launchUnlessPaused(['self_healing'], () => startSelfHealingWatch());
  // Notices that Wenze has been corrected the same way three times and proposes
  // something about it. Proposes only: nothing here changes a rule, and a
  // suggestion sits at 'proposed' until an administrator agrees.
  launchUnlessPaused(['learning_pass'], () => startLearningPass());
  // Put the AI responsibilities catalogue into the database, so Settings → AI
  // has something to show and an administrator has something to switch off.
  // Descriptive columns only — a capability switched off stays off.
  registerKnownCapabilities().catch((err) => {
    console.warn('[AI CAPABILITIES] registration pass failed:', err.message);
  });
  launchUnlessPaused(['duplicate_unit_scan'], () => startDuplicateUnitCheckService());
  // Runs beside the duplicate-unit scan, whose three report types it generalises;
  // that service keeps running until its checks are folded in.
  startConsistencyService();
  // Reads the Dispatcher Board into a snapshot and stops there. It decides
  // nothing and sends nothing: its one reader is the home-time watch above,
  // which has its own evidence rules. Does nothing at all until an
  // administrator saves an address and a token in Settings.
  startDispatchBoardPoller();
  // Reads Safety's replies in the recruiting group and posts each decision in
  // the approvals topic. `blocked` until Safety Approvals is switched on.
  startSafetyApprovalWorker({ telegram: telegram || null });
  // Once per start: every driver profile up to what its chat title says
  // ("( COMPANY )", "INACTIVE"). Renames after this are followed as they
  // happen (bot/handlers/groupCaptureHandlers.js).
  setTimeout(() => { reconcileTitles().catch(() => {}); }, 90_000).unref?.();
  // Reads candidate conversations in the same group's General topic and
  // proposes Bitrix deal stages there. `blocked` until its switch is on.
  startHiringStageWorker({ telegram: telegram || null });
  // A saved driver profile keeps the person layer current (unit change,
  // Telegram id). Registered here so database/ never depends upward.
  setProfileSavedHook(onProfileSaved);
  launchUnlessPaused(['ai_policy_watcher'], () => startPolicyWatcher({ telegram: telegram || null }));
  // A Telegram group upgraded to a supergroup gets a new id and every send to
  // the old one fails. This asks about each configured destination and follows
  // a move before a notice has to fail on it.
  startTelegramDestinationProbe({ telegram: telegram || null });
  // Daily model refresh, plus a debounced look whenever the router is refused a
  // model. Its Telegram lines ride the policy watcher's outbox above.
  launchUnlessPaused(['ai_model_maintenance'], () => startModelMaintenance({ setModelRefusalListener }));

  // Whatever was held starts when the date passes; until then the ledger says
  // "paused until …" for each paused pass rather than going quiet.
  scheduleEconomyEnd();
  notePausedServices().catch((err) => {
    console.warn('[ECONOMY] could not record the paused services:', err.message);
  });
}

/** Stop everything, one at a time, never letting one failure stop the rest. */
function stopBackgroundServices() {
  try { cancelEconomyEnd(); } catch (err) { console.error('[SHUTDOWN] cancelEconomyEnd failed:', err.message); }
  try { stopScheduler(); } catch (err) { console.error('[SHUTDOWN] stopScheduler failed:', err.message); }
  try { stopBirthdayService(); } catch (err) { console.error('[SHUTDOWN] stopBirthdayService failed:', err.message); }
  try { stopEmployeeBirthdayWishService(); } catch (err) { console.error('[SHUTDOWN] stopEmployeeBirthdayWishService failed:', err.message); }
  try { stopGroupStatusAiService(); } catch (err) { console.error('[SHUTDOWN] stopGroupStatusAiService failed:', err.message); }
  try { stopMileageBonusService(); } catch (err) { console.error('[SHUTDOWN] stopMileageBonusService failed:', err.message); }
  try { stopRecruiterCallSyncService(); } catch (err) { console.error('[SHUTDOWN] stopRecruiterCallSyncService failed:', err.message); }
  try { stopRingCentralTokenRefreshService(); } catch (err) { console.error('[SHUTDOWN] stopRingCentralTokenRefreshService failed:', err.message); }
  try { stopRoadBonusNotifierService(); } catch (err) { console.error('[SHUTDOWN] stopRoadBonusNotifierService failed:', err.message); }
  try { stopHomeTimeReminderService(); } catch (err) { console.error('[SHUTDOWN] stopHomeTimeReminderService failed:', err.message); }
  try { stopReturnToRoadWatch(); } catch (err) { console.error('[SHUTDOWN] stopReturnToRoadWatch failed:', err.message); }
  try { stopBoardPresenceWatch(); } catch (err) { console.error('[SHUTDOWN] stopBoardPresenceWatch failed:', err.message); }
  try { stopViolationAlerts(); } catch (err) { console.error('[SHUTDOWN] stopViolationAlerts failed:', err.message); }
  try { stopMetaCrmStageSync(); } catch (err) { console.error('[SHUTDOWN] stopMetaCrmStageSync failed:', err.message); }
  try { stopLoadLifecycleWatch(); } catch (err) { console.error('[SHUTDOWN] stopLoadLifecycleWatch failed:', err.message); }
  try { stopSafetyCoach(); } catch (err) { console.error('[SHUTDOWN] stopSafetyCoach failed:', err.message); }
  try { stopRetentionWatch(); } catch (err) { console.error('[SHUTDOWN] stopRetentionWatch failed:', err.message); }
  try { stopChatAnnotator(); } catch (err) { console.error('[SHUTDOWN] stopChatAnnotator failed:', err.message); }
  try { stopSelfHealingWatch(); } catch (err) { console.error('[SHUTDOWN] stopSelfHealingWatch failed:', err.message); }
  try { stopLearningPass(); } catch (err) { console.error('[SHUTDOWN] stopLearningPass failed:', err.message); }
  try { stopDuplicateUnitCheckService(); } catch (err) { console.error('[SHUTDOWN] stopDuplicateUnitCheckService failed:', err.message); }
  try { stopConsistencyService(); } catch (err) { console.error('[SHUTDOWN] stopConsistencyService failed:', err.message); }
  try { stopDispatchBoardPoller(); } catch (err) { console.error('[SHUTDOWN] stopDispatchBoardPoller failed:', err.message); }
  try { stopSafetyApprovalWorker(); } catch (err) { console.error('[SHUTDOWN] stopSafetyApprovalWorker failed:', err.message); }
  try { stopHiringStageWorker(); } catch (err) { console.error('[SHUTDOWN] stopHiringStageWorker failed:', err.message); }
  try { stopPolicyWatcher(); } catch (err) { console.error('[SHUTDOWN] stopPolicyWatcher failed:', err.message); }
  try { stopModelMaintenance(); } catch (err) { console.error('[SHUTDOWN] stopModelMaintenance failed:', err.message); }
  try { stopTelegramDestinationProbe(); } catch (err) { console.error('[SHUTDOWN] stopTelegramDestinationProbe failed:', err.message); }
}

module.exports = { startBackgroundServices, stopBackgroundServices };
