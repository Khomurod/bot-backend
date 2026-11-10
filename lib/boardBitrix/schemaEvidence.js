'use strict';

/** Aggregate-only evidence for choosing a Bitrix truck category and stages. */
const {
  labelOf, fieldRows, idOf, catalogSignature,
} = require('./schema');

function bump(target, key) {
  if (key == null || key === '') return;
  const id = String(key);
  target[id] = Number(target[id] || 0) + 1;
}

function buildTruckEvidence(items) {
  const categoryCounts = {};
  const stageCounts = {};
  for (const item of items || []) {
    bump(categoryCounts, item?.categoryId ?? item?.CATEGORY_ID);
    bump(stageCounts, item?.stageId ?? item?.STAGE_ID);
  }
  return { totalItems: (items || []).length, categoryCounts, stageCounts };
}

function countSelected(mapping, evidence) {
  const categoryItems = Number(evidence?.categoryCounts?.[String(mapping?.truckCategoryId)] || 0);
  const activeItems = [...new Set(mapping?.activeTruckStageIds || [])]
    .reduce((sum, id) => sum + Number(evidence?.stageCounts?.[String(id)] || 0), 0);
  return { categoryItems, activeItems, totalItems: Number(evidence?.totalItems || 0) };
}

function assessEvidence(mapping, evidence, { baselineActiveCount = 0 } = {}) {
  const counts = countSelected(mapping, evidence);
  if (counts.totalItems === 0) {
    return { ok: false, anomalous: true, counts, reason: 'Bitrix returned no current truck items for schema evidence' };
  }
  if (counts.totalItems > 0 && counts.categoryItems === 0) {
    return { ok: false, anomalous: true, counts, reason: 'the selected Trucks category contains no current truck items' };
  }
  if (counts.categoryItems > 0 && counts.activeItems === 0) {
    return { ok: false, anomalous: true, counts, reason: 'the selected active-truck stages contain no current truck items' };
  }
  const baseline = Number(baselineActiveCount || 0);
  const lower = baseline >= 10 && counts.activeItems < Math.max(1, Math.floor(baseline * 0.5));
  const upper = baseline >= 10 && counts.activeItems > Math.ceil(baseline * 1.5) + 10;
  return {
    ok: true,
    anomalous: lower || upper,
    counts,
    reason: lower || upper
      ? `the candidate changes active trucks from about ${baseline} to ${counts.activeItems}` : null,
  };
}

function byId(rows, id, names) {
  return (rows || []).find((row) => idOf(row, names) === String(id));
}

function summarizeEvidence(mapping, catalog, evidence) {
  const counts = countSelected(mapping, evidence);
  const categoryLabel = (id) => labelOf(byId(catalog?.truckCategories, id)) || String(id);
  const populatedCategories = Object.entries(evidence?.categoryCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 8)
    .map(([id, count]) => ({ label: categoryLabel(id), itemCount: Number(count) }));
  const populatedStages = Object.entries(evidence?.stageCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 12)
    .map(([id, count]) => {
      const row = byId(catalog?.truckStages, id);
      return {
        label: labelOf(row) || String(id),
        category: row?.__categoryId == null ? null : categoryLabel(row.__categoryId),
        itemCount: Number(count),
      };
    });
  return {
    totalTruckItems: counts.totalItems,
    selectedCategoryItems: counts.categoryItems,
    selectedActiveItems: counts.activeItems,
    populatedCategories,
    populatedStages,
  };
}

function describeMapping(mapping, catalog, evidence) {
  const stageLabel = (id) => labelOf(byId(catalog.dealStages, id)) || String(id);
  const truckStageLabel = (id) => labelOf(byId(catalog.truckStages, id)) || String(id);
  const fields = fieldRows(catalog.fields);
  return {
    ...mapping,
    catalogSignature: catalogSignature(mapping, catalog),
    labels: {
      driverPipeline: labelOf(byId(catalog.categories, mapping.categoryId)) || String(mapping.categoryId),
      truckProcess: labelOf(byId(catalog.types, mapping.truckEntityTypeId,
        ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID'])) || String(mapping.truckEntityTypeId),
      truckCategory: labelOf(byId(catalog.truckCategories, mapping.truckCategoryId)) || String(mapping.truckCategoryId),
      dealFields: {
        truck: labelOf(byId(fields, mapping.dealFields?.truck)) || String(mapping.dealFields?.truck || ''),
        driverType: labelOf(byId(fields, mapping.dealFields?.driverType)) || String(mapping.dealFields?.driverType || ''),
      },
      stages: Object.fromEntries(Object.entries(mapping.stageByRole || {})
        .map(([role, id]) => [role, stageLabel(id)])),
      activeTruckStages: (mapping.activeTruckStageIds || []).map((id) => truckStageLabel(id)),
    },
    evidence: summarizeEvidence(mapping, catalog, evidence),
  };
}

module.exports = {
  buildTruckEvidence, countSelected, assessEvidence, summarizeEvidence, describeMapping,
};
