'use strict';

/**
 * The one place a driver-group message reaches Truck Photos.
 *
 * DELIBERATELY THIN: whether a photo is remembered and whether a word makes a
 * PDF are decided in services/truckPhotos/, where they can be tested without a
 * bot.
 *
 * AN OBSERVER. `next()` IS ALWAYS CALLED, so every handler after this one sees
 * the message exactly as before; nothing is ever written in the group. IT
 * CANNOT THROW: a rejection inside a `bot.on('message')` handler reaches
 * index.js's `unhandledRejection` hook, which exits the process.
 *
 * The photo is remembered BEFORE the word is looked at, so a photo captioned
 * `outbound` is in the buffer by the time its own report runs. The report is
 * not waited for: it starts a few seconds later, off the bot's path.
 *
 * Edited messages are not read: a word edited in later is not a hand-over
 * anybody saw happen.
 */

const { captureTruckPhoto } = require('../../services/truckPhotos/capture');
const { noticeTruckPhotoTrigger } = require('../../services/truckPhotos/triggerHandler');

function registerTruckPhotoHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await captureTruckPhoto(ctx.message);
      noticeTruckPhotoTrigger(ctx.message, { telegram: ctx.telegram }).catch((err) => {
        console.error('[TRUCK PHOTOS] trigger failed:', err?.message || String(err));
      });
    } catch (err) {
      console.error('[TRUCK PHOTOS] handler failed:', err?.message || String(err));
    }
    return next();
  });
}

module.exports = { registerTruckPhotoHandlers };
