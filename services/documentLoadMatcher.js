/**
 * Match a driver-sent BOL/POD document batch to the correct Datatruck load.
 *
 * Signals combined (as available):
 *   - driver group → driver profile (name, unit)
 *   - the driver's active Datatruck order (by group / unit / name)
 *   - load number(s) and addresses read off the document by the AI classifier
 *   - the driver's live GPS: near pickup → likely BOL, near delivery → likely POD
 *
 * Output confidence tiers (never uploads on its own — the caller always asks a
 * human, and low/mismatch/none are surfaced as warnings):
 *   high     – document load number / address clearly matches the current load
 *   medium   – driver/unit/current load matches, no conflict
 *   low      – only a weak driver match (or a stage/type contradiction)
 *   mismatch – the document looks like it belongs to a DIFFERENT load
 *   none     – no load could be found
 *
 * scoreMatch is PURE (distances via an injected haversine) so the decision logic
 * is fully unit-testable; matchLoadForBatch is the thin resolver-backed wrapper.
 */
const NEAR_MILES_DEFAULT = 8;

const CONFIDENCE = Object.freeze({
  HIGH: 'high', MEDIUM: 'medium', LOW: 'low', MISMATCH: 'mismatch', NONE: 'none',
});

/** Loosely normalize a load-reference token for comparison (alnum, upper). */
function normalizeRef(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Identifier tokens carried by a resolved load. */
function loadIdentifiers(load) {
  if (!load) return [];
  return [load.loadIdentifier, load.orderId, load.shipmentId, load.load_id, load.shipment_id]
    .map(normalizeRef)
    .filter((v) => v.length >= 4);
}

/** Does any document load-number match a load identifier? Requires length ≥5 to
 * avoid coincidental short-number collisions. */
function loadNumberMatch(docNumbers, identifiers) {
  const docs = (docNumbers || []).map(normalizeRef).filter((v) => v.length >= 5);
  if (!docs.length || !identifiers.length) return { matched: false, hasDocNumbers: docs.length > 0 };
  for (const dn of docs) {
    for (const id of identifiers) {
      if (dn === id || (dn.length >= 5 && id.length >= 5 && (dn.includes(id) || id.includes(dn)))) {
        return { matched: true, hasDocNumbers: true, value: dn };
      }
    }
  }
  return { matched: false, hasDocNumbers: true };
}

/** Coarse address overlap: share a 5-digit ZIP or ≥2 meaningful tokens. */
function addressOverlap(docAddresses, loadAddress) {
  const target = String(loadAddress || '').toLowerCase();
  if (!target) return false;
  const targetZip = (target.match(/\b\d{5}\b/) || [])[0] || null;
  const targetTokens = new Set(target.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3));
  for (const raw of docAddresses || []) {
    const a = String(raw || '').toLowerCase();
    if (!a) continue;
    const zip = (a.match(/\b\d{5}\b/) || [])[0] || null;
    if (targetZip && zip && targetZip === zip) return true;
    const tokens = a.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
    let overlap = 0;
    for (const t of tokens) if (targetTokens.has(t)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
}

function milesBetween(haversine, aLat, aLng, bLat, bLng) {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return null;
  const v = haversine(Number(aLat), Number(aLng), Number(bLat), Number(bLng));
  return Number.isFinite(v) ? v : null;
}

/**
 * Pure scoring. Distances are computed via the injected haversine so the result
 * is deterministic given its inputs.
 *
 * @param {object} p
 * @param {object} p.classification  from documentClassifierService
 * @param {object|null} p.load        resolved Datatruck load (extractLoadFromOrder shape) or null
 * @param {{latitude:number,longitude:number}|null} p.location  driver GPS or null
 * @param {function} p.haversineMiles (lat1,lng1,lat2,lng2)=>miles
 * @param {number} [p.nearMiles]
 */
function scoreMatch({ classification = {}, load = null, location = null, haversineMiles, nearMiles = NEAR_MILES_DEFAULT }) {
  const reasons = [];
  const result = {
    confidence: CONFIDENCE.NONE,
    orderId: load?.orderId != null ? String(load.orderId) : null,
    loadReference: load?.loadIdentifier || (load?.orderId != null ? String(load.orderId) : null),
    docTypeHint: null,
    stageHint: null,
    distanceToPickupMiles: null,
    distanceToDeliveryMiles: null,
    mismatch: false,
    reasons,
    load,
  };

  if (!load) {
    reasons.push('No active Datatruck load found for this driver/unit.');
    return result;
  }

  // ── Location → pickup/delivery stage hint ──
  if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)) && typeof haversineMiles === 'function') {
    const dPickup = milesBetween(haversineMiles, location.latitude, location.longitude, load.pickupLat, load.pickupLng);
    const dDelivery = milesBetween(haversineMiles, location.latitude, location.longitude, load.deliveryLat, load.deliveryLng);
    result.distanceToPickupMiles = dPickup;
    result.distanceToDeliveryMiles = dDelivery;
    const nearPickup = dPickup != null && dPickup <= nearMiles;
    const nearDelivery = dDelivery != null && dDelivery <= nearMiles;
    if (nearPickup && (!nearDelivery || dPickup <= dDelivery)) {
      result.stageHint = 'pickup';
      result.docTypeHint = 'bol';
      reasons.push(`Driver is ~${dPickup.toFixed(1)} mi from pickup → likely BOL.`);
    } else if (nearDelivery) {
      result.stageHint = 'delivery';
      result.docTypeHint = 'pod';
      reasons.push(`Driver is ~${dDelivery.toFixed(1)} mi from delivery → likely POD.`);
    } else if (dPickup != null || dDelivery != null) {
      reasons.push('Driver is not near pickup or delivery — location gives no BOL/POD hint.');
    }
  }

  // ── Explicit "belongs to another load" from the AI ──
  if (classification.belongsToOtherLoad === true) {
    result.mismatch = true;
    result.confidence = CONFIDENCE.MISMATCH;
    reasons.push('AI flagged the document as belonging to a different load.');
    return result;
  }

  // ── Load-number match ──
  const ids = loadIdentifiers(load);
  const numMatch = loadNumberMatch(classification.loadNumbers, ids);
  if (numMatch.matched) {
    reasons.push(`Document load number ${numMatch.value} matches the current load.`);
  } else if (numMatch.hasDocNumbers && ids.length) {
    // Document carries clear load number(s) but none match the active load.
    result.mismatch = true;
    result.confidence = CONFIDENCE.MISMATCH;
    reasons.push('Document load number(s) do not match the current Datatruck load — possible mismatch.');
    return result;
  }

  // ── Address match ──
  const pickupAddrMatch = addressOverlap(classification.addresses, load.pickupAddress);
  const deliveryAddrMatch = addressOverlap(classification.addresses, load.deliveryAddress);
  if (pickupAddrMatch) reasons.push('Document address matches the pickup address.');
  if (deliveryAddrMatch) reasons.push('Document address matches the delivery address.');

  // ── Base confidence ──
  let confidence;
  if (numMatch.matched || pickupAddrMatch || deliveryAddrMatch) {
    confidence = CONFIDENCE.HIGH;
  } else if (load.loadInfoComplete === false) {
    confidence = CONFIDENCE.LOW;
    reasons.push('Matched the driver but load details are incomplete — weak match.');
  } else {
    confidence = CONFIDENCE.MEDIUM;
    reasons.push('Matched by the driver/unit of this group with no conflicting signal.');
  }

  // ── Stage vs classified type cross-check (never *raise* past medium on a
  // contradiction; agreement can keep high). ──
  const type = classification.type;
  if ((type === 'bol' || type === 'pod') && result.docTypeHint && result.docTypeHint !== type) {
    reasons.push(`Location suggests ${result.docTypeHint.toUpperCase()} but the document looks like ${type.toUpperCase()} — treat with caution.`);
    if (confidence === CONFIDENCE.HIGH) confidence = CONFIDENCE.MEDIUM;
    else confidence = CONFIDENCE.LOW;
  } else if (result.docTypeHint && result.docTypeHint === type) {
    reasons.push('Location and document type agree.');
  }

  result.confidence = confidence;
  return result;
}

/** Resolve the driver's active load via group → unit → name. */
async function resolveActiveLoad(group, driverProfile, deps) {
  const cl = deps.currentLoad;
  let load = null;
  if (group) {
    try { load = await cl.getCurrentLoadByGroup(group); } catch { /* ignore */ }
  }
  if (!load && driverProfile?.unit_number) {
    try { load = await cl.getCurrentLoadByUnit(driverProfile.unit_number); } catch { /* ignore */ }
  }
  if (!load && driverProfile?.full_name) {
    try { load = await cl.getCurrentLoadByDriver(driverProfile.full_name); } catch { /* ignore */ }
  }
  return load;
}

/**
 * Resolver-backed entry point. Injectable deps so it can be tested without
 * Datatruck / Samsara.
 *   deps.currentLoad       — services/currentLoadService (default)
 *   deps.resolveLocation   — (groupTitle)=>Promise<{location,source}> (default liveLocationResolver)
 *   deps.haversineMiles    — (default etaRoutingService.haversineMiles)
 */
async function matchLoadForBatch({ group = null, driverProfile = null, classification = {}, nearMiles }, deps = {}) {
  const resolvedDeps = {
    currentLoad: deps.currentLoad || require('./currentLoadService'),
    resolveLocation: deps.resolveLocation
      || ((title) => require('./liveLocationResolver').resolveLiveLocationForGroupTitle(title)),
    haversineMiles: deps.haversineMiles || require('./etaRoutingService').haversineMiles,
  };

  const load = await resolveActiveLoad(group, driverProfile, resolvedDeps);

  let location = null;
  const title = group?.group_name || null;
  if (title) {
    try {
      const resolved = await resolvedDeps.resolveLocation(title);
      const loc = resolved?.location || resolved || null;
      // The resolver's Samsara path exposes latitude/longitude; other providers
      // may use lat/lng — accept both.
      if (loc && (loc.latitude != null || loc.lat != null)) {
        location = {
          latitude: loc.latitude != null ? loc.latitude : loc.lat,
          longitude: loc.longitude != null ? loc.longitude : (loc.lng != null ? loc.lng : loc.lon),
        };
      }
    } catch { /* location optional */ }
  }

  return scoreMatch({
    classification,
    load,
    location,
    haversineMiles: resolvedDeps.haversineMiles,
    nearMiles: Number.isFinite(nearMiles) ? nearMiles : NEAR_MILES_DEFAULT,
  });
}

module.exports = {
  CONFIDENCE,
  NEAR_MILES_DEFAULT,
  normalizeRef,
  loadIdentifiers,
  loadNumberMatch,
  addressOverlap,
  scoreMatch,
  matchLoadForBatch,
};
