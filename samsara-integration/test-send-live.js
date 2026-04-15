/**
 * test-send-live.js (Final Fix Version)
 * Scans Samsara for real events from today and sends them to Telegram
 * AS ACTUAL VIDEO ATTACHMENTS (not links).
 */

const TelegramBot = require('node-telegram-bot-api');
const { formatAlert } = require('./src/formatter');

// Credentials
const SAMSARA_API_KEY = 'samsara_api_vpdJovy2R4npF71d7hN4upXdtErSIY';
const TELEGRAM_BOT_TOKEN = '7955098141:AAHf1AX-McadL2qRr4sKlVrnkdliEnmbzGo';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

async function downloadVideo(videoUrl) {
    const response = await fetch(videoUrl, { 
        headers: { 'Authorization': `Bearer ${SAMSARA_API_KEY}` } 
    });
    if (!response.ok) throw new Error(`Video download failed: ${response.status}`);
    const ab = await response.arrayBuffer();
    return Buffer.from(ab);
}

function transformApiEventToWebhookShape(event) {
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

    const loc = event.location || null;
    if (loc?.latitude != null) {
        const addr = loc.address;
        const formatted = addr ? [addr.streetAddress || addr.street, addr.city, addr.state].filter(Boolean).join(', ') : null;
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
    const params = new URLSearchParams({
        startTime,
        endTime: new Date().toISOString(),
        queryByTimeField: 'createdAtTime',
        includeAsset: 'true',
        includeDriver: 'true',
        includeVgOnlyEvents: 'true',
    });
    const url = `https://api.samsara.com/safety-events/stream?${params}`;
    
    const apiRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SAMSARA_API_KEY}`, 'Accept': 'application/json' }
    });
    if (!apiRes.ok) throw new Error(`API error ${apiRes.status}`);
    const json = await apiRes.json();
    return json.data || [];
}

console.log("Connecting to Telegram...");
bot.deleteWebHook();

bot.onText(/\/(start|test|ping)/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const events = await fetchRealEvents();
        if (events.length === 0) {
            bot.sendMessage(chatId, "❌ No real events found in last 4 hours.");
            return;
        }

        bot.sendMessage(chatId, `Found ${events.length} events. Attaching videos now...`);

        for (const event of events) {
            const mappedPayload = transformApiEventToWebhookShape(event);
            const result = formatAlert(mappedPayload);

            if (result.videoUrl) {
                console.log("Downloading video...");
                const videoBuffer = await downloadVideo(result.videoUrl);
                await bot.sendVideo(chatId, videoBuffer, {
                    caption: result.text,
                    parse_mode: 'HTML'
                }, {
                    filename: 'event.mp4',
                    contentType: 'video/mp4'
                });
            } else {
                await bot.sendMessage(chatId, result.text, { parse_mode: 'HTML', disable_web_page_preview: true });
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        console.log("Done.");
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
});
