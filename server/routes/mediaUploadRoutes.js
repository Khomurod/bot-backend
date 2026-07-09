/**
 * Broadcast media upload: POST /api/upload-media stages a photo/video in a
 * Telegram chat to capture a reusable file_id.
 *
 * Returns { router, stagingTelegram } — the staging client is exposed so tests
 * can stub its callApi and drive the route without touching the network
 * (server/api.js re-exports it).
 */
const express = require('express');
const multer = require('multer');
const { Telegram } = require('telegraf');
const { telegramClientOptions } = require('../../services/telegramAgent');

// ─── Multer: memory storage for media uploads ───
const MEDIA_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
const MAX_FILE_SIZE_MB = 20;
// Telegram's Bot API rejects any photo larger than 10 MB via sendPhoto
// ("file of size … is too big for a photo; the maximum size is 10485760 bytes").
// The overall multer cap above (20 MB) is fine for videos, but photos must be
// checked against this stricter limit — otherwise an 10–20 MB image uploads all
// the way to Telegram, gets rejected, and the failure surfaces as a confusing
// generic error. Reject early instead so it fails fast with a clear message.
const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;

const MEDIA_UPLOAD_ATTEMPT_TIMEOUT_MS = 40 * 1000;
const MEDIA_UPLOAD_MAX_ATTEMPTS = 2;

const uploadStorage = multer.memoryStorage();
const uploadLimits = { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 };

function createUploadMiddleware(allowedMimeTypes, allowedTypesLabel) {
  return multer({
    storage: uploadStorage,
    limits: uploadLimits,
    fileFilter: (req, file, cb) => {
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowedTypesLabel}`));
      }
    },
  });
}

function createMediaUploadRoutes({ config, authMiddleware }) {
  const router = express.Router();

  // ─── Telegram staging client for media uploads ───
  // A dedicated raw client (same BOT_TOKEN) rather than the shared bot.telegram:
  //  1. bot.telegram is wrapped by the sent-message registry, which couples an
  //     awaited DB insert into every send — a slow DB write must never be able
  //     to stall a media upload (and staged messages are deleted right away, so
  //     recording them was pointless anyway);
  //  2. the raw callApi lets us pass an AbortSignal, so a stalled upload is
  //     genuinely cancelled — a Promise.race timeout would leave the zombie
  //     upload running, still consuming the instance's limited bandwidth and
  //     competing with the retry.
  // The IPv4-pinned agent (telegramClientOptions) is the actual upload-stall fix:
  // without it the upload can ride a broken IPv6 route and hang regardless of the
  // retry/timeout machinery above.
  const stagingTelegram = new Telegram(config.botToken, telegramClientOptions);

  async function callStagingApiWithRetry(method, payload) {
    let workingPayload = payload;
    let lastErr;
    for (let attempt = 1; attempt <= MEDIA_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MEDIA_UPLOAD_ATTEMPT_TIMEOUT_MS);
      const startedAt = Date.now();
      try {
        const result = await stagingTelegram.callApi(method, workingPayload, { signal: controller.signal });
        console.log(`[API] Telegram staging ${method} OK in ${Date.now() - startedAt}ms (attempt ${attempt})`);
        return result;
      } catch (err) {
        const elapsed = Date.now() - startedAt;
        const aborted = err?.name === 'AbortError' || err?.type === 'aborted';
        lastErr = aborted
          ? new Error(`Telegram upload stalled and was aborted after ${Math.round(elapsed / 1000)}s (attempt ${attempt}/${MEDIA_UPLOAD_MAX_ATTEMPTS})`)
          : err;
        console.error(`[API] Telegram staging ${method} failed in ${elapsed}ms (attempt ${attempt}/${MEDIA_UPLOAD_MAX_ATTEMPTS}):`, lastErr.message);

        // Supergroup migration: the staging chat was upgraded to a supergroup and
        // its id changed. Retry against the new id Telegram hands back.
        const migrateTo = err?.response?.parameters?.migrate_to_chat_id;
        if (migrateTo) {
          console.warn(`[API] Staging chat migrated to supergroup ${migrateTo}; retrying.`);
          workingPayload = { ...workingPayload, chat_id: migrateTo };
          continue;
        }

        // Telegram 4xx responses are otherwise permanent (bad file, bad chat, too
        // big) — retrying identical input is pointless. Only retry stalls/network/5xx.
        const apiCode = err?.response?.error_code;
        if (apiCode && apiCode < 500) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  const upload = createUploadMiddleware(MEDIA_UPLOAD_MIME_TYPES, 'jpg, png, webp, mp4, mov');

  // POST /api/upload-media
  router.post('/api/upload-media', authMiddleware, (req, res) => {
    upload.single('media')(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` });
        }
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const isVideo = req.file.mimetype.startsWith('video/');
      const mediaType = isVideo ? 'video' : 'photo';

      // Fail fast on oversize photos: Telegram caps sendPhoto at 10 MB, so an
      // 10–20 MB image would otherwise upload fully, stall, and then be rejected.
      if (!isVideo && req.file.size > MAX_PHOTO_SIZE_BYTES) {
        const sizeMb = (req.file.size / (1024 * 1024)).toFixed(1);
        return res.status(400).json({
          error: `Photo is too large (${sizeMb}MB). Telegram allows photos up to 10MB — `
            + 'please compress or resize the image, or send it as an MP4 video.',
        });
      }

      try {
        const fileSource = { source: req.file.buffer, filename: req.file.originalname };
        const mediaStorageChatId = config.mediaStorageChatId;
        console.log(
          `[API] Media upload started: type=${mediaType}, size=${(req.file.size / (1024 * 1024)).toFixed(2)}MB, name=${req.file.originalname}`
        );

        const sentMessage = await callStagingApiWithRetry(isVideo ? 'sendVideo' : 'sendPhoto', {
          chat_id: mediaStorageChatId,
          [isVideo ? 'video' : 'photo']: fileSource,
          disable_notification: true,
          caption: 'Upload staging for file_id capture.',
        });

        // Extract file_id (highest-resolution photo size is last).
        let fileId;
        if (isVideo) {
          fileId = sentMessage.video?.file_id;
        } else {
          const photos = sentMessage.photo;
          fileId = photos && photos.length > 0 ? photos[photos.length - 1].file_id : null;
        }

        try {
          await stagingTelegram.deleteMessage(mediaStorageChatId, sentMessage.message_id);
        } catch (deleteErr) {
          console.warn('[API] Failed to delete staged media message:', deleteErr.message);
          try {
            await stagingTelegram.editMessageCaption(
              mediaStorageChatId,
              sentMessage.message_id,
              undefined,
              'Staged media for upcoming broadcast.',
              { parse_mode: 'HTML' }
            );
          } catch (editErr) {
            console.warn('[API] Failed to edit staged media caption:', editErr.message);
          }
        }

        if (!fileId) {
          return res.status(500).json({ error: 'Failed to retrieve file_id from Telegram' });
        }

        console.log(`[API] Media uploaded: type=${mediaType}, file_id=${fileId}`);
        res.json({ file_id: fileId, media_type: mediaType, type: mediaType, url: null });
      } catch (uploadErr) {
        // Surface the actual Telegram error so operators see the real cause
        // instead of a one-size-fits-all "check bot permissions" that is usually
        // wrong. Map the common causes to an actionable hint.
        const detail = uploadErr?.response?.description || uploadErr?.message || 'unknown error';
        console.error('[API] Media upload error:', detail);
        let friendly;
        if (/too big for a photo/i.test(detail)) {
          friendly = 'Photo is too large for Telegram (max 10MB). Please compress or resize the image, or send it as an MP4 video.';
        } else if (/chat not found/i.test(detail)) {
          friendly = 'Telegram could not find the media staging chat. Check that MEDIA_STORAGE_CHAT_ID '
            + `is a chat the bot belongs to. (${detail})`;
        } else if (/not enough rights|CHAT_SEND_.*FORBIDDEN|have no rights|need administrator/i.test(detail)) {
          friendly = 'The bot is not allowed to post media in the staging chat. Make the bot an admin there '
            + `(or allow media messages) and try again. (${detail})`;
        } else {
          friendly = `Failed to upload media to Telegram: ${detail}`;
        }
        res.status(502).json({ error: friendly });
      }
    });
  });

  return { router, stagingTelegram };
}

module.exports = { createMediaUploadRoutes };
