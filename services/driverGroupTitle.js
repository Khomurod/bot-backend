/**
 * Parse driver names from Telegram group titles and fleet vehicle labels,
 * and compare them for assignment validation.
 */

function normalizePersonName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizePersonName(value) {
  return normalizePersonName(value)
    .split(' ')
    .filter((t) => t.length >= 2);
}

/**
 * e.g. "WENZE UNIT # 2908 TESFAMARIAM YOSIEF (COMPANY DRIVER)" → "TESFAMARIAM YOSIEF"
 */
function extractDriverNameFromGroupTitle(groupTitle) {
  const raw = String(groupTitle || '').trim();
  if (!raw) return '';

  const stripped = raw
    .replace(/^.*?(UNIT\s*#?\s*\d+|#\s*\d+)\s+/i, '')
    .replace(/\(.*?\)/g, '')
    .trim();

  if (!stripped || stripped === raw) {
    const withoutPrefix = raw.replace(/^WENZE\s+/i, '').trim();
    const unitMatch = withoutPrefix.match(/^(?:UNIT\s*#?\s*)?\d+\s+(.+)$/i);
    if (unitMatch) {
      return unitMatch[1].replace(/\(.*?\)/g, '').trim();
    }
    return '';
  }
  return stripped;
}

/**
 * e.g. vehicle "2908 NIKE AUGUSTE", unit "2908" → "NIKE AUGUSTE"
 */
function extractDriverNameFromVehicleLabel(vehicleName, unitNumber) {
  let label = String(vehicleName || '').trim();
  if (!label) return '';

  const unit = String(unitNumber || '').replace(/\D/g, '');
  if (unit) {
    const unitNorm = unit.replace(/^0+(?=\d)/, '');
    const patterns = [
      new RegExp(`^#?\\s*0*${unitNorm}\\b\\s*`, 'i'),
      new RegExp(`^UNIT\\s*#?\\s*0*${unitNorm}\\b\\s*`, 'i'),
      new RegExp(`^0*${unitNorm}\\b\\s*`, 'i'),
    ];
    for (const pattern of patterns) {
      if (pattern.test(label)) {
        label = label.replace(pattern, '').trim();
        break;
      }
    }
  }

  return label.replace(/\(.*?\)/g, '').trim();
}

function driverNamesMatch(expected, actual) {
  const a = normalizePersonName(expected);
  const b = normalizePersonName(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const tokensA = tokenizePersonName(a);
  const tokensB = tokenizePersonName(b);
  if (!tokensA.length || !tokensB.length) return false;

  const shared = tokensA.filter((t) => tokensB.includes(t) && t.length >= 3);
  if (shared.length >= 2) return true;

  const lastA = tokensA[tokensA.length - 1];
  const lastB = tokensB[tokensB.length - 1];
  if (lastA && lastB && lastA.length >= 3 && lastA === lastB) {
    return tokensA[0] === tokensB[0] || shared.length >= 1;
  }

  return false;
}

function scoreVehicleNameMatch(groupDriver, vehicleName) {
  const expected = normalizePersonName(groupDriver);
  const actual = normalizePersonName(vehicleName);
  if (!expected || !actual) return 0;
  if (expected === actual) return 100;
  if (actual.includes(expected) || expected.includes(actual)) return 80;

  const tokensA = tokenizePersonName(expected);
  const tokensB = tokenizePersonName(actual);
  const shared = tokensA.filter((t) => tokensB.includes(t) && t.length >= 3);
  return shared.length * 25;
}

function isLocationDriverNameStrict() {
  return String(process.env.LOCATION_DRIVER_NAME_STRICT || '').toLowerCase() === 'true';
}

/**
 * Plain-text lines for /location reply (after map pin).
 */
function buildLocationSummaryLines({ location, source }) {
  const lines = [`Source: ${source}`, `Unit: ${location.unitNumber}`];

  if (location.assignedDriverName) {
    lines.push(`Driver (group): ${location.assignedDriverName}`);
  }

  const isSamsara = String(source || '').toLowerCase().includes('samsara');
  if (isSamsara && location.vehicleName) {
    lines.push(`Fleet label (Samsara): ${location.vehicleName}`);
  } else if (location.vehicleName) {
    lines.push(`Vehicle: ${location.vehicleName}`);
  }

  if (location.address) {
    lines.push(`Address: ${location.address}`);
  }

  const pingAgeText = location.pingAgeMinutes == null
    ? 'unknown'
    : `${location.pingAgeMinutes} min ago`;
  lines.push(
    `Last ping: ${pingAgeText}${location.pingTimeIso ? ` (${location.pingTimeIso})` : ''}`
  );

  const speedText = location.speedMilesPerHour == null
    ? 'unknown'
    : `${location.speedMilesPerHour.toFixed(1)} mph`;
  lines.push(`Speed: ${speedText}`);

  if (location.driverNameMismatch) {
    const staleName = location.providerDriverName || location.vehicleName || 'unknown';
    lines.push(
      `Warning: Samsara still lists "${staleName}". Update the vehicle name in Samsara or confirm truck assignment.`
    );
  }

  return lines;
}

function buildStrictMismatchBlockMessage(location) {
  const staleName = location.providerDriverName || location.vehicleName || 'unknown';
  const assigned = location.assignedDriverName || 'unknown';
  return (
    `Location not sent: group driver is "${assigned}" but Samsara lists "${staleName}" for unit ${location.unitNumber}. `
    + 'Rename the vehicle in Samsara to match the current driver, or set LOCATION_DRIVER_NAME_STRICT=false.'
  );
}

function evaluateDriverNameAssignment({ groupTitle, vehicleName, unitNumber }) {
  const assignedDriverName = extractDriverNameFromGroupTitle(groupTitle);
  const providerDriverName = extractDriverNameFromVehicleLabel(vehicleName, unitNumber);
  const driverNameMismatch = Boolean(
    assignedDriverName
    && providerDriverName
    && !driverNamesMatch(assignedDriverName, providerDriverName)
  );
  return {
    assignedDriverName,
    providerDriverName,
    driverNameMismatch,
  };
}

module.exports = {
  normalizePersonName,
  tokenizePersonName,
  extractDriverNameFromGroupTitle,
  extractDriverNameFromVehicleLabel,
  driverNamesMatch,
  scoreVehicleNameMatch,
  isLocationDriverNameStrict,
  buildLocationSummaryLines,
  buildStrictMismatchBlockMessage,
  evaluateDriverNameAssignment,
};
