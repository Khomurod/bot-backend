/**
 * Deciding whether a driver-group post is a fuel-stop assignment.
 *
 * Runs only AFTER the pure filters in ./textRules.js have failed to resolve the
 * post, so most messages never reach the model. Fails soft: an AI error means
 * "not a fuel stop", never a thrown error into the message pipeline.
 *
 * Split out of services/fuelStopAlertService.js, which re-exports this.
 */
const { callGeminiJson } = require('../geminiClient');
const { geocodePlace } = require('../etaRoutingService');
const { normalizeText, messageText, messageHasFuelHeader, extractStationFromText } = require('./textRules');

/**
 * Detect a fuel-stop instruction in a Telegram message.
 * Returns { latitude, longitude, stationName, stationAddress } or null.
 * Gated on the FUEL MONITORING DEPARTMENT header so load-location updates,
 * plain chatter, and stray location pins are ignored. No DB writes.
 */
async function detectStationFromMessage(message) {
  if (!message) return null;

  // SOLE GATE: must start with the Fuel Monitoring Department banner.
  const text = messageText(message);
  if (!messageHasFuelHeader(text)) return null;

  // AI confirm + extract the station name and address (best effort).
  let stationName = null;
  let address = null;
  try {
    const { parsed } = await callGeminiJson({
      systemText:
        'You read fuel-stop instructions posted by a Fuel Monitoring Department in a truck '
        + 'driver\'s group. Extract the fuel station name and its full street address.',
      userText:
        `Message:\n"""${text.slice(0, 1200)}"""\n\n`
        + 'Respond ONLY with JSON: '
        + '{"station_name": string, "address": string}. Use empty strings if unknown.',
      maxOutputTokens: 200,
      validateParsed: (p) => p && typeof p === 'object',
    });
    stationName = normalizeText(parsed?.station_name) || null;
    address = normalizeText(parsed?.address) || null;
  } catch (err) {
    // AI unavailable / quota — fall through to regex extraction.
    console.warn('[FUEL-ALERT] AI extraction failed, using regex fallback:', err.message);
  }

  // Regex fallback when AI gave nothing usable.
  if (!address || !stationName) {
    const extracted = extractStationFromText(text);
    if (!address) address = extracted.address;
    if (!stationName) stationName = extracted.stationName || null;
  }
  if (!address) {
    console.warn('[FUEL-ALERT] Fuel header found but no address could be extracted.');
    return null;
  }

  // Geocode the address to coordinates (free Nominatim/Photon, optional Google).
  const geo = await geocodePlace(address).catch(() => null);
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) {
    console.warn(`[FUEL-ALERT] Could not geocode fuel address: "${address.slice(0, 120)}"`);
    return null;
  }
  return {
    latitude: geo.latitude,
    longitude: geo.longitude,
    stationName,
    stationAddress: address,
  };
}

module.exports = {
  detectStationFromMessage,
};
