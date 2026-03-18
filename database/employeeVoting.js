/**
 * Employee Voting — Database helpers (fully isolated from driver survey system)
 */
const { pool, query } = require('./db');

// ─── Unit / Driver Extraction ───

/**
 * Extract unit number from group name.
 * Tries multiple patterns in priority order:
 *   1. "UNIT #800"  / "UNIT # 800"  / "UNIT#800"   (standard)
 *   2. "#800"       / "# 800"                       (hash without UNIT prefix)
 *   3. "UNIT 800"                                   (UNIT without hash)
 */
function extractUnitFromGroupName(name) {
  if (!name) return null;

  // 1. Standard: UNIT #NNN
  const m1 = name.match(/UNIT\s*#\s*(\d+)/i);
  if (m1) return m1[1];

  // 2. Fallback: #NNN anywhere in the name
  const m2 = name.match(/#\s*(\d+)/);
  if (m2) return m2[1];

  // 3. Fallback: UNIT followed by a number (no #)
  const m3 = name.match(/UNIT\s+(\d+)/i);
  if (m3) return m3[1];

  return null;
}

/**
 * Parse driver details from group name.
 * Handles variations:
 *   "WENZE UNIT #800 DILSHOD URINOV"                       → { company: "WENZE", driver: "DILSHOD URINOV", type: null }
 *   "WENZE UNIT #2614 EMANUEL ENNIS (COMPANY DRIVERS)"     → { company: "WENZE", driver: "EMANUEL ENNIS", type: "COMPANY DRIVERS" }
 *   "WENZE #800 DILSHOD URINOV"                            → { company: "WENZE", driver: "DILSHOD URINOV", type: null }
 */
function parseGroupName(name) {
  if (!name) return { company: null, driver: null, type: null };

  // Extract type from parentheses if present
  let type = null;
  let cleaned = name;
  const parenMatch = name.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    type = parenMatch[1].trim();
    cleaned = name.replace(/\([^)]+\)\s*$/, '').trim();
  }

  // Pattern 1: COMPANY UNIT #NNN DRIVER NAME
  const p1 = cleaned.match(/^(.+?)\s+UNIT\s*#\s*\d+\s+(.+)$/i);
  if (p1) return { company: p1[1].trim(), driver: p1[2].trim(), type };

  // Pattern 2: COMPANY #NNN DRIVER NAME
  const p2 = cleaned.match(/^(.+?)\s+#\s*\d+\s+(.+)$/i);
  if (p2) return { company: p2[1].trim(), driver: p2[2].trim(), type };

  // Pattern 3: COMPANY UNIT NNN DRIVER NAME (no #)
  const p3 = cleaned.match(/^(.+?)\s+UNIT\s+\d+\s+(.+)$/i);
  if (p3) return { company: p3[1].trim(), driver: p3[2].trim(), type };

  return { company: null, driver: null, type };
}

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

  const usedUnits = new Set();
  return units.map(u => {
    const isDuplicate = countByUnit[u.unit_number] > 1;
    const isCompanyDriver = u.driver_type && /company/i.test(u.driver_type);
    let finalUnit = u.unit_number;

    if (isDuplicate && isCompanyDriver && !usedUnits.has(u.unit_number)) {
      // First occurrence is company driver — let the non-company one take the plain number
      // Mark this one with (C) suffix
      finalUnit = `${u.unit_number}(C)`;
    } else if (isDuplicate && !isCompanyDriver && usedUnits.has(u.unit_number)) {
      // Non-company driver but unit already used — skip (shouldn't happen with data pattern)
      return null;
    } else if (isDuplicate && isCompanyDriver && usedUnits.has(u.unit_number)) {
      finalUnit = `${u.unit_number}(C)`;
    }

    if (usedUnits.has(finalUnit)) return null; // true duplicate, skip
    usedUnits.add(finalUnit);
    usedUnits.add(u.unit_number); // mark base unit as seen too

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
