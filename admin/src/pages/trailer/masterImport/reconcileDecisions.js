/**
 * Pure decision logic for the trailer-list review (master-list reconciliation).
 *
 * Turns per-row editor state into the decision objects the API expects,
 * validates them (archive / merge / number-correction REQUIRE a reason), and
 * summarizes the impact in plain language. Dependency-free ESM so node:test
 * verifies the rules directly.
 */

export const ROW_FIELDS = [
  "make", "model", "mc_number", "plate_number", "type", "vin", "year", "ownership_status",
];

export function pickRowFields(row) {
  const out = {};
  for (const f of ROW_FIELDS) if (row[f] != null && row[f] !== "") out[f] = row[f];
  return out;
}

/** Actions whose consequences demand a written reason. */
export const REASON_REQUIRED = new Set(["archive", "merge", "correct_unit"]);

/**
 * Problems with one editor entry, as plain sentences. Empty array = valid.
 */
export function entryIssues(entry) {
  if (!entry || !entry.action || entry.action === "skip") return [];
  const issues = [];
  if (REASON_REQUIRED.has(entry.action) && !String(entry.reason || "").trim()) {
    issues.push("A reason is required for this action.");
  }
  if (entry.action === "merge" && !entry.merge_into_trailer_id) {
    issues.push("Choose the trailer to merge into.");
  }
  if (entry.action === "correct_unit" && !String(entry.new_unit_number || "").trim()) {
    issues.push("Enter the corrected unit number.");
  }
  return issues;
}

/** Turn the per-row editor state into API decision objects. */
export function buildDecisions(groups, state) {
  const decisions = [];
  for (const [key, entry] of Object.entries(state)) {
    if (!entry || !entry.action || entry.action === "skip") continue;
    const [group, id] = key.split(":");
    if (group === "new") {
      const g = (groups.new || []).find((x) => String(x.row.import_row_id) === id);
      if (!g) continue;
      decisions.push({
        decision: "create",
        unit_number: g.row.unit_number,
        import_row_id: g.row.import_row_id,
        reason: entry.reason || null,
        ...pickRowFields(g.row),
      });
    } else if (group === "matched" || group === "conflicting") {
      const source = (groups[group] || []).find((x) => String(x.trailer.id) === id);
      if (!source) continue;
      if (entry.action === "update") {
        decisions.push({
          decision: "update",
          trailer_id: source.trailer.id,
          import_row_id: source.row.import_row_id,
          reason: entry.reason || null,
          ...pickRowFields(source.row),
        });
      } else if (entry.action === "keep_verified") {
        decisions.push({ decision: "keep_verified", trailer_id: source.trailer.id, reason: entry.reason || null });
      }
    } else if (group === "missing") {
      const g = (groups.missing || []).find((x) => String(x.trailer.id) === id);
      if (!g) continue;
      decisions.push({
        decision: entry.action,
        trailer_id: g.trailer.id,
        reason: entry.reason || null,
        new_unit_number: entry.new_unit_number || undefined,
        merge_into_trailer_id: entry.merge_into_trailer_id ? Number(entry.merge_into_trailer_id) : undefined,
      });
    }
  }
  return decisions;
}

/** All validation problems across the editor state, keyed by row. */
export function allIssues(state) {
  const problems = {};
  for (const [key, entry] of Object.entries(state)) {
    const issues = entryIssues(entry);
    if (issues.length) problems[key] = issues;
  }
  return problems;
}

/** "Will add 2 trailers, update 3, archive 1, merge 1." */
export function impactSummary(decisions) {
  const counts = { create: 0, update: 0, keep_verified: 0, archive: 0, merge: 0, correct_unit: 0 };
  for (const d of decisions) if (counts[d.decision] !== undefined) counts[d.decision] += 1;
  const parts = [];
  if (counts.create) parts.push(`add ${counts.create} trailer${counts.create > 1 ? "s" : ""}`);
  if (counts.update) parts.push(`update ${counts.update}`);
  if (counts.keep_verified) parts.push(`keep ${counts.keep_verified} as verified`);
  if (counts.correct_unit) parts.push(`correct ${counts.correct_unit} unit number${counts.correct_unit > 1 ? "s" : ""}`);
  if (counts.archive) parts.push(`archive ${counts.archive}`);
  if (counts.merge) parts.push(`merge ${counts.merge}`);
  if (!parts.length) return "No changes selected yet.";
  return `Will ${parts.join(", ")}. Nothing is deleted — archived and merged trailers keep their history.`;
}

/** The fields where the uploaded list disagrees with the current record. */
export function fieldDiffs(trailer, row) {
  const diffs = [];
  for (const f of ROW_FIELDS) {
    const incoming = row?.[f];
    if (incoming == null || incoming === "") continue;
    const current = trailer?.[f];
    if (String(current ?? "") !== String(incoming)) {
      diffs.push({ field: f, current: current ?? "—", incoming });
    }
  }
  return diffs;
}
