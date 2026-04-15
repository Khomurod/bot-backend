/**
 * test-send-live.js (Final Fix Version)
 * Scans Samsara for real events from today and sends them to Telegram
 * AS ACTUAL VIDEO ATTACHMENTS (not links).
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { formatAlert } = require('./src/formatter');
const { reverseGeocode } = require('./src/geocoder');

// Credentials
const SAMSARA_API_KEY = 'samsara_api_vpdJovy2R4npF71d7hN4upXdtErSIY';
const TELEGRAM_BOT_TOKEN = '7955098141:AAHf1AX-McadL2qRr4sKlVrnkdliEnmbzGo';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Driver Bot (Optional for testing if environment variables missing)
const DRIVER_BOT_TOKEN = process.env.BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const driverBot = new TelegramBot(DRIVER_BOT_TOKEN, { polling: false });
const DRIVER_GROUP_ID = process.env.EMPLOYEE_GROUP_ID || null;

async function downloadVideo(videoUrl) {
    const response = await fetch(videoUrl, { 
        headers: { 'Authorization': `Bearer ${SAMSARA_API_KEY}` } 
    });
    if (!response.ok) throw new Error(`Video download failed: ${response.status}`);
    const ab = await response.arrayBuffer();
    return Buffer.from(ab);
}

async function transformApiEventToWebhookShape(event) {
    const happenedAtTime = event.time || new Date().toISOString();
    const vehicleObj = event.asset || event.vehicle || {};
    const vehicleName = vehicleObj.name || 'Unknown Unit';

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
                        vehicle: { id: vehicleObj.id || "", name: vehicleName },
                    }
                }
            }]
        }
    };

    const condition = webhookPayload.data.conditions[0];
    const details = condition.details;

    const behaviorLabel = event.behaviorLabels?.[0]?.label || event.safetyEventType || null;
    if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

    const mediaItems = event.media || [];
    const forwardUrl = mediaItems.find(m => m.input === 'MEDIA_INPUT_PRIMARY' || m.input === 'dashcamRoadFacing')?.url 
        || event.downloadForwardVideoUrl || event.mediaUrl || event.videoUrl || null;

    if (forwardUrl) {
        details.harshEvent.mediaUrl = forwardUrl;
        webhookPayload._enrichedVideoUrl = forwardUrl;
    }

    const inwardUrl = mediaItems.find(m => m.input === 'MEDIA_INPUT_SECONDARY' || m.input === 'dashcamDriverFacing')?.url 
        || event.downloadInwardVideoUrl || null;
    if (inwardUrl) {
        webhookPayload._enrichedVideoUrlInward = inwardUrl;
    }

    const loc = event.location || null;
    if (loc?.latitude != null) {
        const addr = loc.address;
        let formatted = addr ? [addr.streetAddress || addr.street, addr.city, addr.state].filter(Boolean).join(', ') : null;
        
        // Enrichment: If Samsara didn't provide an address, try reverse geocoding
        if (!formatted) {
            formatted = await reverseGeocode(loc.latitude, loc.longitude);
        }
        
        details.harshEvent.location = { latitude: loc.latitude, longitude: loc.longitude, formattedLocation: formatted };
    }

    const speedKph = event.speedKilometersPerHour || event.speedingMetadata?.maxSpeedKilometersPerHour || null;
    if (speedKph != null) {
        details.speed = { currentSpeedKilometersPerHour: speedKph };
    }

    if (event.severity) details.safetyEvent = { severity: event.severity };
    
    const driverObj = event.driver || {};
    if (driverObj.name) {
        details.harshEvent.driver = { name: driverObj.name, id: driverObj.id };
    }

    return webhookPayload;
}

async function fetchRealEvents() {
    const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); 
    const params = new URLSearchParams({ startTime, endTime: new Date().toISOString(), includeDriver: 'true' });
    const url = `https://api.samsara.com/fleet/safety-events?${params}`;
    
    const apiRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SAMSARA_API_KEY}`, 'Accept': 'application/json' }
    });
    if (!apiRes.ok) throw new Error(`API error ${apiRes.status}`);
    const json = await apiRes.json();
    return json.data || [];
}

console.log("Connecting to Telegram...");
bot.deleteWebHook();

async function runTest() {
    const chatId = "-5192934125";
    console.log(`[Test] Sending live Samsara event to hardcoded group ID: ${chatId}`);
    try {
        const events = await fetchRealEvents();
        if (events.length === 0) {
            console.log("❌ No real events found in last 4 hours.");
            process.exit(0);
        }

        console.log(`[Test] Found ${events.length} event(s). Attaching video for the most recent one...`);

        // Just send the most recent one to keep the test clean
        const event = events[0];
        const mappedPayload = await transformApiEventToWebhookShape(event);
        const result = formatAlert(mappedPayload);

        if (result.videoUrl && result.inwardVideoUrl) {
            console.log("[Test] Dual camera detected — sending media group to Samsara Group...");
            const [fBuf, iBuf] = await Promise.all([
                downloadVideo(result.videoUrl),
                downloadVideo(result.inwardVideoUrl),
            ]);
            await bot.sendMediaGroup(chatId, [
                { type: 'video', media: 'attach://forward', caption: result.text, parse_mode: 'HTML' },
                { type: 'video', media: 'attach://inward' },
            ], {}, {
                forward: { value: fBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                inward:  { value: iBuf,  options: { filename: 'inward.mp4',  contentType: 'video/mp4' } },
            });
        } else if (result.videoUrl) {
            console.log("[Test] Downloading and sending single video to Samsara Group...");
            const videoBuffer = await downloadVideo(result.videoUrl);
            await bot.sendVideo(chatId, videoBuffer, {
                caption: result.text,
                parse_mode: 'HTML'
            }, {
                filename: 'event.mp4',
                contentType: 'video/mp4'
            });
        } else {
            console.log("[Test] No video available. Sending text only...");
            await bot.sendMessage(chatId, result.text, { 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }
        
        console.log("\n✅ LIVE TEST MESSAGE SENT TO SAMSARA GROUP!");

        // --- Driver Group Test ---
        if (DRIVER_GROUP_ID) {
            console.log(`[Test] Forwarding to Driver Group (${DRIVER_GROUP_ID}) via main bot...`);
            if (result.videoUrl && result.inwardVideoUrl) {
                const [fBuf, iBuf] = await Promise.all([
                    downloadVideo(result.videoUrl),
                    downloadVideo(result.inwardVideoUrl),
                ]);
                await driverBot.sendMediaGroup(DRIVER_GROUP_ID, [
                    { type: 'video', media: 'attach://forward', caption: result.text, parse_mode: 'HTML' },
                    { type: 'video', media: 'attach://inward' },
                ], {}, {
                    forward: { value: fBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                    inward:  { value: iBuf,  options: { filename: 'inward.mp4',  contentType: 'video/mp4' } },
                });
            } else if (result.videoUrl) {
                const videoBuffer = await downloadVideo(result.videoUrl);
                await driverBot.sendVideo(DRIVER_GROUP_ID, videoBuffer, {
                    caption: result.text,
                    parse_mode: 'HTML'
                });
            } else {
                await driverBot.sendMessage(DRIVER_GROUP_ID, result.text, { 
                    parse_mode: 'HTML', 
                    disable_web_page_preview: true 
                });
            }
            console.log("✅ LIVE TEST MESSAGE SENT TO DRIVER GROUP!");
        } else {
            console.log("⚠️ Skipping Driver Group test: EMPLOYEE_GROUP_ID not set in environment.");
        }
        
        process.exit(0);
    } catch (err) {
        console.error("❌ Test failed:", err.message);
        process.exit(1);
    }
}

console.log("Starting test-send-live execution...");
bot.deleteWebHook().then(() => {
    runTest();
});
