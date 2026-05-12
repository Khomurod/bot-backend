/**
 * index.js
 * Entry point for the Samsara Telegram Bot (Polling Architecture).
 *
 * Credentials are loaded from environment variables.
 * Keep secrets out of source files and store them in your secret manager.
 */

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const poller = require('./src/poller');
const store = require('./src/store');
const { determineTargetGroup } = require('./src/routing');
const {
    feedbackBotToken: HARDCODED_FEEDBACK_BOT_TOKEN,
    samsaraBotToken: HARDCODED_SAMSARA_BOT_TOKEN,
} = require('../config/telegramBotTokens');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || HARDCODED_SAMSARA_BOT_TOKEN;
const PORT = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10);
const MAX_VIDEO_BYTES = parseInt(process.env.SAMSARA_MAX_VIDEO_BYTES || '0', 10);
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true'; // For Telegram itself, if hosted
const PUBLIC_URL = (process.env.PUBLIC_WEBHOOK_URL || '').replace(/\/$/, '');
const SELF_URL = process.env.RENDER_EXTERNAL_URL || PUBLIC_URL;

// Prevent a nightmare dual-polling configuration: if this process were
// started with the same BOT_TOKEN as the main Telegraf bot, both would
// race for getUpdates(), constantly stealing the long-poll from each
// other. Fail fast and loud so the operator sees it on first boot.
const resolvedMainBotToken = process.env.BOT_TOKEN || HARDCODED_FEEDBACK_BOT_TOKEN;
if (resolvedMainBotToken === TOKEN) {
    throw new Error(
        '[Samsara] Samsara TELEGRAM_BOT_TOKEN equals the main feedback BOT_TOKEN. ' +
        'This would cause getUpdates() polling conflicts. Use distinct bots.',
    );
}

// ── Express App (Health checks & optionally Telegram Webhook only) ────────────
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// ── Broadcast helper ──────────────────────────────────────────────────────────
const { parseTrustedVideoUrl } = require('./src/videoUrl');

async function downloadVideo(videoUrl) {
    // Before touching the network, parse the URL and enforce an allow-list
    // of Samsara/CloudFront hostnames. Previously we did a substring check
    // which was spoofable (e.g. https://evil.test/?x=api.samsara.com).
    const parsed = parseTrustedVideoUrl(videoUrl);
    const host = parsed.hostname.toLowerCase();

    const fetchHeaders = {};
    const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
    // Samsara media URLs are pre-signed CloudFront CDN URLs that embed auth in query params
    // (Signature=, Key-Pair-Id=, Expires=). Adding an Authorization header to a pre-signed
    // URL causes CloudFront/S3 to return HTTP 400 "conflicting auth methods".
    // Only add the header for direct Samsara REST API endpoints.
    const isPreSigned = /[?&](Signature|X-Amz-Signature|AWSAccessKeyId|Key-Pair-Id)=/i.test(parsed.search);
    if (SAMSARA_API_KEY && !isPreSigned && host === 'api.samsara.com') {
        fetchHeaders['Authorization'] = `Bearer ${SAMSARA_API_KEY}`;
    }
    const response = await fetch(parsed.toString(), { headers: fetchHeaders });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (MAX_VIDEO_BYTES > 0 && Number.isFinite(contentLength) && contentLength > 0 && contentLength > MAX_VIDEO_BYTES) {
        throw new Error(`Video exceeds max size (${contentLength} bytes > ${MAX_VIDEO_BYTES} bytes)`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
        console.warn(`[Bot] Unexpected content-type "${contentType}" — may not be a direct video link`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (MAX_VIDEO_BYTES > 0 && buffer.length > MAX_VIDEO_BYTES) {
        throw new Error(`Video exceeds max size after download (${buffer.length} bytes > ${MAX_VIDEO_BYTES} bytes)`);
    }
    console.log(`[Bot] Downloaded ${(buffer.length / 1024).toFixed(1)} KB from ${videoUrl}`);
    return buffer;
}

// Ensure the queue in poller.js knows how to send messages
async function broadcast(alertData) {
    const videoCache = new Map();
    const getVideoBuffer = async (url) => {
        if (!url) return null;
        if (!videoCache.has(url)) {
            const promise = downloadVideo(url).catch((err) => {
                videoCache.delete(url);
                throw err;
            });
            videoCache.set(url, promise);
        }
        return videoCache.get(url);
    };

    const subscribers = await store.getAll();
    
    // Always include the hardcoded group ID for "Samsara Notifications"
    const forcedId = process.env.HARDCODED_GROUP_ID || "-5192934125";
    if (!subscribers.map(String).includes(String(forcedId))) {
        subscribers.push(String(forcedId));
    }

    if (subscribers.length === 0 && !process.env.EMPLOYEE_GROUP_ID) {
        console.warn('[Bot] No subscribers to broadcast to.');
        return;
    }

    const text         = typeof alertData === 'string' ? alertData : alertData.text;
    const videoUrl     = typeof alertData === 'string' ? null : alertData.videoUrl;
    const inwardVideoUrl = typeof alertData === 'string' ? null : alertData.inwardVideoUrl;

    console.log(`[Bot] Broadcasting to ${subscribers.length} subscriber(s)...`);

    // 1. Broadcast to dedicated Samsara bot subscribers
    for (const chatId of subscribers) {
        try {
            // Dual camera
            if (videoUrl && inwardVideoUrl) {
                console.log(`[Bot] Dual camera detected — sending media group to ${chatId}`);
                try {
                    const [forwardBuf, inwardBuf] = await Promise.all([
                        getVideoBuffer(videoUrl),
                        getVideoBuffer(inwardVideoUrl),
                    ]);

                    await bot.sendMediaGroup(chatId, [
                        { type: 'video', media: 'attach://forward', caption: text, parse_mode: 'HTML' },
                        { type: 'video', media: 'attach://inward' },
                    ], {}, {
                        forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                        inward:  { value: inwardBuf,  options: { filename: 'inward.mp4',  contentType: 'video/mp4' } },
                    });
                    console.log(`[Bot] Successfully sent dual-camera media group to ${chatId}`);
                    continue;
                } catch (dualErr) {
                    console.error(`[Bot] Dual camera send failed — trying single video fallback:`, dualErr.message);
                }
            }

            // Single camera
            if (videoUrl) {
                console.log(`[Bot] Fetching single video for ${chatId} from: ${videoUrl}`);
                try {
                    const buffer = await getVideoBuffer(videoUrl);
                    await bot.sendVideo(chatId, buffer, {
                        caption:    text,
                        parse_mode: 'HTML',
                    }, {
                        filename:    'event.mp4',
                        contentType: 'video/mp4',
                    });
                    console.log(`[Bot] Successfully sent video to ${chatId}`);
                    continue;
                } catch (videoErr) {
                    console.error(`[Bot] Video send failed — falling back to text:`, videoErr.message);
                }
            }

            // Text fallback
            await bot.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            console.log(`[Bot] Successfully sent text alert to ${chatId}`);

        } catch (err) {
            console.error(`[Bot] Failed to send to ${chatId}:`, err.message);
            if (err.response?.body?.error_code === 403) {
                console.log(`[Bot] Removing blocked user ${chatId}`);
                store.remove(chatId);
            }
        }
    }

    // 2. Forward to the specific Driver Group via main bot (@wenzefeedback_bot)
    const MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || process.env.EMPLOYEE_GROUP_ID;
    const target = await determineTargetGroup(
        typeof alertData === 'string' ? {} : alertData,
        store.findGroupByUnit.bind(store),
        MANAGEMENT_GROUP_ID
    );
    const targetDriverGroupId = target.targetGroupId;
    if (target.matchReason.startsWith('fallback')) {
        console.warn(`[Bot] Unmapped vehicle ${target.vehicleId || 'unknown'} unit ${target.unitNumber || 'unknown'} — routing to management group`);
    } else {
        console.log(`[Bot] Routed vehicle ${target.vehicleId || 'unknown'} unit ${target.unitNumber} to ${target.groupName || targetDriverGroupId} (${targetDriverGroupId}) via ${target.matchReason}`);
    }

    if (targetDriverGroupId && driverBot) {
        console.log(`[Bot] Forwarding alert for Unit #${target.unitNumber || 'unknown'} to group ${targetDriverGroupId}...`);
        try {
            // Dual camera support for Driver Group
            if (videoUrl && inwardVideoUrl) {
                const [forwardBuf, inwardBuf] = await Promise.all([
                    getVideoBuffer(videoUrl),
                    getVideoBuffer(inwardVideoUrl),
                ]);

                await driverBot.sendMediaGroup(targetDriverGroupId, [
                    { type: 'video', media: 'attach://forward', caption: text, parse_mode: 'HTML' },
                    { type: 'video', media: 'attach://inward' },
                ], {}, {
                    forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                    inward:  { value: inwardBuf,  options: { filename: 'inward.mp4',  contentType: 'video/mp4' } },
                });
            } else if (videoUrl) {
                const buffer = await getVideoBuffer(videoUrl);
                await driverBot.sendVideo(targetDriverGroupId, buffer, {
                    caption: text,
                    parse_mode: 'HTML',
                });
            } else {
                await driverBot.sendMessage(targetDriverGroupId, text, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
            }
            console.log(`[Bot] Successfully forwarded to Driver Group ${targetDriverGroupId}`);
        } catch (err) {
            console.error(`[Bot] Forwarding failed to ${targetDriverGroupId}:`, err.message);
        }
    }

    videoCache.clear();
}


// ── Telegram Bot Setup ────────────────────────────────────────────────────────
let bot;
let driverBot;

if (USE_WEBHOOK) {
    bot = new TelegramBot(TOKEN, { polling: false });
    const telegramWebhookPath = `/telegram-webhook/${TOKEN}`;
    app.post(telegramWebhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
} else {
    bot = new TelegramBot(TOKEN, { polling: true });
}

// Initialize Driver Bot (Main / feedback bot token — send-only)
const MAIN_BOT_TOKEN = resolvedMainBotToken;
if (MAIN_BOT_TOKEN) {
    console.log('[Bot] Initializing driverBot with main BOT_TOKEN');
    driverBot = new TelegramBot(MAIN_BOT_TOKEN, { polling: false });
}

poller.setBroadcastFn(broadcast);

// ── Bot Commands ──────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'there';
    const added = await store.add(chatId);
    bot.sendMessage(chatId,
        added
            ? `✅ *Welcome, ${firstName}!*\n\nYou are now subscribed to *Samsara fleet alerts*.\nWhenever an alert fires, I'll send it here instantly.\n\nUse /help to see all commands.`
            : `👋 Hey ${firstName}! You're already subscribed.\nUse /help to see all commands.`,
        { parse_mode: 'Markdown' }
    );
    console.log(`[Bot] /start from chatId=${chatId} (${msg.from?.username || 'unknown'})`);
});

bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    const removed = await store.remove(chatId);
    bot.sendMessage(chatId,
        removed
            ? `🔕 *You have been unsubscribed.*\n\nSend /start at any time to re-subscribe.`
            : `ℹ️ You are not currently subscribed.\nSend /start to subscribe.`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const subscribed = store.has(chatId);
    bot.sendMessage(chatId,
        subscribed
            ? `✅ *You are subscribed* to Samsara alerts.\n_Total subscribers: ${store.count()}_`
            : `🔕 *You are not subscribed.*\nSend /start to subscribe.\n_Total subscribers: ${store.count()}_`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🤖 *Samsara Alert Bot — Commands*\n\n` +
        `/start — Subscribe to Samsara alerts\n` +
        `/stop — Unsubscribe from alerts\n` +
        `/status — Check your subscription status\n` +
        `/help — Show this help message`,
        { parse_mode: 'Markdown' }
    );
});

// ── Start Server ──────────────────────────────────────────────────────────────
async function start() {
    await store.init();
    const samsaraDb = require('./src/db');
    await samsaraDb.initPgDb();
    await new Promise((resolve) => app.listen(PORT, resolve));

    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║      Samsara → Telegram Bot (Polling Mode)   ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`✅ Express server listening on port ${PORT} (Health checks)`);
    console.log(`👥 Subscribers loaded: ${store.count()}`);

    if (USE_WEBHOOK && SELF_URL) {
        const telegramWebhookUrl = `${SELF_URL}/telegram-webhook/${TOKEN}`;
        try {
            await bot.setWebHook(telegramWebhookUrl);
            console.log(`✅ Telegram webhook set: ${telegramWebhookUrl}`);
        } catch (err) {
            console.error('[Bot] Failed to set Telegram webhook:', err.message);
        }
        console.log(`✅ Telegram bot is online (webhook mode)`);

        // Keep-alive
        const https = require('https');
        const http = require('http');
        setInterval(() => {
            const url = `${SELF_URL}/health`;
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                console.log(`[KeepAlive] Pinged ${url} → ${res.statusCode}`);
            }).on('error', (err) => {
                console.warn(`[KeepAlive] Ping failed: ${err.message}`);
            });
        }, 14 * 60 * 1000);

    } else {
        console.log(`✅ Telegram bot is online (long-polling mode)`);
    }

    console.log('');
    console.log('🤖 Bot is ready! Send /start to @wenzesambot on Telegram');
    console.log('');

    // Start polling the Samsara API every 15 seconds
    poller.start(15000);
}

start().catch((err) => {
    console.error('[App] Fatal startup error:', err.message);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n[App] Shutting down...');
    poller.stop();
    if (!USE_WEBHOOK) bot.stopPolling();
    process.exit(0);
});
process.on('uncaughtException', (err) => console.error('[App] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[App] Rejection:', reason));
