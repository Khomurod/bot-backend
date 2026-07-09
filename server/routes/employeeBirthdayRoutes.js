/**
 * Employee birthdays: the public mini-form + submit endpoint, admin CRUD, wish
 * settings, and the send/congratulate actions.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const { DateTime } = require('luxon');
const {
  runEmployeeBirthdayWishes,
  sendCustomEmployeeGroupMessage,
} = require('../../services/employeeBirthdayWishService');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mapEmployeeBirthdaySettings(row) {
  if (!row) return null;
  return {
    timezone: row.timezone,
    sendHour: row.send_hour,
    sendMinute: row.send_minute,
    aiInstructions: row.ai_instructions,
    fallbackTemplate: row.fallback_template,
    updatedAt: row.updated_at,
  };
}

function createEmployeeBirthdayRoutes({ db, config, authMiddleware, bot }) {
  const router = express.Router();

  // 1. Mini Web App Landing Page (Public)
  router.get('/employee-birthday-form', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Employee Birthday</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0f1117; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #1e2230; padding: 24px; border-radius: 12px; width: 90%; max-width: 400px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
        input { width: 100%; padding: 14px; margin-bottom: 16px; border-radius: 8px; border: 1px solid #2d3348; background: #252a3a; color: #fff; box-sizing: border-box; font-size: 16px; }
        button { width: 100%; padding: 14px; background: #6366f1; color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; }
        .step { display: none; }
        .step.active { display: block; animation: fadeIn 0.3s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin-top: 0;">🎂 Your Birthday</h2>
        <div id="step1" class="step active">
          <label style="display:block; margin-bottom:8px; color:#94a3b8;">First Name</label>
          <input type="text" id="fn" placeholder="Enter your first name" />
          <button onclick="next(1)">Next ➔</button>
        </div>
        <div id="step2" class="step">
          <label style="display:block; margin-bottom:8px; color:#94a3b8;">Last Name</label>
          <input type="text" id="ln" placeholder="Enter your last name" />
          <button onclick="next(2)">Next ➔</button>
        </div>
        <div id="step3" class="step">
          <label style="display:block; margin-bottom:8px; color:#94a3b8;">Select your Birthday</label>
          <input type="date" id="bday" />
          <button onclick="submitForm()" id="submitBtn">Submit ✅</button>
        </div>
        <div id="step4" class="step" style="text-align: center;">
          <h2 style="font-size: 40px; margin: 10px 0;">🎉</h2>
          <h3>All Set!</h3>
          <p style="color: #94a3b8;">Your birthday has been recorded. You can close this page now.</p>
        </div>
      </div>
      <script>
        function next(step) {
          if(step === 1 && !document.getElementById('fn').value.trim()) return alert('Please enter your first name.');
          if(step === 2 && !document.getElementById('ln').value.trim()) return alert('Please enter your last name.');
          document.querySelectorAll('.step').forEach(e => e.classList.remove('active'));
          document.getElementById('step' + (step + 1)).classList.add('active');
        }
        async function submitForm() {
          const fn = document.getElementById('fn').value.trim();
          const ln = document.getElementById('ln').value.trim();
          const bd = document.getElementById('bday').value;
          if(!bd) return alert('Please select your birthday.');

          document.getElementById('submitBtn').innerText = 'Submitting...';
          document.getElementById('submitBtn').disabled = true;

          try {
            const res = await fetch('/api/submit-employee-birthday', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ firstName: fn, lastName: ln, birthday: bd })
            });
            if(res.ok) next(3);
            else alert('Error submitting. Please try again.');
          } catch(e) { alert('Network error.'); }
        }
      </script>
    </body>
    </html>
  `);
  });

  // 2. Submit Route (Public)
  router.post('/api/submit-employee-birthday', async (req, res) => {
    try {
      const { firstName, lastName, birthday } = req.body || {};

      if (typeof firstName !== 'string' || typeof lastName !== 'string'
          || typeof birthday !== 'string') {
        return res.status(400).json({ error: 'Missing fields' });
      }
      const fn = firstName.trim();
      const ln = lastName.trim();
      if (!fn || !ln) return res.status(400).json({ error: 'Missing fields' });
      if (fn.length > 100 || ln.length > 100) {
        return res.status(400).json({ error: 'Name too long' });
      }
      if (!ISO_DATE_RE.test(birthday)) {
        return res.status(400).json({ error: 'birthday must be YYYY-MM-DD' });
      }
      const d = new Date(birthday);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'birthday is not a valid calendar date' });
      }

      await db.upsertEmployeeBirthday(fn, ln, birthday);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error saving employee birthday:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // 3. Get All Employee Birthdays (Protected Admin)
  router.get('/api/employee-birthdays', authMiddleware, async (req, res) => {
    try {
      const data = await db.getAllEmployeeBirthdays();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/employee-birthdays/settings', authMiddleware, async (req, res) => {
    try {
      const settings = await db.getEmployeeBirthdaySettings();
      res.json(mapEmployeeBirthdaySettings(settings));
    } catch (err) {
      console.error('[API] Error loading employee birthday settings:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.put('/api/employee-birthdays/settings', authMiddleware, async (req, res) => {
    try {
      const {
        timezone,
        sendHour,
        sendMinute,
        aiInstructions,
        fallbackTemplate,
      } = req.body || {};

      if (!timezone || typeof timezone !== 'string') {
        return res.status(400).json({ error: 'timezone is required' });
      }
      if (!DateTime.now().setZone(timezone).isValid) {
        return res.status(400).json({ error: 'Invalid timezone' });
      }

      const hour = Number(sendHour);
      const minute = Number(sendMinute);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ error: 'sendHour must be 0–23' });
      }
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        return res.status(400).json({ error: 'sendMinute must be 0–59' });
      }
      if (typeof aiInstructions !== 'string' || !aiInstructions.trim()) {
        return res.status(400).json({ error: 'aiInstructions is required' });
      }
      if (typeof fallbackTemplate !== 'string' || !fallbackTemplate.trim()) {
        return res.status(400).json({ error: 'fallbackTemplate is required' });
      }
      if (!fallbackTemplate.includes('{names}')) {
        return res.status(400).json({ error: 'fallbackTemplate must include {names}' });
      }

      const updated = await db.updateEmployeeBirthdaySettings({
        timezone: timezone.trim(),
        sendHour: hour,
        sendMinute: minute,
        aiInstructions: aiInstructions.trim().slice(0, 4000),
        fallbackTemplate: fallbackTemplate.trim().slice(0, 4000),
      });
      res.json(mapEmployeeBirthdaySettings(updated));
    } catch (err) {
      console.error('[API] Error updating employee birthday settings:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/employee-birthdays/send-now', authMiddleware, async (req, res) => {
    try {
      const result = await runEmployeeBirthdayWishes({ claimDailyRun: true });
      res.json(result);
    } catch (err) {
      console.error('[API] Error sending employee birthday wishes:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send wishes' });
    }
  });

  router.post('/api/employee-birthdays/congratulate', authMiddleware, async (req, res) => {
    try {
      const { employeeIds } = req.body || {};
      if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
        return res.status(400).json({ error: 'employeeIds array is required' });
      }
      const ids = employeeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
      if (!ids.length) return res.status(400).json({ error: 'Invalid employeeIds' });

      const result = await runEmployeeBirthdayWishes({ employeeIds: ids, claimDailyRun: false });
      res.json(result);
    } catch (err) {
      console.error('[API] Error congratulating employees:', err.message);
      res.status(500).json({ error: err.message || 'Failed to send congratulations' });
    }
  });

  router.post('/api/employee-birthdays/send-custom', authMiddleware, async (req, res) => {
    try {
      const { message } = req.body || {};
      const result = await sendCustomEmployeeGroupMessage(message);
      res.json(result);
    } catch (err) {
      console.error('[API] Error sending custom employee message:', err.message);
      res.status(400).json({ error: err.message || 'Failed to send message' });
    }
  });

  // 4. Trigger Bot Request Message (Protected Admin)
  router.post('/api/employee-birthdays/request', authMiddleware, async (req, res) => {
    try {
      if (!config.employeeGroupId) return res.status(400).json({ error: 'EMPLOYEE_GROUP_ID not configured in .env' });
      const { Markup } = require('telegraf');
      const appUrl = process.env.RENDER_EXTERNAL_URL || 'https://bot-backend-x9lc.onrender.com';
      const keyboard = Markup.inlineKeyboard([
        Markup.button.url('🎂 Enter Your Birthday', `${appUrl}/employee-birthday-form`)
      ]);
      const msg = `Hey Team! 👋\n\nWe'd love to celebrate your special day! Please take 10 seconds to click the button below and enter your birthday.`;
      await bot.telegram.sendMessage(config.employeeGroupId, msg, { parse_mode: 'HTML', ...keyboard });
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error sending birthday request:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Update Employee (Protected Admin)
  router.put('/api/employee-birthdays/:id', authMiddleware, async (req, res) => {
    try {
      const { firstName, lastName, birthday } = req.body;
      if (!firstName || !lastName || !birthday) return res.status(400).json({ error: 'Missing fields' });
      const updated = await db.updateEmployeeBirthday(req.params.id, firstName, lastName, birthday);
      res.json(updated);
    } catch (err) {
      console.error('[API] Error updating employee birthday:', err.message);
      res.status(500).json({ error: 'Failed to update employee' });
    }
  });

  // 6. Delete Employee (Protected Admin)
  router.delete('/api/employee-birthdays/:id', authMiddleware, async (req, res) => {
    try {
      await db.deleteEmployeeBirthday(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[API] Error deleting employee birthday:', err.message);
      res.status(500).json({ error: 'Failed to delete employee' });
    }
  });

  return router;
}

module.exports = { createEmployeeBirthdayRoutes };
