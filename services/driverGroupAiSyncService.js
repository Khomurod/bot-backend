const db = require('../database/db');
const driverProfileAiParser = require('./driverProfileAiParser');
const { classifyDriverGroups } = require('./groupStatusAiClassifier');

function isManualField(source, value) {
  return source === 'manual' && value != null && String(value).trim() !== '';
}

function hasSlashSeparatedName(groupName) {
  return /\//.test(String(groupName || ''));
}

function buildConfidence({ parsedSource, missingCoreFields, ambiguousTeam }) {
  if (missingCoreFields) return parsedSource === 'ai' ? 72 : 60;
  if (ambiguousTeam) return parsedSource === 'ai' ? 80 : 68;
  return parsedSource === 'ai' ? 95 : 82;
}

function mergeIdentityPatch(profile, parsed) {
  const patch = {};
  const changedFields = [];
  const sourceValue = parsed.source === 'ai' ? 'ai' : 'bot';

  for (const [field, sourceField] of [
    ['first_name', 'first_name_source'],
    ['last_name', 'last_name_source'],
    ['secondary_first_name', 'secondary_first_name_source'],
    ['secondary_last_name', 'secondary_last_name_source'],
    ['driver_type', 'driver_type_source'],
    ['unit_number', 'unit_number_source'],
  ]) {
    const proposed = parsed[field] || null;
    const current = profile[field] || null;
    if (isManualField(profile[sourceField], current)) continue;
    if (proposed === current) continue;
    if (proposed == null && current == null) continue;
    patch[field] = proposed;
    patch[sourceField] = proposed ? sourceValue : profile[sourceField] || null;
    changedFields.push(field);
  }

  const missingCoreFields = !(patch.first_name ?? profile.first_name) || !(patch.unit_number ?? profile.unit_number);
  const ambiguousTeam = hasSlashSeparatedName(profile.group_name)
    && !((patch.secondary_first_name ?? profile.secondary_first_name) || (patch.secondary_last_name ?? profile.secondary_last_name));

  patch.needs_review = missingCoreFields || ambiguousTeam;
  patch.backfill_confidence = buildConfidence({
    parsedSource: parsed.source,
    missingCoreFields,
    ambiguousTeam,
  });

  return { patch, changedFields };
}

async function runUnifiedDriverGroupAiSync({ apply = true } = {}) {
  const profiles = await db.listDriverProfiles({ includeInactive: true });
  const groups = profiles.map((profile) => ({
    id: profile.group_id,
    group_name: profile.group_name,
    active: profile.group_active !== false,
    status_source: profile.status_source || null,
  }));

  const [parsedRows, classificationMap] = await Promise.all([
    driverProfileAiParser.parseGroups(groups),
    classifyDriverGroups(groups, 25).catch((err) => {
      console.warn('[DRIVER-GROUP-AI-SYNC] Status classification failed:', err.message);
      return new Map();
    }),
  ]);

  const parsedByGroupId = new Map(parsedRows.map((row) => [Number(row.group_id), row]));
  const proposals = [];
  let updated = 0;

  for (const profile of profiles) {
    const parsed = parsedByGroupId.get(Number(profile.group_id)) || {
      group_id: profile.group_id,
      group_name: profile.group_name || '',
      first_name: profile.first_name || null,
      last_name: profile.last_name || null,
      secondary_first_name: profile.secondary_first_name || null,
      secondary_last_name: profile.secondary_last_name || null,
      driver_type: profile.driver_type || 'owner',
      unit_number: profile.unit_number || null,
      source: 'fallback',
    };
    const classification = classificationMap.get(Number(profile.group_id)) || null;
    const { patch, changedFields } = mergeIdentityPatch(profile, parsed);
    const nextStatus = classification?.active === false ? 'inactive' : 'active';
    const statusLocked = profile.status_source === 'manual';
    const statusChanged = !statusLocked && (profile.status || 'active') !== nextStatus;
    const reviewChanged = (profile.needs_review === true) !== (patch.needs_review === true)
      || (profile.backfill_confidence ?? null) !== (patch.backfill_confidence ?? null);

    if (statusChanged) {
      patch.status = nextStatus;
    }

    const proposal = {
      group_id: profile.group_id,
      profile_id: profile.id,
      group_name: profile.group_name,
      current: {
        first_name: profile.first_name || null,
        last_name: profile.last_name || null,
        secondary_first_name: profile.secondary_first_name || null,
        secondary_last_name: profile.secondary_last_name || null,
        driver_type: profile.driver_type || 'owner',
        unit_number: profile.unit_number || null,
        status: profile.status || 'active',
      },
      proposed: {
        first_name: patch.first_name ?? profile.first_name ?? null,
        last_name: patch.last_name ?? profile.last_name ?? null,
        secondary_first_name: patch.secondary_first_name ?? profile.secondary_first_name ?? null,
        secondary_last_name: patch.secondary_last_name ?? profile.secondary_last_name ?? null,
        driver_type: patch.driver_type ?? profile.driver_type ?? 'owner',
        unit_number: patch.unit_number ?? profile.unit_number ?? null,
        status: statusLocked ? (profile.status || 'active') : nextStatus,
      },
      changed_fields: [...changedFields, ...(statusChanged ? ['status'] : [])],
      parsed_source: parsed.source,
      status_source: statusLocked ? 'manual_locked' : (classification ? 'ai' : 'unchanged'),
      needs_review: patch.needs_review === true,
      backfill_confidence: patch.backfill_confidence,
      changed: changedFields.length > 0 || statusChanged || reviewChanged,
    };
    proposals.push(proposal);

    if (!apply || !proposal.changed) continue;
    await db.updateDriverProfile(profile.id, patch, {
      groupStatusSource: statusChanged ? 'ai' : null,
    });
    updated += 1;
  }

  return {
    applied: apply,
    total: proposals.length,
    updated,
    proposals,
  };
}

module.exports = {
  mergeIdentityPatch,
  runUnifiedDriverGroupAiSync,
};
