/**
 * poller.js
 * Polls the Samsara API for new safety events using cursor-based pagination.
 * Ensures that no events are dropped even if the server restarts.
 * Sends raw events to the formatter and pushes them to a local queue.
 */

const { getCursor, saveCursor, clearCursor, isEventProcessed, markEventProcessed } = require('./db');
const { formatAlert } = require('./formatter');
const { reverseGeocode } = require('./geocoder');

const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;

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

function isIsoTimestamp(value) {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value);
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
        
        // Enrichment: If Samsara didn't provide an address, try reverse geocoding
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
    const speedKph = event.speedingMetadata?.maxSpeedKilometersPerHour
        ?? event.speedKilometersPerHour
        ?? event.behaviorLabels?.[0]?.speedKilometersPerHour
        ?? null;
    const limitKph = event.speedingMetadata?.postedSpeedLimitKilometersPerHour
        ?? event.speedLimitKilometersPerHour
        ?? null;
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

    const rawCursor = (getCursor() || '').trim();
    const cursor = isIsoTimestamp(rawCursor) ? '' : rawCursor;
    const params = new URLSearchParams({
        includeDriver: 'true',
    });

    // Mandatory: Samsara Safety Events endpoint REQUIRES startTime/endTime
    // Fetch last 30 mins as a fallback/window, even if using a cursor.
    const startTime = new Date(Date.now() - 1800000).toISOString();
    const endTime = new Date().toISOString();
    
    params.set('startTime', startTime);
    params.set('endTime', endTime);

    if (rawCursor && isIsoTimestamp(rawCursor)) {
        // Older builds accidentally persisted timestamp values instead of cursors.
        // Samsara rejects these as an invalid "after" pagination token.
        console.warn(`[Poller] Ignoring invalid timestamp cursor: ${rawCursor}`);
        clearCursor();
    }

    if (cursor && cursor !== 'null' && cursor !== 'undefined') {
        params.set('after', cursor);
        console.log(`[Poller] Requesting events since cursor: ${cursor}`);
    } else {
        console.log(`[Poller] No valid cursor found. Fetching fresh window from: ${startTime}`);
    }

    const url = `https://api.samsara.com/fleet/safety-events?${params.toString()}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${SAMSARA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            const body = await response.text();
            console.error(`[Poller] HTTP ${response.status}: ${body}`);
            if (response.status === 400 && body.includes(`invalid pagination 'after' parameter`)) {
                console.warn('[Poller] Clearing invalid cursor so next poll uses time window only.');
                clearCursor();
            }
            return;
        }

        const json = await response.json();
        const events = json.data || [];
        const nextCursor = json.pagination?.endCursor;

        if (events.length > 0) {
            let newEventsCount = 0;
            for (const rawEvent of events) {
                // In-memory Deduplication check
                if (SEEN_IDS.has(rawEvent.id)) continue;
                
                // Permanent PostgreSQL Deduplication check
                if (await isEventProcessed(rawEvent.id)) {
                    SEEN_IDS.add(rawEvent.id); // Add to memory to save DB calls next time
                    continue;
                }
                
                SEEN_IDS.add(rawEvent.id);
                await markEventProcessed(rawEvent.id);

                newEventsCount++;
                const mappedPayload = await transformApiEventToWebhookShape(rawEvent);
                const formattedMessage = formatAlert(mappedPayload);
                
                // Pass vehicle name for dynamic routing
                formattedMessage.vehicleName = rawEvent.vehicle?.name || rawEvent.asset?.name || '';
                
                queueAlert(formattedMessage);
            }
            
            if (newEventsCount > 0) {
                console.log(`[Poller] Picked up ${newEventsCount} new event(s).`);
            }
        } else {
            // Uncomment if you want noisy logs
            // console.log(`[Poller] No new events.`);
        }

        // Save the cursor for the next run, even if no events were found
        // Samsara provides a new timestamp cursor to prevent querying the same window.
        if (nextCursor) {
            saveCursor(nextCursor);
        }

    } catch (err) {
        console.error('[Poller] Fetch error:', err.message);
    }
}

// ── Exported API ──────────────────────────────────────────────────────────────

let intervalId = null;

module.exports = {
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
        if (intervalId) return; // Already running
        
        console.log(`[Poller] Started API polling loop (every ${intervalMs}ms)`);
        
        // Execute immediately, then set interval
        executePoll();
        intervalId = setInterval(executePoll, intervalMs);
    },

    /**
     * Stop polling gracefully.
     */
    stop() {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
            console.log('[Poller] Stopped API polling loop.');
        }
    }
};
