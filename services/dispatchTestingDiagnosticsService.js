const config = require('../config/config');
const db = require('../database/db');
const { readLoadContextWithFallbacks, choosePinnedMessageCandidate } = require('./dispatchPinnedContextService');
const { calculateEtaToDestination } = require('./etaRoutingService');
const { resolveLiveLocationForGroupTitle } = require('./liveLocationResolver');
const { getLiveLocationForGroupTitle } = require('./samsaraLocationService');
const { getLiveLocationForGroupTitleFromEvo } = require('./evoEldService');
const { getLiveLocationForGroupTitleFromTt } = require('./ttEldService');

function normalizeErrorMessage(err) {
  return String(err?.message || 'Unknown error').replace(/\s+/g, ' ').trim();
}

function safePreview(text, limit = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function toProviderStatus(label, location, error) {
  if (location) {
    return {
      label,
      connected: true,
      status: 'Connected',
      address: location.address || '',
      pingAgeMinutes: location.pingAgeMinutes ?? null,
      vehicleName: location.vehicleName || '',
      unitNumber: location.unitNumber || '',
    };
  }

  return {
    label,
    connected: false,
    status: 'Not Connected',
    error: error ? normalizeErrorMessage(error) : '',
  };
}

async function checkProviderStatuses(groupTitle) {
  const providerStatuses = [];

  let samsaraLocation = null;
  let samsaraError = null;
  const samsaraKeys = Array.from(
    new Set([
      ...(Array.isArray(config.samsaraApiKeys) ? config.samsaraApiKeys : []),
      config.samsaraApiKey,
    ].filter(Boolean))
  );

  if (!samsaraKeys.length) {
    samsaraError = new Error('Samsara API key is not configured.');
  } else {
    for (const apiKey of samsaraKeys) {
      try {
        samsaraLocation = await getLiveLocationForGroupTitle({
          groupTitle,
          apiKey,
          apiBase: config.samsaraApiBase,
        });
        if (samsaraLocation) break;
      } catch (err) {
        samsaraError = err;
      }
    }
  }

  providerStatuses.push(toProviderStatus('Samsara', samsaraLocation, samsaraError));

  let evoLocation = null;
  let evoError = null;
  try {
    evoLocation = await getLiveLocationForGroupTitleFromEvo({
      groupTitle,
      usdotNumber: config.evoEldUsdotNumber,
      apiKey: config.evoEldApiKey,
      providerToken: config.evoEldProviderToken,
      apiBase: config.evoEldApiBase,
    });
  } catch (err) {
    evoError = err;
  }
  providerStatuses.push(toProviderStatus('EVO ELD', evoLocation, evoError));

  let ttLocation = null;
  let ttError = null;
  const ttApiKeys = Array.from(new Set([config.ttEldApiKey, config.evoEldApiKey].filter(Boolean)));
  if (!ttApiKeys.length) {
    ttError = new Error('TT ELD API key is not configured.');
  } else {
    for (const apiKey of ttApiKeys) {
      try {
        ttLocation = await getLiveLocationForGroupTitleFromTt({
          groupTitle,
          usdotNumber: config.ttEldUsdotNumber,
          apiKey,
          providerToken: config.ttEldProviderToken,
          apiBase: config.ttEldApiBase,
        });
        if (ttLocation) break;
      } catch (err) {
        ttError = err;
      }
    }
  }
  providerStatuses.push(toProviderStatus('TT ELD', ttLocation, ttError));

  return providerStatuses;
}

async function buildPinnedSection({ telegram, group }) {
  let chatPinnedMessage = null;
  let snapshotPinnedMessage = null;
  let snapshotSourceEventAt = null;
  let pinnedSource = 'none';

  try {
    const chat = await telegram.getChat(group.telegram_group_id);
    chatPinnedMessage = chat?.pinned_message || null;
  } catch {
    // best effort; detailed error still comes from readPinnedLoadContext if needed
  }

  try {
    const snapshot = await db.getGroupPinnedMessageSnapshot(group.id);
    snapshotPinnedMessage = snapshot?.pinned_message_json || null;
    snapshotSourceEventAt = snapshot?.source_event_at || null;
  } catch {
    // optional diagnostics path only
  }

  const pinnedMessage = choosePinnedMessageCandidate({
    chatPinnedMessage,
    snapshotPinnedMessage,
    snapshotSourceEventAt,
  });

  if (pinnedMessage) {
    if (snapshotPinnedMessage && snapshotPinnedMessage.message_id === pinnedMessage.message_id) {
      pinnedSource = 'snapshot';
    } else {
      pinnedSource = 'chat';
    }
  }

  const section = {
    available: Boolean(pinnedMessage),
    pinnedMessageId: pinnedMessage?.message_id || null,
    pinnedMessageDate: pinnedMessage?.date ? new Date(pinnedMessage.date * 1000).toISOString() : null,
    source: pinnedSource,
    preview: safePreview([pinnedMessage?.text, pinnedMessage?.caption].filter(Boolean).join('\n')),
    pickupSummary: '',
    deliverySummary: '',
    destinationQuery: '',
    parseModel: '',
    parseError: '',
  };

  try {
    const context = await readLoadContextWithFallbacks({
      telegram,
      chatId: group.telegram_group_id,
      groupId: group.id,
      previousSignature: '',
      cachedDestinationQuery: '',
      cachedPickup: '',
      cachedDelivery: '',
    });

    section.pickupSummary = context.pickupSummary || '';
    section.deliverySummary = context.deliverySummary || '';
    section.destinationQuery = context.destinationQuery || '';
    section.parseModel = context.aiModel || '';
    if (!pinnedMessage) {
      section.source = context.source || section.source;
      section.preview = section.preview || safePreview(context.pinnedText || '');
    }
  } catch (err) {
    section.parseError = normalizeErrorMessage(err);
  }

  return section;
}

function buildLocationSection(locationResult, error) {
  if (!locationResult?.location) {
    return {
      available: false,
      source: '',
      error: normalizeErrorMessage(error),
      latitude: null,
      longitude: null,
      address: '',
      pingAgeMinutes: null,
      speedMilesPerHour: null,
      unitNumber: '',
      vehicleName: '',
    };
  }

  const location = locationResult.location;
  return {
    available: true,
    source: locationResult.source || '',
    error: '',
    latitude: Number.isFinite(location.latitude) ? location.latitude : null,
    longitude: Number.isFinite(location.longitude) ? location.longitude : null,
    address: location.address || '',
    pingAgeMinutes: location.pingAgeMinutes ?? null,
    speedMilesPerHour: location.speedMilesPerHour ?? null,
    unitNumber: location.unitNumber || '',
    vehicleName: location.vehicleName || '',
  };
}

function buildEtaSection(eta, error) {
  if (!eta) {
    return {
      available: false,
      error: normalizeErrorMessage(error),
      remainingMiles: null,
      etaMinutes: null,
      etaChicagoLabel: '',
      destinationDisplayName: '',
    };
  }

  return {
    available: true,
    error: '',
    remainingMiles: eta.remainingMiles ?? null,
    etaMinutes: eta.etaMinutes ?? null,
    etaChicagoLabel: eta.etaChicagoLabel || '',
    destinationDisplayName: eta.destination?.displayName || '',
  };
}

function mapSetting(settingRow) {
  const interval = Number(settingRow?.interval_minutes || 60) || 60;
  return {
    enabled: Boolean(settingRow?.enabled),
    intervalMinutes: interval,
    intervalHours: Math.floor(interval / 60),
    intervalRemainingMinutes: interval % 60,
    nextRunAt: settingRow?.next_run_at || null,
    lastRunAt: settingRow?.last_run_at || null,
    lastStatus: settingRow?.last_status || null,
    lastError: settingRow?.last_error || null,
  };
}

async function buildDispatchTestingGroupDetails({ telegram, groupId }) {
  const groupRows = await db.getGroupsByIds([groupId]);
  const group = groupRows[0];
  if (!group) {
    const err = new Error('Active driver group not found');
    err.status = 404;
    throw err;
  }

  const liveGroupTitle = String(group.group_name || '').trim();
  const [settingRow, pinned, providerStatuses] = await Promise.all([
    db.getDispatchEtaSettingByGroupId(groupId),
    buildPinnedSection({ telegram, group }),
    checkProviderStatuses(liveGroupTitle),
  ]);

  let resolvedLocation = null;
  let locationError = null;
  try {
    resolvedLocation = await resolveLiveLocationForGroupTitle(liveGroupTitle);
  } catch (err) {
    locationError = err;
  }

  let eta = null;
  let etaError = null;
  if (resolvedLocation?.location && pinned.destinationQuery) {
    try {
      eta = await calculateEtaToDestination({
        currentLatitude: resolvedLocation.location.latitude,
        currentLongitude: resolvedLocation.location.longitude,
        destinationQuery: pinned.destinationQuery,
      });
      if (!eta) {
        etaError = new Error('Could not calculate route ETA with current destination/location.');
      }
    } catch (err) {
      etaError = err;
    }
  } else if (!pinned.destinationQuery) {
    etaError = new Error('No delivery destination found in pinned load context.');
  } else if (!resolvedLocation?.location) {
    etaError = new Error('No live location available from providers right now.');
  }

  return {
    group: {
      id: group.id,
      groupName: group.group_name,
      telegramGroupId: group.telegram_group_id,
    },
    pinned,
    location: buildLocationSection(resolvedLocation, locationError),
    providers: providerStatuses,
    eta: buildEtaSection(eta, etaError),
    settings: mapSetting(settingRow),
  };
}

module.exports = {
  buildDispatchTestingGroupDetails,
};
