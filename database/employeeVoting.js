/**
 * Employee Voting — Database helpers (fully isolated from driver survey system)
 */
const { pool, query } = require('./db');
const {
  extractUnitFromGroupName,
  parseGroupName,
} = require('../services/driverGroupTitle');

/**
 * Get all driver units from the groups table.
 * Returns [{ unit_number, driver_name, company_name, driver_type, group_id, telegram_group_id }]
 */
async function getDriverUnitsFromGroups() {
  const res = await query("SELECT id, group_name, telegram_group_id FROM groups WHERE group_type = 'driver' ORDER BY id");
  const units = [];

  for (const row of res.rows) {
    const unit = extractUnitFromGroupName(row.group_name);
    if (!unit) continue; // skip groups without unit numbers

    const { company, driver, type } = parseGroupName(row.group_name);
    units.push({
      unit_number: unit,
      driver_name: driver,
      company_name: company,
      driver_type: type,
      group_id: row.id,
      telegram_group_id: row.telegram_group_id,
    });
  }

  // Handle duplicate unit numbers: if a unit has both a regular and company driver,
  // append "(C)" to the company driver's unit_number so both appear in voting.
  const countByUnit = {};
  units.forEach(u => {
    countByUnit[u.unit_number] = (countByUnit[u.unit_number] || 0) + 1;
  });

  const seen = new Set();
  return units.map(u => {
    const isDuplicate = countByUnit[u.unit_number] > 1;
    const isCompanyDriver = u.driver_type && /company/i.test(u.driver_type);

    // Company drivers in duplicate pairs get "(C)" suffix
    const finalUnit = (isDuplicate && isCompanyDriver)
      ? `${u.unit_number}(C)`
      : u.unit_number;

    if (seen.has(finalUnit)) return null; // true duplicate, skip
    seen.add(finalUnit);

    return { ...u, unit_number: finalUnit };
  }).filter(Boolean);
}

// ─── Polls ───

async function createPoll(question, driverUnits) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pRes = await client.query(
      `INSERT INTO employee_votes_polls (question, status) VALUES ($1, 'active') RETURNING *`,
      [question]
    );
    const poll = pRes.rows[0];

    for (const u of driverUnits) {
      await client.query(
        `INSERT INTO employee_votes_options (poll_id, unit_number, driver_name, company_name, driver_type, group_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [poll.id, u.unit_number, u.driver_name, u.company_name, u.driver_type, u.group_id]
      );
    }

    await client.query('COMMIT');
    console.log(`[VOTING] Poll created: id=${poll.id}, options=${driverUnits.length}`);
    return poll;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[VOTING] Error creating poll:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function setPollMessageId(pollId, messageId, chatId) {
  await query(
    `UPDATE employee_votes_polls SET telegram_message_id = $1, telegram_chat_id = $2 WHERE id = $3`,
    [messageId, chatId, pollId]
  );
}

async function getActivePoll() {
  const res = await query(
    `SELECT * FROM employee_votes_polls WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  return res.rows[0] || null;
}

async function getAllPolls() {
  const res = await query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM employee_votes v WHERE v.poll_id = p.id)::int AS total_votes,
            (SELECT COUNT(*) FROM employee_votes_options o WHERE o.poll_id = p.id)::int AS option_count
     FROM employee_votes_polls p
     ORDER BY p.created_at DESC`
  );
  return res.rows;
}

async function getPollOptions(pollId) {
  const res = await query(
    `SELECT * FROM employee_votes_options WHERE poll_id = $1 ORDER BY unit_number`,
    [pollId]
  );
  return res.rows;
}

async function getOptionByPollAndUnit(pollId, unitNumber) {
  const res = await query(
    `SELECT * FROM employee_votes_options WHERE poll_id = $1 AND unit_number = $2`,
    [pollId, unitNumber]
  );
  return res.rows[0] || null;
}

// ─── Votes ───

async function castVote(pollId, optionId, telegramUserId, username, firstName, unitNumber) {
  try {
    const res = await query(
      `INSERT INTO employee_votes (poll_id, option_id, telegram_user_id, telegram_username, telegram_first_name, unit_number)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [pollId, optionId, telegramUserId, username, firstName, unitNumber]
    );
    console.log(`[VOTING] Vote recorded: user=${telegramUserId}, unit=${unitNumber}`);
    return { success: true, vote: res.rows[0] };
  } catch (err) {
    if (err.code === '23505') {
      // Unique constraint violation — already voted
      return { success: false, reason: 'already_voted' };
    }
    throw err;
  }
}

async function closePoll(pollId) {
  await query(`UPDATE employee_votes_polls SET status = 'closed' WHERE id = $1`, [pollId]);
  console.log(`[VOTING] Poll ${pollId} closed.`);
}

async function resetPoll(pollId) {
  await query(`DELETE FROM employee_votes WHERE poll_id = $1`, [pollId]);
  console.log(`[VOTING] All votes reset for poll ${pollId}.`);
}

async function getPollResults(pollId) {
  const res = await query(
    `SELECT o.id, o.unit_number, o.driver_name, o.company_name, o.driver_type,
            COUNT(v.id)::int AS vote_count
     FROM employee_votes_options o
     LEFT JOIN employee_votes v ON v.option_id = o.id
     WHERE o.poll_id = $1
     GROUP BY o.id
     ORDER BY vote_count DESC, o.unit_number ASC`,
    [pollId]
  );

  const totalVotes = res.rows.reduce((sum, r) => sum + r.vote_count, 0);
  return res.rows.map(r => ({
    ...r,
    percentage: totalVotes > 0 ? Math.round((r.vote_count / totalVotes) * 100) : 0,
    total_votes: totalVotes,
  }));
}

async function getPollVoters(pollId) {
  const res = await query(
    `SELECT v.telegram_user_id, v.telegram_username, v.telegram_first_name,
            v.unit_number, v.created_at
     FROM employee_votes v
     WHERE v.poll_id = $1
     ORDER BY v.created_at DESC`,
    [pollId]
  );
  return res.rows;
}

module.exports = {
  extractUnitFromGroupName,
  parseGroupName,
  getDriverUnitsFromGroups,
  createPoll,
  setPollMessageId,
  getActivePoll,
  getAllPolls,
  getPollOptions,
  getOptionByPollAndUnit,
  castVote,
  closePoll,
  resetPoll,
  getPollResults,
  getPollVoters,
};
