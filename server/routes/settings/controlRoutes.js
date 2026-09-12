/**
 * The control channel — admin API.
 *
 * Two things an administrator manages here, and the second one is the one that
 * matters:
 *
 *   the switch and its limits   whether Wenze may ask questions at all, how
 *                               many per pass, and how often it may repeat one.
 *   WHO MAY BE OBEYED           the operator allow-list. Being in a Telegram
 *                               group is not authorisation, so this list is the
 *                               only thing standing between a group member's
 *                               "yes" and a change to the fleet.
 *
 * THREE RULES THIS FILE ENFORCES:
 *   - an operator id is a NUMBER and nothing else. No username, no @handle: a
 *     username can be changed by its owner and reused by a stranger, and an
 *     allow-list keyed on one would hand the channel to whoever claims the name
 *     next.
 *   - the last enabled operator cannot be removed. An empty list does not mean
 *     "everybody", it means nobody can steer Wenze from Telegram and the way
 *     back is the database. (Enforced in the data layer so it holds for every
 *     caller; repeated here as the message a person reads.)
 *   - every change is audited, because "who added an operator" is exactly the
 *     question somebody asks after an unexpected correction.
 */

const express = require('express');
const settingsStore = require('../../../database/controlSettings');
const operatorStore = require('../../../database/controlOperators');
const replyStore = require('../../../database/controlReplies');
const { insertAdminAudit } = require('../../../database/adminAudit');
const { sendFailure } = require('../../middleware/failureResponse');

function createControlSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/control', authMiddleware, async (req, res) => {
    try {
      const [settings, operators, replies] = await Promise.all([
        settingsStore.getControlSettings({ force: true }),
        operatorStore.listControlOperators(),
        replyStore.summariseControlReplies(),
      ]);
      res.json({ settings, operators, replies });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load control channel settings', logPrefix: '[SETTINGS API]' });
    }
  });

  router.put('/control', authMiddleware, async (req, res) => {
    try {
      const before = await settingsStore.getControlSettings({ force: true });
      const settings = await settingsStore.updateControlSettings(req.body || {}, {
        updatedBy: req.admin?.username || req.admin?.id || null,
      });
      await insertAdminAudit({
        adminId: req.admin?.id ?? null,
        roleKeys: req.admin?.roleKeys || [],
        action: 'control_settings.update',
        entityType: 'control_settings',
        entityId: '1',
        oldValues: before,
        newValues: settings,
        ipAddress: req.ip || null,
      }).catch(() => {});
      res.json({ settings });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to save control channel settings', logPrefix: '[SETTINGS API]' });
    }
  });

  router.post('/control/operators', authMiddleware, async (req, res) => {
    try {
      const raw = String(req.body?.telegramUserId ?? '').trim();
      if (!/^\d{5,15}$/.test(raw)) {
        res.status(400).json({
          error: 'A Telegram user id is a number — not a username. The person can get theirs from @userinfobot.',
          field: 'telegramUserId',
        });
        return;
      }
      const operator = await operatorStore.addControlOperator({
        telegramUserId: raw,
        label: req.body?.label ? String(req.body.label).slice(0, 80) : null,
        adminId: req.body?.adminId ?? null,
        addedBy: req.admin?.username || String(req.admin?.id ?? '') || null,
      });
      await insertAdminAudit({
        adminId: req.admin?.id ?? null,
        roleKeys: req.admin?.roleKeys || [],
        action: 'control_operator.add',
        entityType: 'control_operator',
        entityId: raw,
        newValues: operator,
        ipAddress: req.ip || null,
      }).catch(() => {});
      res.json({ operator });
    } catch (err) {
      if (err.code === 'INVALID_TELEGRAM_USER_ID') {
        res.status(400).json({ error: err.message, field: 'telegramUserId' });
        return;
      }
      sendFailure(res, err, { message: 'Failed to add the operator', logPrefix: '[SETTINGS API]' });
    }
  });

  router.delete('/control/operators/:telegramUserId', authMiddleware, async (req, res) => {
    try {
      const removed = await operatorStore.removeControlOperator(req.params.telegramUserId);
      if (!removed) {
        res.status(404).json({ error: 'That operator is not on the list.' });
        return;
      }
      await insertAdminAudit({
        adminId: req.admin?.id ?? null,
        roleKeys: req.admin?.roleKeys || [],
        action: 'control_operator.remove',
        entityType: 'control_operator',
        entityId: String(req.params.telegramUserId),
        oldValues: removed,
        ipAddress: req.ip || null,
      }).catch(() => {});
      res.json({ removed });
    } catch (err) {
      if (err.code === 'LAST_OPERATOR') {
        res.status(400).json({ error: err.message });
        return;
      }
      sendFailure(res, err, { message: 'Failed to remove the operator', logPrefix: '[SETTINGS API]' });
    }
  });

  return router;
}

module.exports = { createControlSettingsRouter };
