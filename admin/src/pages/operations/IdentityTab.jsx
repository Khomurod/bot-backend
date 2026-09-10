import React from "react";

import * as api from "../../api";

/**
 * The person layer, from the operator's side: how much of the fleet has a
 * permanent identity, and the one button that populates it.
 *
 * Preview first, always. The backfill is the Stage 1 plan — one person per
 * active driver group, two groups joined only when they share a Telegram user
 * id, a shared NAME reported and never merged, a contested unit left to nobody —
 * and the preview shows exactly those numbers before anything is written.
 * Applying sits on the same permission as applying a correction, so a 403 here
 * is the permission working, not a fault.
 */
function Tile({ label, value, hint }) {
  return (
    <div className="card" style={{ padding: 12, minWidth: 150 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{value ?? "—"}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</div>}
    </div>
  );
}

export default function IdentityTab({ flash }) {
  const [coverage, setCoverage] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);

  const loadCoverage = React.useCallback(async () => {
    try {
      const data = await api.getIdentityCoverage();
      setCoverage(data.coverage);
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not read identity coverage.");
    }
  }, [flash]);

  React.useEffect(() => { loadCoverage(); }, [loadCoverage]);

  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.previewIdentityBackfill());
      setResult(null);
    } catch (err) {
      flash("error", err?.detail || err?.message || "The preview failed.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const data = await api.runIdentityBackfill();
      setResult(data);
      setPreview(null);
      flash("success", `Identity backfill applied: ${data.applied?.peopleCreated ?? 0} people created.`);
      await loadCoverage();
    } catch (err) {
      flash("error", err?.detail || err?.message || "The backfill failed.");
    } finally {
      setBusy(false);
    }
  };

  const stats = preview?.plan?.stats;
  const stamped = result?.stamped;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Tile label="People" value={coverage?.people} hint="permanent identities" />
        <Tile label="Active driver groups" value={coverage?.activeDriverGroups} />
        <Tile
          label="Groups without a person"
          value={coverage?.groupsWithoutPerson}
          hint={coverage?.groupsWithoutPerson === 0 ? "every chat is placed" : "the backfill fills these"}
        />
        <Tile label="Trucks assigned" value={coverage?.openUnits} hint="one driver per truck" />
        <Tile
          label="Unstamped history"
          value={coverage ? coverage.unstamped.roadHistory + coverage.unstamped.requests : null}
          hint="road legs + requests without a person"
        />
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Identity backfill</h3>
        <p style={{ color: "var(--text-muted)" }}>
          Gives every active driver group a permanent person, joins two chats only when the same
          Telegram account texts in both, reports a shared name instead of merging it, and leaves a
          truck claimed by two drivers to nobody. Then every road leg, home stay, request, fuel watch,
          route and team seat already on record is stamped with its person. Re-running is safe: a
          group that already belongs to somebody is skipped.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={runPreview}>
            Preview
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !preview}
            onClick={apply}
            title={preview ? "" : "Preview first"}
          >
            Apply backfill
          </button>
        </div>

        {stats && (
          <div style={{ marginTop: 12 }} role="status">
            <div>
              <b>{stats.people}</b> people for <b>{stats.groups}</b> active groups
              {" "}· <b>{stats.anchoredClusters}</b> joined by Telegram id
              {" "}· <b>{stats.alreadyClaimedGroups ?? 0}</b> already placed
            </div>
            <div>
              <b>{stats.mergeCandidates}</b> shared names reported, not merged
              {" "}· <b>{stats.contestedUnits}</b> contested trucks left unclaimed
            </div>
            {preview.plan.contestedUnits?.length > 0 && (
              <ul style={{ marginTop: 6 }}>
                {preview.plan.contestedUnits.map((u) => (
                  <li key={u.unitNumber}>
                    Unit <code>{u.unitNumber}</code>: {u.people.map((p) => p.displayName).join(", ")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 12 }} role="status">
            Created <b>{result.applied?.peopleCreated ?? 0}</b> people, opened{" "}
            <b>{result.applied?.associationsOpened ?? 0}</b> group links and{" "}
            <b>{result.applied?.unitsOpened ?? 0}</b> truck assignments.
            {stamped && (
              <>
                {" "}Stamped {Object.values(stamped).reduce((a, b) => a + b, 0)} existing rows
                (road legs {stamped.driver_road_history}, requests {stamped.home_time_requests},
                mileage {stamped.mileage_bonus_progress}).
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
