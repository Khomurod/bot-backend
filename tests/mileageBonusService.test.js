const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DateTime } = require('luxon');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function loadService({ mb: mbOverrides = {}, telegram: telegramOverrides = {}, datatruck: dtOverrides = {} } = {}) {
  const servicePath = path.resolve(__dirname, '../services/mileageBonusService.js');
  const mbPath = path.resolve(__dirname, '../database/mileageBonus.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const datatruckPath = path.resolve(__dirname, '../services/datatruckApiService.js');

  for (const p of [servicePath, mbPath, botPath, htmlPath, datatruckPath]) delete require.cache[p];

  const mb = {
    async withMileageRunLock(fn) { return { acquired: true, result: await fn() }; },
    async claimMileageBonusRun() { return { id: 1, attempt_count: 1 }; },
    async completeMileageBonusRun() {},
    async failMileageBonusRun() {},
    async listInactiveDriverKeys() { return new Set(); },
    async upsertDriverProgress() { return {}; },
    async isDriverActive() { return true; },
    async claimBonusNotification() { return null; },
    async setBonusNotificationMessage() {},
    async markBonusNotificationDeliveryFailed() {},
    async getBonusNotificationById() { return null; },
    async claimNotificationAction() { return null; },
    async releaseNotificationAction() {},
    async finalizeNotificationResend() { return null; },
    async markNotificationDisregarded() { return null; },
    async completeNotificationCleanup() { return null; },
    async setDriverActive() { return null; },
    async listOpenNotificationsForDriver() { return []; },
    async listDriverProgress() { return []; },
    async listBonusNotifications() { return []; },
    async getLatestMileageBonusRun() { return null; },
    async isMileageBonusRunActive() { return false; },
    ...mbOverrides,
  };
  const telegram = {
    async sendMessage() { return { message_id: 100 }; },
    async deleteMessage() { return true; },
    async editMessageReplyMarkup() { return true; },
    ...telegramOverrides,
  };
  const datatruck = {
    isConfigured() { return true; },
    async fetchAllDrivers() { return []; },
    async fetchOrdersByPickupWindow() { return []; },
    ...dtOverrides,
  };

  require.cache[mbPath] = { exports: mb };
  require.cache[botPath] = { exports: { bot: { telegram } } };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[datatruckPath] = { exports: datatruck };

  return { service: require(servicePath), mb, telegram, datatruck };
}

function notification(overrides = {}) {
  return {
    id: 7,
    driver_external_id: 'd1',
    driver_normalized_name: 'JANE DRIVER',
    driver_name: 'Jane Driver',
    threshold_miles: 10000,
    bonus_amount: 200,
    miles_at_notification: 11000,
    period_start: '2026-04-17',
    period_end: '2026-06-07',
    status: 'pending',
    action_state: 'idle',
    telegram_chat_id: -5170359585,
    telegram_message_id: 50,
    telegram_followup_message_id: null,
    ...overrides,
  };
}

test('inactive drivers are excluded from mileage calculation entirely', async () => {
  const { service } = loadService({
    datatruck: {
      async fetchAllDrivers() {
        return [
          { id: 1, driver_type: 'company_driver', hire_date: '2026-04-01', account: { full_name: 'Active Driver' } },
          { id: 2, driver_type: 'company_driver', hire_date: '2026-04-01', account: { full_name: 'Inactive Driver' } },
        ];
      },
      async fetchOrdersByPickupWindow() {
        return [
          { pickup_time: '2026-05-01T12:00:00Z', trip: { driver__full_name: 'Active Driver', mile: '9000', empty_mile: '2000' } },
          { pickup_time: '2026-05-02T12:00:00Z', trip: { driver__full_name: 'Inactive Driver', mile: '15000', empty_mile: '0' } },
        ];
      },
    },
  });

  const result = await service.computeDriverMileage(
    DateTime.fromISO('2026-06-18T12:00:00', { zone: 'America/Chicago' }),
    { inactiveKeys: new Set(['INACTIVE DRIVER']) }
  );
  assert.equal(result.drivers.length, 1);
  assert.equal(result.drivers[0].name, 'Active Driver');
  assert.equal(result.drivers[0].totalMiles, 11000);
});

test('refresh and notifying runs share the same in-process lock', async () => {
  const gate = deferred();
  const started = deferred();
  const { service } = loadService({
    datatruck: {
      async fetchAllDrivers() {
        started.resolve();
        await gate.promise;
        return [];
      },
    },
  });

  const refresh = service.refreshProgressOnly({});
  await started.promise;
  const concurrent = await service.runMileageBonusCheck({ trigger: 'manual' });
  assert.deepEqual(concurrent, { busy: true });
  gate.resolve();
  await refresh;
});

test('failed Telegram delivery is retained and makes the durable run retryable', async () => {
  const deliveryFailures = [];
  const failedRuns = [];
  const claimed = notification({ telegram_message_id: null, delivery_state: 'pending' });
  const { service } = loadService({
    mb: {
      async claimBonusNotification() { return claimed; },
      async markBonusNotificationDeliveryFailed(id, error) { deliveryFailures.push({ id, error }); },
      async failMileageBonusRun(id, error, delay, summary) { failedRuns.push({ id, error, delay, summary }); },
    },
    telegram: {
      async sendMessage() { throw new Error('Telegram unavailable'); },
    },
    datatruck: {
      async fetchAllDrivers() {
        return [{ id: 1, driver_type: 'company_driver', hire_date: '2026-04-01', account: { full_name: 'Jane Driver' } }];
      },
      async fetchOrdersByPickupWindow() {
        return [{ pickup_time: '2026-05-01T12:00:00Z', trip: { driver__full_name: 'Jane Driver', mile: '11000', empty_mile: '0' } }];
      },
    },
  });

  await assert.rejects(service.runMileageBonusCheck({ trigger: 'scheduled', runKey: 'weekly:test' }), /retry scheduled/);
  assert.equal(deliveryFailures.length, 1);
  assert.equal(failedRuns.length, 1);
  assert.equal(failedRuns[0].summary.errors.length, 1);
  assert.equal(failedRuns[0].delay, 5);
});

test('resend posts a new current card and removes the old card plus rejection follow-up', async () => {
  const old = notification({ status: 'rejected', telegram_followup_message_id: 51 });
  const deleted = [];
  let finalized = null;
  const { service } = loadService({
    mb: {
      async getBonusNotificationById() { return old; },
      async claimNotificationAction() { return { ...old, action_state: 'resending' }; },
      async finalizeNotificationResend(id, values) {
        finalized = { id, ...values };
        return notification({ telegram_message_id: values.messageId, status: 'pending' });
      },
    },
    telegram: {
      async sendMessage() { return { message_id: 99 }; },
      async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); },
    },
  });

  const result = await service.resendBonusNotification(7, { username: 'admin' });
  assert.equal(finalized.messageId, 99);
  assert.deepEqual(deleted.map((item) => item.messageId), [50, 51]);
  assert.equal(result.notification.status, 'pending');
  assert.equal(result.cleanup.deleted, true);
});

test('paid notification cannot be resent or disregarded', async () => {
  let actionClaims = 0;
  const paid = notification({ status: 'paid' });
  const { service } = loadService({
    mb: {
      async getBonusNotificationById() { return paid; },
      async claimNotificationAction() { actionClaims += 1; },
    },
  });
  await assert.rejects(service.resendBonusNotification(7), /cannot be resent/);
  await assert.rejects(service.disregardBonusNotification(7), /cannot be disregarded/);
  assert.equal(actionClaims, 0);
});

test('disregard remains authoritative when Telegram is too old to delete', async () => {
  const row = notification();
  let completed = null;
  const { service } = loadService({
    mb: {
      async getBonusNotificationById() { return row; },
      async claimNotificationAction() { return { ...row, action_state: 'disregarding' }; },
      async markNotificationDisregarded() { return { ...row, status: 'disregarded', action_state: 'disregarding' }; },
      async completeNotificationCleanup(id, cleanup) {
        completed = cleanup;
        return { ...row, status: 'disregarded' };
      },
    },
    telegram: {
      async deleteMessage() { throw new Error('message can\'t be deleted'); },
      async editMessageReplyMarkup() { return true; },
    },
  });

  const result = await service.disregardBonusNotification(7, { username: 'admin' });
  assert.equal(result.notification.status, 'disregarded');
  assert.equal(completed.deleted, false);
  assert.equal(completed.buttonsRemoved, true);
  assert.match(completed.error, /could not delete/);
});

test('deactivating a driver disregards all open notifications', async () => {
  const row = notification();
  let disregarded = 0;
  const { service } = loadService({
    mb: {
      async setDriverActive(name, active) { return { driver_normalized_name: name, is_active: active }; },
      async listOpenNotificationsForDriver() { return [row]; },
      async getBonusNotificationById() { return row; },
      async claimNotificationAction() { return { ...row, action_state: 'disregarding' }; },
      async markNotificationDisregarded() {
        disregarded += 1;
        return { ...row, status: 'disregarded', action_state: 'disregarding' };
      },
      async completeNotificationCleanup() { return { ...row, status: 'disregarded' }; },
    },
  });

  const result = await service.setDriverActivation('JANE DRIVER', false, { username: 'admin' });
  assert.equal(result.progress.is_active, false);
  assert.equal(disregarded, 1);
  assert.equal(result.cleanedNotifications.length, 1);
});
