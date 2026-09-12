/**
 * Recording which Telegram account belongs to a driver.
 *
 *   identity.link_telegram   the one person in a driver's chat, whose name
 *                            matches the driver, becomes that person's account.
 *
 * TWO RULES CARRIED FROM THE REST OF THE REGISTRY, and one that is specific.
 *
 * IT RE-RUNS THE DECISION. The sweep saw the room fifteen minutes ago; somebody
 * may have joined since, which turns "the only candidate" into a question. The
 * apply re-reads the members under lock and refuses unless the answer is still
 * `link` and still the SAME account.
 *
 * IT NEVER OVERWRITES AN ADMINISTRATOR'S CHOICE. `driver_profiles.telegram_user_id`
 * is filled in by hand, and a person who typed an account there decided
 * something. This fills that column only when it is NULL — the rule
 * `database/driverProfiles.js` already follows on the profile-save path.
 *
 * THE ACCOUNT MAY ALREADY BE TAKEN. One human per account at a time is a
 * partial unique index, so the insert can lose; that is the guarantee working,
 * and it is reported as a stale correction rather than retried.
 */
const { decideTelegramLink } = require('../../../lib/identity/telegramResolution');
const { driverNameOf } = require('../checks/telegramIdentity');
const { StaleCorrectionError } = require('./evidence');
const people = require('../../../database/driverPeople');

/**
 * Re-read one chat's room from the live tables, in the shape the rule wants.
 */
async function liveDecisionFor(groupId, personId, client) {
  const g = await client.query(
    'SELECT id, group_name, group_type, active FROM groups WHERE id = $1 FOR UPDATE',
    [groupId]
  );
  const group = g.rows[0];
  if (!group) throw new StaleCorrectionError(`Group ${groupId} no longer exists.`);
  if (group.group_type !== 'driver' || group.active !== true) {
    throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver chat.`);
  }

  const association = await people.getOpenAssociationForGroup(groupId, client);
  if (!association || Number(association.personId) !== Number(personId)) {
    throw new StaleCorrectionError(`Group ${groupId} no longer belongs to person ${personId}.`);
  }

  const [profileRes, memberRes, takenRes, heldRes] = await Promise.all([
    client.query(
      `SELECT first_name, last_name, secondary_first_name, secondary_last_name, telegram_user_id
         FROM driver_profiles WHERE group_id = $1 FOR UPDATE`,
      [groupId]
    ),
    client.query(
      `SELECT m.telegram_user_id, m.first_name, m.last_name, m.username,
              u.source,
              (SELECT COUNT(*) FROM group_members m2
                 JOIN groups g2 ON g2.id = m2.group_id
                WHERE m2.telegram_user_id = m.telegram_user_id
                  AND g2.group_type = 'driver' AND g2.active = TRUE)::int AS driver_group_count
         FROM group_members m
         LEFT JOIN bot_users u ON u.telegram_user_id = m.telegram_user_id
        WHERE m.group_id = $1`,
      [groupId]
    ),
    client.query(
      'SELECT telegram_user_id FROM driver_person_telegram_identities WHERE ended_at IS NULL'
    ),
    client.query(
      `SELECT 1 FROM driver_person_telegram_identities
        WHERE person_id = $1 AND ended_at IS NULL LIMIT 1`,
      [Number(personId)]
    ),
  ]);

  const profile = profileRes.rows[0] || {};
  const taken = new Set(takenRes.rows.map((r) => String(r.telegram_user_id)));
  const members = memberRes.rows.map((m) => ({
    telegramUserId: m.telegram_user_id,
    firstName: m.first_name,
    lastName: m.last_name,
    username: m.username,
    // `group_members` records humans the bot saw; a bot is not added here, and
    // the column does not exist, so the rule's bot filter is a no-op in this
    // path and is kept for the check's snapshot shape.
    isBot: false,
    source: m.source || null,
    driverGroupCount: Number(m.driver_group_count) || 0,
    alreadyLinked: taken.has(String(m.telegram_user_id)),
  }));

  return {
    profile,
    decision: decideTelegramLink({
      driverName: driverNameOf({ ...profile, group_id: groupId }),
      members,
      isTeamChat: Boolean(profile.secondary_first_name || profile.secondary_last_name),
      alreadyLinked: heldRes.rowCount > 0,
    }),
  };
}

const linkTelegramIdentity = {
  key: 'identity.link_telegram',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Record a Telegram account as person ${p.personId}'s`,

  async apply({ groupId, personId, telegramUserId }, client) {
    if (!groupId || !personId || !telegramUserId) {
      throw new StaleCorrectionError('A group, a person and an account are all required.');
    }
    const { profile, decision } = await liveDecisionFor(groupId, personId, client);

    if (decision.action !== 'link') {
      throw new StaleCorrectionError(
        `Group ${groupId} no longer resolves to one account (${decision.reason}).`
      );
    }
    if (String(decision.telegramUserId) !== String(telegramUserId)) {
      throw new StaleCorrectionError(
        `Group ${groupId} now resolves to a different account than the one proposed.`
      );
    }

    const opened = await people.openTelegramIdentity({
      personId,
      telegramUserId,
      usernameAtLink: null,
      linkSource: 'member_resolution',
      confidence: decision.confidence,
      evidence: { groupId, candidates: decision.candidates, reason: decision.reason },
    }, client);
    if (!opened) {
      // The unique index refused: somebody else holds this account.
      throw new StaleCorrectionError('That Telegram account is already recorded to somebody else.');
    }

    // NEVER OVERWRITE AN ADMINISTRATOR'S CHOICE — only fill a blank.
    const filledProfile = profile.telegram_user_id == null;
    if (filledProfile) {
      await client.query(
        'UPDATE driver_profiles SET telegram_user_id = $2 WHERE group_id = $1 AND telegram_user_id IS NULL',
        [groupId, String(telegramUserId)]
      );
    }

    return {
      oldValues: { telegramUserId: null, profileTelegramUserId: profile.telegram_user_id ?? null },
      newValues: {
        telegramUserId: String(telegramUserId), personId: Number(personId), groupId,
        identityId: opened.id, filledProfile,
      },
      affectedRecords: [{ table: 'driver_person_telegram_identities', id: opened.id, personId }],
    };
  },

  /**
   * Close the link, and clear the profile column ONLY if this correction set it.
   */
  async revert(correction, client) {
    const identityId = correction.new_values?.identityId;
    const closed = await client.query(
      `UPDATE driver_person_telegram_identities
          SET ended_at = NOW(), ended_reason = 'correction reverted'
        WHERE id = $1 AND ended_at IS NULL
        RETURNING telegram_user_id`,
      [Number(identityId)]
    );
    if (closed.rowCount === 0) {
      throw new StaleCorrectionError('That Telegram link is no longer open.');
    }
    if (correction.new_values?.filledProfile === true) {
      await client.query(
        'UPDATE driver_profiles SET telegram_user_id = NULL WHERE group_id = $1 AND telegram_user_id = $2',
        [correction.new_values.groupId, String(correction.new_values.telegramUserId)]
      );
    }
  },
};

module.exports = { linkTelegramIdentity, liveDecisionFor };
