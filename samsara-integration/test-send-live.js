/**
 * test-send-live.js
 * Fetches the latest real Samsara safety event and sends it to:
 * 1) Samsara subscribers (plus HARDCODED_GROUP_ID)
 * 2) Resolved Driver Group by Unit (fallback EMPLOYEE_GROUP_ID)
 *
 * Usage:
 *   node test-send-live.js
 *   node test-send-live.js --dry-run
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { formatAlert } = require('./src/formatter');
const { reverseGeocode } = require('./src/geocoder');
const store = require('./src/store');

const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAIN_BOT_TOKEN = process.env.BOT_TOKEN;
const FORCED_GROUP_ID = process.env.HARDCODED_GROUP_ID || '-5192934125';
const FALLBACK_DRIVER_GROUP_ID = process.env.EMPLOYEE_GROUP_ID || null;
const DRY_RUN = process.argv.includes('--dry-run');
const deleteAfterArg = process.argv.find((arg) => arg.startsWith('--delete-after-sec='));
const DELETE_AFTER_SEC = deleteAfterArg ? parseInt(deleteAfterArg.split('=')[1], 10) : 0;

if (!SAMSARA_API_KEY) throw new Error('SAMSARA_API_KEY is not set');
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
if (!MAIN_BOT_TOKEN) throw new Error('BOT_TOKEN is not set');

async function transformApiEventToWebhookShape(event) {
  const happenedAtTime = event.time || event.happenedAtTime || new Date().toISOString();
  const vehicleObj = event.asset || event.vehicle || {};
  const vehicleName = vehicleObj.name || 'Unknown Unit';
  const vehicleId = vehicleObj.id || null;

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
          },
        },
      }],
    },
  };

  const details = webhookPayload.data.conditions[0].details;

  const behaviorLabel =
    event.behaviorLabels?.[0]?.label ||
    event.behaviorLabel ||
    event.type ||
    event.safetyEventType ||
    null;
  if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

  const mediaItems = event.media || [];
  const forwardUrl =
    mediaItems.find((m) => m.input === 'MEDIA_INPUT_PRIMARY' || m.input === 'dashcamRoadFacing')?.url ||
    event.downloadForwardVideoUrl ||
    event.mediaUrl ||
    event.videoUrl ||
    null;
  const inwardUrl =
    mediaItems.find((m) => m.input === 'MEDIA_INPUT_SECONDARY' || m.input === 'dashcamDriverFacing')?.url ||
    event.downloadInwardVideoUrl ||
    null;

  if (forwardUrl) {
    details.harshEvent.mediaUrl = forwardUrl;
    webhookPayload._enrichedVideoUrl = forwardUrl;
  }
  if (inwardUrl) {
    webhookPayload._enrichedVideoUrlInward = inwardUrl;
  }

  const loc = event.location || null;
  if (loc?.latitude != null) {
    const addr = loc.address;
    let formatted = addr
      ? [addr.street || addr.streetAddress, addr.city, addr.state].filter(Boolean).join(', ')
      : null;
    if (!formatted) {
      formatted = await reverseGeocode(loc.latitude, loc.longitude);
    }
    details.harshEvent.location = {
      latitude: loc.latitude,
      longitude: loc.longitude,
      formattedLocation: formatted,
    };
  }

  const speedKph =
    event.speedingMetadata?.maxSpeedKilometersPerHour ??
    event.speedKilometersPerHour ??
    event.behaviorLabels?.[0]?.speedKilometersPerHour ??
    null;
  const limitKph =
    event.speedingMetadata?.postedSpeedLimitKilometersPerHour ??
    event.speedLimitKilometersPerHour ??
    null;

  if (speedKph != null) {
    details.speed = {
      currentSpeedKilometersPerHour: speedKph,
      thresholdSpeedKilometersPerHour: limitKph,
    };
  }

  const severityVal = event.severity || event.behaviorLabels?.[0]?.severity;
  if (severityVal) {
    if (!details.safetyEvent) details.safetyEvent = {};
    details.safetyEvent.severity = severityVal;
  }

  const behaviorType = event.behaviorLabels?.[0]?.type;
  if (behaviorType) webhookPayload._enrichedBehaviorType = behaviorType;

  const gForce = event.maxAccelerationGForce ?? event.maxGForce ?? event.gForce ?? null;
  if (gForce != null) {
    details.harshEvent.gForce = gForce;
  }

  const driverObj = event.driver || {};
  if (driverObj.name) {
    details.harshEvent.driver = { name: driverObj.name, id: driverObj.id };
  }

  return webhookPayload;
}

async function fetchLatestEvent() {
  const params = new URLSearchParams({
    includeDriver: 'true',
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    endTime: new Date().toISOString(),
    limit: '1',
  });

  const url = `https://api.samsara.com/fleet/safety-events?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${SAMSARA_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Samsara API ${response.status}: ${body}`);
  }

  const json = await response.json();
  const event = (json.data || [])[0];
  if (!event) return null;
  return event;
}

function uniqueIds(ids) {
  return [...new Set(ids.map(String))];
}

async function downloadVideo(videoUrl) {
  const fetchHeaders = {};
  const isPreSigned = /[?&](Signature|X-Amz-Signature|AWSAccessKeyId|Key-Pair-Id)=/i.test(videoUrl);
  if (SAMSARA_API_KEY && !isPreSigned && videoUrl.includes('api.samsara.com')) {
    fetchHeaders.Authorization = `Bearer ${SAMSARA_API_KEY}`;
  }
  const response = await fetch(videoUrl, { headers: fetchHeaders });
  if (!response.ok) {
    throw new Error(`video download failed: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function sendToChats(bot, chatIds, text, videoUrl, inwardVideoUrl) {
  const sentMessages = [];
  for (const chatId of chatIds) {
    try {
      if (DRY_RUN) {
        console.log(`[DryRun] Would send to ${chatId} (video=${!!videoUrl}, inward=${!!inwardVideoUrl})`);
        continue;
      }

      // Match production behavior: media first, caption below media in Telegram.
      if (videoUrl && inwardVideoUrl) {
        const [forwardBuf, inwardBuf] = await Promise.all([
          downloadVideo(videoUrl),
          downloadVideo(inwardVideoUrl),
        ]);
        const mediaSent = await bot.sendMediaGroup(chatId, [
          { type: 'video', media: 'attach://forward', caption: text, parse_mode: 'HTML' },
          { type: 'video', media: 'attach://inward' },
        ], {}, {
          forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
          inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
        });
        sentMessages.push(...mediaSent.map((m) => ({ chatId: String(chatId), messageId: m.message_id })));
      } else if (videoUrl) {
        const buffer = await downloadVideo(videoUrl);
        const sent = await bot.sendVideo(chatId, buffer, {
          caption: text,
          parse_mode: 'HTML',
        }, {
          filename: 'event.mp4',
          contentType: 'video/mp4',
        });
        sentMessages.push({ chatId: String(chatId), messageId: sent.message_id });
      } else {
        const sent = await bot.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        sentMessages.push({ chatId: String(chatId), messageId: sent.message_id });
      }

      console.log(`[Test] Sent alert to ${chatId}`);
    } catch (err) {
      console.error(`[Test] Failed sending to ${chatId}: ${err.message}`);
    }
  }
  return sentMessages;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (DRY_RUN) {
    console.log('[Test] Running in dry-run mode. No Telegram messages will be sent.');
  }
  if (!DRY_RUN && DELETE_AFTER_SEC > 0) {
    console.log(`[Test] Auto-delete enabled (${DELETE_AFTER_SEC}s after send).`);
  }

  await store.init();

  const event = await fetchLatestEvent();
  if (!event) {
    console.log('[Test] No events found in the last 7 days.');
    return;
  }

  const mappedPayload = await transformApiEventToWebhookShape(event);
  const formatted = formatAlert(mappedPayload);
  const vehicleName = event.vehicle?.name || event.asset?.name || '';
  const unitMatch = vehicleName.match(/#\s*(\d+)/) || vehicleName.match(/^(\d+)/);
  const unitNumber = unitMatch ? unitMatch[1] : null;

  const subBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  const driverBot = new TelegramBot(MAIN_BOT_TOKEN, { polling: false });

  const subscribers = await store.getAll();
  const subscriberTargets = uniqueIds([...subscribers, FORCED_GROUP_ID]);
  console.log(`[Test] Subscriber targets: ${subscriberTargets.join(', ')}`);

  const sentBySubBot = await sendToChats(
    subBot,
    subscriberTargets,
    formatted.text,
    formatted.videoUrl || null,
    formatted.inwardVideoUrl || null
  );

  let driverGroupId = FALLBACK_DRIVER_GROUP_ID;
  if (unitNumber) {
    const resolved = await store.findGroupByUnit(unitNumber, vehicleName);
    if (resolved) driverGroupId = resolved;
  }

  if (driverGroupId) {
    console.log(`[Test] Driver target group for unit ${unitNumber || 'unknown'}: ${driverGroupId}`);
    const sentByDriverBot = await sendToChats(
      driverBot,
      [String(driverGroupId)],
      formatted.text,
      formatted.videoUrl || null,
      formatted.inwardVideoUrl || null
    );
    if (!DRY_RUN && DELETE_AFTER_SEC > 0) {
      const allSent = [...sentBySubBot, ...sentByDriverBot];
      await sleep(DELETE_AFTER_SEC * 1000);
      for (const msg of allSent) {
        try {
          const deleteBot = msg.chatId === String(driverGroupId) ? driverBot : subBot;
          await deleteBot.deleteMessage(msg.chatId, String(msg.messageId));
          console.log(`[Test] Deleted message ${msg.messageId} from ${msg.chatId}`);
        } catch (err) {
          console.error(`[Test] Failed deleting ${msg.messageId} from ${msg.chatId}: ${err.message}`);
        }
      }
    }
  } else {
    console.warn('[Test] No driver group resolved and no EMPLOYEE_GROUP_ID fallback set.');
  }

  console.log('[Test] Completed live fetch + send flow.');
}

main().catch((err) => {
  console.error('[Test] Fatal:', err.message);
  process.exit(1);
});
