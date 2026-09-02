/**
 * Facebook lead AUTO-MESSAGE configuration — database helpers.
 *
 * The admin-editable auto-SMS copy and its rules, plus the one-time seeding of
 * the shipped defaults. Split out of database/facebookLeads.js, which
 * re-exports every symbol here.
 */
const { pool, query } = require('../pool');

const DEFAULT_WORKING_HOURS_TEMPLATE = (
  'Hello {first_name}, this is {rep_name} with {company_name} '
  + 'and thanks for applying to our {position}. '
  + 'Can I call you right now to explain the details?'
);

const DEFAULT_FALLBACK_TEMPLATE = (
  'Hello {first_name}, this is {rep_name} with {company_name}. '
  + 'Thanks for applying to our {position}. '
  + 'When is a good time for me to call you and explain the details?'
);

async function seedFacebookLeadAutoMessageDefaults() {
  const existing = await query(
    'SELECT id FROM facebook_lead_auto_message_settings ORDER BY id LIMIT 1'
  );
  if (existing.rows.length > 0) return;

  const settingsRes = await query(
    `INSERT INTO facebook_lead_auto_message_settings (
       timezone,
       is_enabled,
       rep_name,
       company_name,
       position_label,
       fallback_template
     )
     VALUES ($1, TRUE, $2, $3, $4, $5)
     RETURNING id`,
    [
      'America/Chicago',
      'Tom',
      'Wenze trucking company',
      'OTR position',
      DEFAULT_FALLBACK_TEMPLATE,
    ]
  );
  const settingsId = settingsRes.rows[0].id;

  await query(
    `INSERT INTO facebook_lead_auto_message_rules (
       settings_id,
       label,
       days_of_week,
       start_time_local,
       end_time_local,
       message_template,
       sort_order,
       is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE)`,
    [
      settingsId,
      'Working hours',
      [1, 2, 3, 4, 5],
      '08:00',
      '17:00',
      DEFAULT_WORKING_HOURS_TEMPLATE,
    ]
  );
  console.log('[DB] Seeded default Facebook lead auto-message settings.');
}

async function getFacebookLeadAutoMessageSettings() {
  const settingsRes = await query(
    `SELECT *
       FROM facebook_lead_auto_message_settings
      ORDER BY id
      LIMIT 1`
  );
  const settings = settingsRes.rows[0];
  if (!settings) return { settings: null, rules: [] };

  const rulesRes = await query(
    `SELECT *
       FROM facebook_lead_auto_message_rules
      WHERE settings_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [settings.id]
  );
  return { settings, rules: rulesRes.rows };
}

async function replaceFacebookLeadAutoMessageConfig({ settings, rules }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let settingsId = settings.id;
    if (settingsId) {
      await client.query(
        `UPDATE facebook_lead_auto_message_settings
            SET timezone = $1,
                is_enabled = $2,
                rep_name = $3,
                company_name = $4,
                position_label = $5,
                fallback_template = $6,
                updated_at = NOW()
          WHERE id = $7`,
        [
          settings.timezone,
          settings.is_enabled,
          settings.rep_name,
          settings.company_name,
          settings.position_label,
          settings.fallback_template,
          settingsId,
        ]
      );
    } else {
      const insertRes = await client.query(
        `INSERT INTO facebook_lead_auto_message_settings (
           timezone,
           is_enabled,
           rep_name,
           company_name,
           position_label,
           fallback_template
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          settings.timezone,
          settings.is_enabled,
          settings.rep_name,
          settings.company_name,
          settings.position_label,
          settings.fallback_template,
        ]
      );
      settingsId = insertRes.rows[0].id;
    }

    await client.query(
      'DELETE FROM facebook_lead_auto_message_rules WHERE settings_id = $1',
      [settingsId]
    );

    const insertedRules = [];
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      const res = await client.query(
        `INSERT INTO facebook_lead_auto_message_rules (
           settings_id,
           label,
           days_of_week,
           start_time_local,
           end_time_local,
           message_template,
           sort_order,
           is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          settingsId,
          rule.label,
          rule.days_of_week,
          rule.start_time_local,
          rule.end_time_local,
          rule.message_template,
          rule.sort_order ?? i,
          rule.is_active !== false,
        ]
      );
      insertedRules.push(res.rows[0]);
    }

    const settingsRow = await client.query(
      'SELECT * FROM facebook_lead_auto_message_settings WHERE id = $1',
      [settingsId]
    );

    await client.query('COMMIT');
    return { settings: settingsRow.rows[0], rules: insertedRules };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  seedFacebookLeadAutoMessageDefaults,
  getFacebookLeadAutoMessageSettings,
  replaceFacebookLeadAutoMessageConfig,
};
