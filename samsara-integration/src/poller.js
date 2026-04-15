/**
 * poller.js
 * Polls the Samsara API for new safety events using cursor-based pagination.
 * Ensures that no events are dropped even if the server restarts.
 * Sends raw events to the formatter and pushes them to a local queue.
 */

const { getCursor, saveCursor, resetCursorCache } = require('./db');
const { formatAlert } = require('./formatter');

const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
const FETCH_TIMEOUT_MS = 12000;
const SAFETY_EVENTS_STREAM_URL = 'https://api.samsara.com/safety-events/stream';
const BOOTSTRAP_LOOKBACK_MS = Math.max(
    15 * 60 * 1000,
    parseInt(process.env.SAMSARA_BOOTSTRAP_LOOKBACK_MS || `${24 * 60 * 60 * 1000}`, 10)
);

// ── Rate-Limited Telegram Queue ─────────────────────────────────────────────
// Telegram has limits (usually ~30 msgs/sec globally, and ~20 msgs/min per group).
// To prevent hitting error 429 Too Many Requests, especially if the bot wakes up 
// after being asleep and pulls 50 events, we queue them.
const ALERT_QUEUE = [];
let isProcessingQueue = false;
let broadcastFn = null;

// Keep track of recently seen event IDs to prevent duplicates if the cursor
// hasn't updated yet or if we fall back to time-based polling.
const SEEN_IDS = new Set();
const MAX_SEEN_IDS = 1000;
let isPolling = false;
let intervalId = null;
let configuredIntervalMs = 15000;
let nextScheduledAt = null;

function isIsoTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Push formatted alerts into the queue to be sent.
 * @param {Object} formattedAlert 
 */
function queueAlert(formattedAlert) {
    if (!formattedAlert) return;
    ALERT_QUEUE.push(formattedAlert);
    if (!isProcessingQueue) {
        processQueue();
    }
}

/**
 * Process the queue sequentially with a delay between each message.
 */
async function processQueue() {
    if (ALERT_QUEUE.length === 0) {
        isProcessingQueue = false;
        return; // Done
    }
    
    isProcessingQueue = true;
    const alert = ALERT_QUEUE.shift(); // Get oldest
    
    if (broadcastFn) {
        try {
            await broadcastFn(alert);
        } catch (err) {
            console.error('[Queue] Error broadcasting alert:', err.message);
            // Optionally could re-queue here if we wanted strict delivery on Telegram failure
            // but we usually discard so we don't get stuck in an endless error loop.
        }
    } else {
        console.warn('[Queue] No broadcastFn set. Dropping alert.');
    }
    
    // Wait 2000ms before sending the next one (Rate Limiting)
    setTimeout(processQueue, 2000);
}


// ── Reverse Geocoding (free, no API key) ──────────────────────────────────────
// When Samsara doesn't provide an address object, resolve lat/lon to "City, State"
// using OpenStreetMap's Nominatim service.
async function reverseGeocode(lat, lon) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'SamsaraTelegramBot/1.0' },
        });
        if (!response.ok) return null;
        const data = await response.json();
        const city = data.address?.city || data.address?.town || data.address?.village || data.address?.county || '';
        const state = data.address?.state || '';
        if (city || state) {
            return [city, state].filter(Boolean).join(', ');
        }
        return null;
    } catch (err) {
        console.warn('[Poller] Reverse geocode failed:', err.message);
        return null;
    }
}

// ── Transformation / Formatting ───────────────────────────────────────────────
// Move the formatting logic previously locked inside the webhook express route
// directly into the poller.

/**
 * Re-formats the raw v2 API event into the shape the webhook formatter expects.
 * Adapts mergeEnrichedData from the old webhook.js into a direct transform.
 */
async function transformApiEventToWebhookShape(event) {
    // Mimic the webhook envelope
    const happenedAtTime = event.time || event.happenedAtTime || new Date().toISOString();
    
    // Robust Vehicle extraction
    const vehicleObj = event.asset || event.vehicle || {};
    const vehicleName = vehicleObj.name || 'Unknown Unit';
    const vehicleId   = vehicleObj.id   || null;

    const webhookPayload = {
        eventType: 'AlertIncident',
        eventTime: happenedAtTime,
        data: {
            happenedAtTime,
            incidentUrl: event.incidentUrl || null,
            conditions: [{
                description: 'A safety event occurred',
                details: {
                    harshEvent: {
                        vehicle: vehicleId ? { id: vehicleId, name: vehicleName } : undefined,
                    }
                }
            }]
        }
    };

    const condition = webhookPayload.data.conditions[0];
    const details = condition.details;

    // Specific event type
    const behaviorLabel =
        event.behaviorLabels?.[0]?.label ||
        event.behaviorLabel ||
        event.type ||
        event.safetyEventType ||
        null;
    if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

    // Videos
    // Samsara v2 API often has media[] array or downloadForwardVideoUrl
    const mediaItems = event.media || [];
    const forwardUrl = mediaItems.find(m => m.input === 'MEDIA_INPUT_PRIMARY' || m.input === 'dashcamRoadFacing')?.url
        || event.downloadForwardVideoUrl || event.mediaUrl || event.videoUrl || null;
    const inwardUrl  = mediaItems.find(m => m.input === 'MEDIA_INPUT_SECONDARY' || m.input === 'dashcamDriverFacing')?.url
        || event.downloadInwardVideoUrl || null;

    if (forwardUrl) {
        details.harshEvent.mediaUrl = forwardUrl;
        webhookPayload._enrichedVideoUrl = forwardUrl;
    }
    if (inwardUrl) {
        webhookPayload._enrichedVideoUrlInward = inwardUrl;
    }

    // Location
    const loc = event.location || null;
    if (loc?.latitude != null) {
        const addr = loc.address;
        let formatted = addr
            ? [addr.street || addr.streetAddress, addr.city, addr.state].filter(Boolean).join(', ')
            : null;
        // If Samsara didn't provide an address, reverse-geocode to get "City, State"
        if (!formatted) {
            formatted = await reverseGeocode(loc.latitude, loc.longitude);
        }
        details.harshEvent.location = {
            latitude: loc.latitude,
            longitude: loc.longitude,
            formattedLocation: formatted,
        };
    }

    // Speed — try multiple field locations across Samsara API versions
    let speedKph = event.speedingMetadata?.maxSpeedKilometersPerHour
        ?? event.speedKilometersPerHour
        ?? event.behaviorLabels?.[0]?.speedKilometersPerHour
        ?? null;
    let limitKph = event.speedingMetadata?.postedSpeedLimitKilometersPerHour
        ?? event.speedLimitKilometersPerHour
        ?? null;

    // If speed is not present, perform secondary lookup
    if (speedKph == null && vehicleId && happenedAtTime && SAMSARA_API_KEY) {
        try {
            const eventTimeMs = new Date(happenedAtTime).getTime();
            if (!isNaN(eventTimeMs)) {
                // Fetch window: +/- 10 seconds around the event
                const startTime = new Date(eventTimeMs - 10000).toISOString();
                const endTime = new Date(eventTimeMs + 10000).toISOString();

                const statsUrl = `https://api.samsara.com/fleet/vehicles/stats/history?startTime=${startTime}&endTime=${endTime}&vehicleIds=${vehicleId}&types=gps`;
                const statsResponse = await fetchWithTimeout(statsUrl, {
                    headers: {
                        'Authorization': `Bearer ${SAMSARA_API_KEY}`,
                        'Accept': 'application/json'
                    }
                }, 5000);

                if (statsResponse.ok) {
                    const statsJson = await statsResponse.json();
                    const gpsData = statsJson.data?.[0]?.gps;
                    if (gpsData && gpsData.length > 0) {
                        // Find the closest GPS reading to the event time
                        let closest = gpsData[0];
                        let minDiff = Math.abs(new Date(closest.time).getTime() - eventTimeMs);
                        for (let i = 1; i < gpsData.length; i++) {
                            const diff = Math.abs(new Date(gpsData[i].time).getTime() - eventTimeMs);
                            if (diff < minDiff) {
                                minDiff = diff;
                                closest = gpsData[i];
                            }
                        }
                        if (closest.speedMilesPerHour != null) {
                            speedKph = closest.speedMilesPerHour * 1.60934;
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`[Poller] Secondary speed lookup failed for vehicle ${vehicleId}:`, err.message);
        }
    }

    if (speedKph != null) {
        details.speed = {
            currentSpeedKilometersPerHour:   speedKph,
            thresholdSpeedKilometersPerHour: limitKph,
        };
    }

    // Severity — root-level first, then per-label field inside behaviorLabels
    const severityVal = event.severity || event.behaviorLabels?.[0]?.severity;
    if (severityVal) {
        if (!details.safetyEvent) details.safetyEvent = {};
        details.safetyEvent.severity = severityVal;
    }
    // behaviorLabels[0].type encodes severity in its name (e.g. "FollowingDistanceModerate");
    // store it so the formatter's keyword fallback can extract the severity level.
    const behaviorType = event.behaviorLabels?.[0]?.type;
    if (behaviorType) webhookPayload._enrichedBehaviorType = behaviorType;

    const gForce = event.maxAccelerationGForce ?? event.maxGForce ?? event.gForce ?? null;
    if (gForce != null) {
        details.harshEvent.gForce = gForce;
    }

    // Driver
    const driverObj = event.driver || {};
    if (driverObj.name) {
        details.harshEvent.driver = { name: driverObj.name, id: driverObj.id };
    }

    return webhookPayload;
}


// ── Samsara Poller Engine ─────────────────────────────────────────────────────

async function executePoll() {
    if (!SAMSARA_API_KEY) {
        console.warn('[Poller] SAMSARA_API_KEY is not set. Cannot poll.');
        return;
    }

    if (isPolling) {
        console.warn('[Poller] Previous poll still in flight; skipping this tick.');
        return;
    }

    isPolling = true;

    try {
        const cursor = getCursor();
        const params = new URLSearchParams({
            queryByTimeField: 'createdAtTime',
            includeAsset: 'true',
            includeDriver: 'true',
            includeVgOnlyEvents: 'true',
        });

        if (cursor) {
            // Detect whether the saved cursor is an ISO timestamp (our fallback)
            // or a real Samsara pagination token.
            if (isIsoTimestamp(cursor)) {
                params.set('startTime', cursor);
                console.log(`[Poller] Resuming from saved startTime cursor: ${cursor}`);
            } else {
                params.set('after', cursor);
                console.log('[Poller] Resuming from saved pagination cursor.');
            }
        } else {
            // Cold start. Use a configurable backfill window so deploys or restarts
            // don't miss older events when durable cursor storage is unavailable.
            const startTime = new Date(Date.now() - BOOTSTRAP_LOOKBACK_MS).toISOString();
            params.set('startTime', startTime);
            console.log(`[Poller] No cursor found; bootstrapping from ${startTime}`);
        }

        // Bound each poll window explicitly so the request returns promptly
        // and we keep full control over the 15-second cadence.
        const endTime = new Date().toISOString();
        params.set('endTime', endTime);

        const url = `${SAFETY_EVENTS_STREAM_URL}?${params.toString()}`;
        const response = await fetchWithTimeout(url, {
            headers: {
                'Authorization': `Bearer ${SAMSARA_API_KEY}`,
                'Accept': 'application/json',
            },
        }, FETCH_TIMEOUT_MS);

        if (!response.ok) {
            const body = await response.text();
            console.error(`[Poller] HTTP ${response.status}: ${body}`);
            return;
        }

        const json = await response.json();
        const events = json.data || [];
        const nextCursor = json.pagination?.endCursor;

        if (events.length > 0) {
            let newEventsCount = 0;
            for (const rawEvent of events) {
                // Deduplication check
                if (SEEN_IDS.has(rawEvent.id)) continue;
                
                SEEN_IDS.add(rawEvent.id);
                if (SEEN_IDS.size > MAX_SEEN_IDS) {
                    const firstId = SEEN_IDS.values().next().value;
                    SEEN_IDS.delete(firstId);
                }

                newEventsCount++;
                const mappedPayload = await transformApiEventToWebhookShape(rawEvent);
                const formattedMessage = formatAlert(mappedPayload);
                queueAlert(formattedMessage);
            }
            
            if (newEventsCount > 0) {
                console.log(`[Poller] Picked up ${newEventsCount} new event(s).`);
            }
        } else {
            console.log('[Poller] No new events returned by Samsara.');
        }

        // Save cursor for next run. Prefer the real API cursor; fall back to
        // saving endTime so the polling window slides forward even when the
        // API returns no events and no endCursor.
        const cursorToSave = nextCursor || endTime;
        const previousCursor = cursor;
        if (nextCursor) {
            await saveCursor(nextCursor);
            console.log('[Poller] Saved pagination cursor from Samsara response.');
        } else {
            await saveCursor(endTime);
            console.log(`[Poller] No pagination cursor returned; saved fallback time cursor ${endTime}`);
        }

        const savedCursor = getCursor();
        if (savedCursor !== cursorToSave) {
            console.error('[Poller] Cursor verification failed after save; resetting cache so the next poll reloads from disk.');
            resetCursorCache();
        } else if (!previousCursor && savedCursor) {
            console.log('[Poller] Cursor bootstrap completed successfully.');
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Poller] Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
        } else {
            console.error('[Poller] Fetch error:', err.message);
        }
    } finally {
        isPolling = false;
    }
}

// ── Exported API ──────────────────────────────────────────────────────────────

function scheduleNextTick() {
    if (intervalId || nextScheduledAt == null) return;

    const delay = Math.max(0, nextScheduledAt - Date.now());
    intervalId = setTimeout(async () => {
        intervalId = null;
        await executePoll();

        if (nextScheduledAt == null) return;

        // Preserve the intended cadence instead of drifting by poll duration.
        nextScheduledAt += configuredIntervalMs;
        while (nextScheduledAt <= Date.now()) {
            nextScheduledAt += configuredIntervalMs;
        }
        scheduleNextTick();
    }, delay);
}

module.exports = { transformApiEventToWebhookShape,
    /**
     * Set the function that actually sends the message via the Telegram Bot.
     * @param {Function} fn 
     */
    setBroadcastFn(fn) {
        broadcastFn = fn;
    },

    /**
     * Start the interval loop.
     * @param {number} intervalMs - Milliseconds between API polls (default 15000).
     */
    start(intervalMs = 15000) {
        if (intervalId || nextScheduledAt != null) return; // Already running
        configuredIntervalMs = intervalMs;

        console.log(`[Poller] Started API polling loop (every ${intervalMs}ms)`);

        // Execute immediately, then keep future polls aligned to the requested cadence.
        nextScheduledAt = Date.now() + configuredIntervalMs;
        executePoll().finally(() => {
            if (nextScheduledAt != null) {
                scheduleNextTick();
            }
        });
    },

    /**
     * Stop polling gracefully.
     */
    stop() {
        if (intervalId) {
            clearTimeout(intervalId);
            intervalId = null;
        }
        nextScheduledAt = null;
        console.log('[Poller] Stopped API polling loop.');
    }
};
