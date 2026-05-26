/**
 * Defer Telegram delivery when dashcam video is missing on first Samsara fetch,
 * then refetch once after a delay and queue the alert with video if available.
 */
const {
  fetchSafetyEventDetailFromApi,
  mergeSafetyEventDetail,
  extractVideoUrlsFromSafetyEvent,
} = require('./safetyEventMedia');

const DEFAULT_DELAY_MS = 90_000;
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 180_000;

function isVideoRetryEnabled() {
  return process.env.SAMSARA_VIDEO_RETRY_ENABLED !== 'false';
}

function getVideoRetryDelayMs() {
  const parsed = parseInt(process.env.SAMSARA_VIDEO_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, parsed));
}

function shouldDeferVideoRetry(formattedAlert, eventId) {
  if (!isVideoRetryEnabled()) return false;
  if (!eventId) return false;
  if (!formattedAlert || typeof formattedAlert !== 'object') return false;
  if (formattedAlert.videoUrl || formattedAlert.inwardVideoUrl) return false;
  return true;
}

function patchAlertVideoUrls(formattedAlert, urls) {
  if (!formattedAlert || !urls) return formattedAlert;
  if (urls.forwardUrl) formattedAlert.videoUrl = urls.forwardUrl;
  if (urls.inwardUrl) formattedAlert.inwardVideoUrl = urls.inwardUrl;
  return formattedAlert;
}

async function refetchVideoUrls(eventId, apiKey, baseUrl) {
  const detailed = await fetchSafetyEventDetailFromApi(eventId, apiKey, baseUrl);
  const merged = mergeSafetyEventDetail({ id: eventId }, detailed);
  return extractVideoUrlsFromSafetyEvent(merged);
}

function scheduleVideoRetryDelivery({
  formattedAlert,
  eventId,
  queueAlert,
  delayMs,
  apiKey,
  baseUrl,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  refetchFn,
}) {
  const waitMs = Number.isFinite(delayMs) ? delayMs : getVideoRetryDelayMs();
  console.log(`[VideoRetry] deferring event ${eventId} for ${Math.round(waitMs / 1000)}s`);

  const doRefetch = refetchFn
    || (() => refetchVideoUrls(eventId, apiKey, baseUrl));

  setTimer(async () => {
    try {
      const urls = await doRefetch();
      if (urls.forwardUrl || urls.inwardUrl) {
        patchAlertVideoUrls(formattedAlert, urls);
        console.log(`[VideoRetry] event ${eventId}: video found after retry`);
      } else {
        console.log(`[VideoRetry] event ${eventId}: no video after retry`);
      }
    } catch (err) {
      console.warn(`[VideoRetry] event ${eventId}: refetch failed:`, err.message);
    }
    queueAlert(formattedAlert);
  }, waitMs);
}

function enqueueFormattedAlert(formattedAlert, rawEvent, queueAlert, options = {}) {
  if (!formattedAlert) return;

  const eventId = rawEvent?.id || null;
  if (eventId) {
    formattedAlert.samsaraEventId = eventId;
  }

  const apiKey = options.apiKey ?? process.env.SAMSARA_API_KEY;
  const baseUrl = options.baseUrl ?? (process.env.SAMSARA_API_BASE || 'https://api.samsara.com');

  if (!shouldDeferVideoRetry(formattedAlert, eventId)) {
    queueAlert(formattedAlert);
    return;
  }

  scheduleVideoRetryDelivery({
    formattedAlert,
    eventId,
    queueAlert,
    delayMs: options.delayMs,
    apiKey,
    baseUrl,
    setTimer: options.setTimer,
    refetchFn: options.refetchFn,
  });
}

module.exports = {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  shouldDeferVideoRetry,
  patchAlertVideoUrls,
  refetchVideoUrls,
  scheduleVideoRetryDelivery,
  enqueueFormattedAlert,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
};
