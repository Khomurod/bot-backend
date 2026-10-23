'use strict';

/**
 * Admin → Users → Company Employees: the staff list with what the birthday
 * card needs. Mounted at /api/company-employees.
 *
 *   GET    /                       every employee (no photo bytes; `has_photo`)
 *   PUT    /:id                    American name and Telegram account, as typed —
 *                                  an account saved here is `confirmed`
 *   POST   /:id/confirm-telegram   a suggested account checked by a person
 *   POST   /suggest-telegram       match employees to the Telegram accounts the
 *                                  bot has seen; never overwrites a confirmed one
 *   PUT    /:id/photo              upload a photo (re-encoded to a square JPEG)
 *   DELETE /:id/photo
 *   GET    /:id/photo              the stored photo
 *   GET    /:id/card               the birthday card as it would be posted —
 *                                  rendered, never sent
 *
 * Names, birthdays, adding and removing employees stay on the Birthdays page.
 * See docs/architecture/employee-birthday-cards.md.
 */
const express = require('express');
const multer = require('multer');

const { insertAdminAudit } = require('../../database/adminAudit');
const { sendFailure } = require('../middleware/failureResponse');
const {
  normalizeTelegramUsername,
  isValidTelegramUsername,
} = require('../../lib/telegram/telegramUsername');
const { suggestTelegramAccounts } = require('../../services/employees/telegramMatch');

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_MB = 10;
const LOG = '[COMPANY EMPLOYEES]';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (PHOTO_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('The photo must be a JPG, PNG or WEBP image'));
  },
});

function employeeId(req) {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The PUT body, checked. Returns { values } or { error }. */
function readProfile(body) {
  const americanName = String(body?.americanName ?? '').trim().replace(/\s+/g, ' ');
  if (americanName.length > 80) return { error: 'The American name is too long (80 characters at most)' };

  const rawUsername = String(body?.telegramUsername ?? '').trim();
  const telegramUsername = normalizeTelegramUsername(rawUsername);
  if (telegramUsername && !isValidTelegramUsername(telegramUsername)) {
    return { error: 'A Telegram username is 5–32 letters, digits or underscores' };
  }

  const rawId = String(body?.telegramUserId ?? '').trim();
  // Fifteen digits is far beyond any Telegram id and safely inside BIGINT.
  if (rawId && !/^[1-9]\d{0,14}$/.test(rawId)) return { error: 'A Telegram user ID is digits only' };

  return { values: { americanName: americanName || null, telegramUsername, telegramUserId: rawId || null } };
}

function createCompanyEmployeesRouter({
  authMiddleware,
  store = require('../../database/companyEmployees'),
  card = require('../../services/employees/birthdayCard'),
  audit = insertAdminAudit,
}) {
  const router = express.Router();

  const record = (req, action, entityId, values) => audit({
    adminId: req.admin?.id ?? null,
    roleKeys: req.admin?.roleKeys || [],
    action,
    entityType: 'employee_birthdays',
    entityId: String(entityId),
    oldValues: null,
    newValues: values,
  }).catch(() => null);

  router.get('/', authMiddleware, async (req, res) => {
    try {
      res.json({ employees: await store.listCompanyEmployees() });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the employees', logPrefix: LOG });
    }
  });

  router.post('/suggest-telegram', authMiddleware, async (req, res) => {
    try {
      const [employees, accounts] = await Promise.all([
        store.listCompanyEmployees(),
        store.listKnownTelegramAccounts(),
      ]);
      // Only rows a suggestion may fill: nobody's confirmed account is offered again.
      const open = employees.filter((e) => e.telegram_match !== 'confirmed');
      const taken = new Set(employees
        .filter((e) => e.telegram_match === 'confirmed' && e.telegram_user_id)
        .map((e) => e.telegram_user_id));
      const suggestions = suggestTelegramAccounts(open, accounts.filter((a) => !taken.has(String(a.telegram_user_id))));
      const written = await store.applyTelegramSuggestions(suggestions);
      await record(req, 'company_employees.suggest_telegram', 'all', { suggested: written });
      res.json({ suggested: written, employees: await store.listCompanyEmployees() });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to suggest Telegram accounts', logPrefix: LOG });
    }
  });

  router.put('/:id', authMiddleware, async (req, res) => {
    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: 'An employee id is required' });
    const { values, error } = readProfile(req.body);
    if (error) return res.status(400).json({ error });
    try {
      const saved = await store.updateCompanyEmployee(id, values);
      if (!saved) return res.status(404).json({ error: 'No such employee' });
      await record(req, 'company_employees.update', id, values);
      res.json({ employee: saved });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to save the employee', logPrefix: LOG });
    }
  });

  router.post('/:id/confirm-telegram', authMiddleware, async (req, res) => {
    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: 'An employee id is required' });
    try {
      const saved = await store.confirmTelegramMatch(id);
      if (!saved) return res.status(409).json({ error: 'There is no suggested account to confirm' });
      await record(req, 'company_employees.confirm_telegram', id, { telegramUserId: saved.telegram_user_id });
      res.json({ employee: saved });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to confirm the account', logPrefix: LOG });
    }
  });

  router.put('/:id/photo', authMiddleware, (req, res) => {
    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: 'An employee id is required' });
    upload.single('photo')(req, res, async (uploadErr) => {
      if (uploadErr) {
        const tooBig = uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({ error: tooBig ? `The photo is larger than ${MAX_PHOTO_MB} MB` : uploadErr.message });
      }
      if (!req.file) return res.status(400).json({ error: 'No photo was sent' });
      let image;
      try {
        image = await card.normalisePhoto(req.file.buffer);
      } catch (_) {
        return res.status(400).json({ error: 'That file could not be read as a photo' });
      }
      try {
        if (!(await store.getCompanyEmployee(id))) return res.status(404).json({ error: 'No such employee' });
        await store.savePhoto(id, image);
        await record(req, 'company_employees.photo', id, { bytes: image.length });
        res.json({ ok: true });
      } catch (err) {
        sendFailure(res, err, { message: 'Failed to save the photo', logPrefix: LOG });
      }
    });
  });

  router.delete('/:id/photo', authMiddleware, async (req, res) => {
    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: 'An employee id is required' });
    try {
      const removed = await store.deletePhoto(id);
      if (removed) await record(req, 'company_employees.photo_removed', id, null);
      res.json({ ok: true, removed });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to remove the photo', logPrefix: LOG });
    }
  });

  router.get('/:id/photo', authMiddleware, async (req, res) => {
    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: 'An employee id is required' });
    try {
      const photo = await store.getPhoto(id);
      if (!photo) return res.status(404).json({ error: 'No photo yet' });
      res.set('Cache-Control', 'private, no-store').type('image/jpeg').send(photo);
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to load the photo', logPrefix: LOG });
    }
  });

  router.get('/:id/card', authMiddleware, async (req, res) => {
    const id = employeeId(req);
    if (!id) return res.status(400).json({ error: 'An employee id is required' });
    try {
      const employee = await store.getCompanyEmployee(id);
      if (!employee) return res.status(404).json({ error: 'No such employee' });
      const photo = employee.has_photo ? await store.getPhoto(id) : null;
      const image = await card.renderBirthdayCard(employee, photo);
      res.set('Cache-Control', 'private, no-store').type('image/jpeg').send(image);
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to draw the card', logPrefix: LOG });
    }
  });

  return router;
}

module.exports = { createCompanyEmployeesRouter, readProfile };
