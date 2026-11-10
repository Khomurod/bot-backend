'use strict';

/** Pure promotion rules for a live Bitrix schema candidate. */
const REQUIRED_SEEN = 2;

function structuralShape(mapping) {
  return JSON.stringify({
    categoryId: Number(mapping?.categoryId) || null,
    truckEntityTypeId: Number(mapping?.truckEntityTypeId) || null,
    truckCategoryId: Number(mapping?.truckCategoryId) || null,
    dealFields: mapping?.dealFields || null,
  });
}

function structuralChange(activeMapping, proposedMapping) {
  return structuralShape(activeMapping) !== structuralShape(proposedMapping);
}

function decideCandidate({
  active = null, current = null, proposed,
  activeValid = false, activeProven = activeValid, anomalous = false,
}) {
  const sameAsActive = Boolean(activeValid && active?.fingerprint
    && active.fingerprint === proposed.fingerprint);
  if (sameAsActive) {
    return { useActive: true, promote: false, seenCount: REQUIRED_SEEN, requiresApproval: false };
  }
  const seenCount = current?.state === 'candidate'
    && current.fingerprint === proposed.fingerprint
    ? Math.min(100, Number(current.seenCount || 0) + 1) : 1;
  const requiresApproval = Boolean(anomalous || (activeProven && active?.fingerprint
    && structuralChange(active.mapping, proposed.mapping)));
  return {
    useActive: false,
    promote: seenCount >= REQUIRED_SEEN && !requiresApproval,
    seenCount,
    requiresApproval,
  };
}

module.exports = { REQUIRED_SEEN, structuralShape, structuralChange, decideCandidate };
