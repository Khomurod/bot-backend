import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { buildGroupOptions } from "./routeControlGroupSearch.mjs";
import { pasteRouter } from "./routeControl/pasteRouter";
import { Banner } from "./routeControl/Banner";
import { AssignForm } from "./routeControl/AssignForm";
import { RouteRow } from "./routeControl/RouteRow";

/**
 * Route Control — assign a Google Maps directions route to a driver group and
 * watch whether the driver follows it. Routes are monitored server-side against
 * the driver's live GPS; the driver group is warned when they drift off route.
 * Google Maps must be configured in Settings → GMaps for geometry to compute and
 * monitoring to run. The admin can also push the assigned route straight into the
 * driver's Telegram group (tagging the driver when we know their Telegram id/handle).
 *
 * PAGE CONTAINER. The pieces live in ./routeControl/:
 *
 *   pasteRouter.js              THE one paste-target router (shared, one owner)
 *   formatters.js               label tables + pure formatters
 *   Banner.jsx                  the status banner, with partial-failure details
 *   SearchableGroupSelect.jsx   the type-to-filter driver-group picker
 *   AssignForm.jsx              test-parse, assign, screenshot, tracking start
 *   RouteRow.jsx                one route: status, history, screenshot panel
 *
 * The single window paste listener below is why the router is module-level
 * state rather than per-component: this listener, the assign form and every
 * open route row all have to agree on which dropzone a Ctrl+V belongs to.
 *
 * Screenshot transport to Telegram is a permanent invariant — signed
 * short-lived URLs, never bytes from this process. See
 * docs/architecture/route-control.md; RouteRow.jsx carries the same note where
 * the upload happens.
 */
export default function RouteControlPage() {
  const [options, setOptions] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [completionRadius, setCompletionRadius] = useState(null);
  const [statusFilter, setStatusFilter] = useState("active");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);

  const loadAssignments = useCallback(async () => {
    const data = await api.getRouteAssignments(statusFilter === "all" ? undefined : statusFilter);
    setAssignments(data.assignments || []);
    if (data.completionRadiusMiles != null) setCompletionRadius(data.completionRadiusMiles);
  }, [statusFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Driver profiles carry unit/name/type so the group picker is searchable.
      const profiles = await api.getDriverProfiles({ includeInactive: false });
      setOptions(buildGroupOptions(profiles));
      await loadAssignments();
    } catch (err) { setMessage({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }, [loadAssignments]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadAssignments().catch(() => {}); }, [statusFilter, loadAssignments]);

  // Single window-level paste listener for the whole page. It routes a pasted
  // image to the ONE active screenshot dropzone (the last one focused/opened)
  // and only prevents the default paste when an image was actually consumed —
  // so pasting text into ordinary inputs keeps working normally.
  useEffect(() => {
    const onPaste = (e) => {
      const handled = pasteRouter.handlePaste(e.clipboardData?.items);
      if (handled != null) e.preventDefault();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  return (
    <div>
      <div className="page-header">
        <h2>🧭 Route Control</h2>
        <p>Assign a planned Google Maps route to a driver, push it into their Telegram group, and get warned in that group if they go off route.</p>
      </div>
      <Banner message={message} />
      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : (
        <>
          <AssignForm options={options} onAssigned={loadAssignments} onMessage={setMessage} />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {["active", "completed", "cancelled", "all"].map((s) => (
              <button key={s} className={`btn btn-sm ${statusFilter === s ? "btn-primary" : "btn-ghost"}`} onClick={() => setStatusFilter(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          {assignments.length === 0 ? (
            <div className="card"><div style={{ fontSize: 13, color: "#94a3b8" }}>No routes {statusFilter === "all" ? "" : statusFilter}.</div></div>
          ) : (
            assignments.map((a) => (
              <RouteRow key={a.id} a={a} completionRadius={completionRadius} onChanged={loadAssignments} onMessage={setMessage} />
            ))
          )}
        </>
      )}
    </div>
  );
}
