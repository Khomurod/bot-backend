/**
 * Employee Voting — API routes (isolated from driver survey API)
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const votingDb = require('../database/employeeVoting');
const { bot } = require('../bot/bot');
const { sendVotingPoll } = require('../bot/employeeVoting');

const router = express.Router();

// ─── Auth middleware (reuse same JWT logic) ───
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// GET /api/voting/units — extract driver units from groups table
router.get('/api/voting/units', authMiddleware, async (req, res) => {
  try {
    const units = await votingDb.getDriverUnitsFromGroups();
    res.json(units);
  } catch (err) {
    console.error('[VOTING API] Error fetching units:', err.message);
    res.status(500).json({ error: 'Failed to fetch driver units' });
  }
});

// GET /api/voting/polls — list all polls
router.get('/api/voting/polls', authMiddleware, async (req, res) => {
  try {
    const polls = await votingDb.getAllPolls();
    res.json(polls);
  } catch (err) {
    console.error('[VOTING API] Error fetching polls:', err.message);
    res.status(500).json({ error: 'Failed to fetch polls' });
  }
});

// POST /api/voting/polls — create and send a new poll
router.post('/api/voting/polls', authMiddleware, async (req, res) => {
  try {
    // Check for existing active poll
    const active = await votingDb.getActivePoll();
    if (active) {
      return res.status(400).json({ error: 'An active poll already exists. Close it first before creating a new one.' });
    }

    // Get driver units from groups
    const units = await votingDb.getDriverUnitsFromGroups();
    if (units.length === 0) {
      return res.status(400).json({ error: 'No driver units found in groups. Make sure groups have names like "COMPANY UNIT #123 DRIVER NAME".' });
    }

    const question = 'Choose the best driver of the week in your opinion.';

    // Create poll in DB
    const poll = await votingDb.createPoll(question, units);

    // Get the created options
    const options = await votingDb.getPollOptions(poll.id);

    // Send to Telegram employee group
    try {
      await sendVotingPoll(bot, poll.id, options);
    } catch (tgErr) {
      console.error('[VOTING API] Failed to send poll to Telegram:', tgErr.message);
      // Poll is created in DB but Telegram send failed — don't fail the whole request
      return res.status(201).json({
        ...poll,
        warning: 'Poll created but failed to send to Telegram. Check EMPLOYEE_GROUP_ID and bot permissions.',
      });
    }

    res.status(201).json(poll);
  } catch (err) {
    console.error('[VOTING API] Error creating poll:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create poll' });
  }
});

// GET /api/voting/polls/:id/results — vote results with driver details
router.get('/api/voting/polls/:id/results', authMiddleware, async (req, res) => {
  try {
    const results = await votingDb.getPollResults(parseInt(req.params.id, 10));
    res.json(results);
  } catch (err) {
    console.error('[VOTING API] Error fetching results:', err.message);
    res.status(500).json({ error: 'Failed to fetch poll results' });
  }
});

// GET /api/voting/polls/:id/voters — individual voter list
router.get('/api/voting/polls/:id/voters', authMiddleware, async (req, res) => {
  try {
    const voters = await votingDb.getPollVoters(parseInt(req.params.id, 10));
    res.json(voters);
  } catch (err) {
    console.error('[VOTING API] Error fetching voters:', err.message);
    res.status(500).json({ error: 'Failed to fetch voters' });
  }
});

// PUT /api/voting/polls/:id/close — close an active poll
router.put('/api/voting/polls/:id/close', authMiddleware, async (req, res) => {
  try {
    await votingDb.closePoll(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    console.error('[VOTING API] Error closing poll:', err.message);
    res.status(500).json({ error: 'Failed to close poll' });
  }
});

// PUT /api/voting/polls/:id/reset — reset votes for a poll
router.put('/api/voting/polls/:id/reset', authMiddleware, async (req, res) => {
  try {
    await votingDb.resetPoll(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    console.error('[VOTING API] Error resetting poll:', err.message);
    res.status(500).json({ error: 'Failed to reset poll' });
  }
});

module.exports = router;
