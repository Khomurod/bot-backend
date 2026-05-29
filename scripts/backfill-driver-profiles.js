#!/usr/bin/env node
/**
 * Backfill driver_profiles from existing groups data.
 *
 * Usage:
 *   node scripts/backfill-driver-profiles.js
 *   node scripts/backfill-driver-profiles.js --dry-run
 */
const db = require('../database/db');
const {
  extractUnitFromGroupName,
  parseGroupName,
} = require('../services/driverGroupTitle');

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    dryRun: args.has('--dry-run'),
  };
}

function normalizeLanguage(language) {
  if (language === 'ru' || language === 'uz' || language === 'en') return language;
  return 'en';
}

function splitName(fullName) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { firstName: null, lastName: null };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: null };
  return {
    firstName: tokens[0],
    lastName: tokens.slice(1).join(' '),
  };
}

function inferDriverType(groupTypeSuffix, groupName) {
  const raw = `${groupTypeSuffix || ''} ${groupName || ''}`.toLowerCase();
  if (raw.includes('company driver')) return 'company_driver';
  if (raw.includes('owner')) return 'owner';
  return null;
}

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildProfileRow(group) {
  const parsed = parseGroupName(group.group_name || '');
  const fullName = parsed.driver || '';
  const { firstName, lastName } = splitName(fullName);
  const unitNumber = extractUnitFromGroupName(group.group_name || '');
  const inferredType = inferDriverType(parsed.type, group.group_name);
  const driverType = inferredType || 'owner';

  let confidence = 100;
  let needsReview = false;
  const issues = [];

  if (!firstName) {
    needsReview = true;
    confidence -= 35;
    issues.push('missing_first_name');
  }
  if (!lastName) {
    confidence -= 15;
    issues.push('missing_last_name');
  }
  if (!unitNumber) {
    needsReview = true;
    confidence -= 40;
    issues.push('missing_unit_number');
  }
  if (!inferredType) {
    needsReview = true;
    confidence -= 20;
    issues.push('inferred_driver_type_defaulted_to_owner');
  }
  if (!group.language || normalizeLanguage(group.language) !== group.language) {
    confidence -= 10;
    issues.push('language_defaulted_to_en');
  }

  return {
    group_id: group.id,
    first_name: firstName,
    last_name: lastName,
    driver_type: driverType,
    status: group.active === false ? 'inactive' : 'active',
    unit_number: unitNumber,
    language: normalizeLanguage(group.language),
    date_of_birth: toIsoDate(group.driver_birthday),
    date_of_start: toIsoDate(group.created_at),
    needs_review: needsReview,
    backfill_confidence: Math.max(0, confidence),
    issues,
  };
}

async function upsertProfile(profile) {
  await db.query(
    `INSERT INTO driver_profiles (
       group_id, first_name, last_name, driver_type, status, unit_number,
       language, date_of_birth, date_of_start, needs_review, backfill_confidence,
       created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       NOW(), NOW()
     )
     ON CONFLICT (group_id)
     DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       driver_type = EXCLUDED.driver_type,
       status = EXCLUDED.status,
       unit_number = EXCLUDED.unit_number,
       language = EXCLUDED.language,
       date_of_birth = EXCLUDED.date_of_birth,
       date_of_start = EXCLUDED.date_of_start,
       needs_review = EXCLUDED.needs_review,
       backfill_confidence = EXCLUDED.backfill_confidence,
       updated_at = NOW()`,
    [
      profile.group_id,
      profile.first_name,
      profile.last_name,
      profile.driver_type,
      profile.status,
      profile.unit_number,
      profile.language,
      profile.date_of_birth,
      profile.date_of_start,
      profile.needs_review,
      profile.backfill_confidence,
    ]
  );
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const result = await db.query(
    `SELECT id, group_name, language, active, driver_birthday, created_at
     FROM groups
     WHERE group_type = 'driver'
     ORDER BY id ASC`
  );

  const groups = result.rows || [];
  const report = {
    dry_run: dryRun,
    total_groups: groups.length,
    upserted: 0,
    needs_review: 0,
    unresolved: [],
  };

  for (const group of groups) {
    const profile = buildProfileRow(group);
    if (profile.needs_review) {
      report.needs_review += 1;
      report.unresolved.push({
        group_id: group.id,
        group_name: group.group_name,
        issues: profile.issues,
      });
    }
    if (!dryRun) {
      await upsertProfile(profile);
      report.upserted += 1;
    }
  }

  console.log('[BACKFILL] driver_profiles complete');
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error('[BACKFILL] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch (_) {
      // ignore
    }
  });
