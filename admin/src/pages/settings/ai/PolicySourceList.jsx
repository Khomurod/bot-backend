import React from "react";

import * as api from "../../../api";

/** Where a page's address came from. A person can tell at a glance what Wenze did for them. */
const ORIGIN_LABEL = {
  catalog: "found automatically",
  rediscovered: "found again",
  manual: "added by hand",
};

/**
 * The terms watcher's pages: each one's origin and health, a Watch box, and
 * Remove.
 *
 * WATCH, NOT REMOVE, keeps a page off. Wenze adds a known provider's official
 * pages by itself, and it adds a missing one back at the next check — so
 * Remove only sticks for a page added by hand. An unticked page stays listed
 * (dimmed) and is not fetched (`database/aiPolicy.js` `listSourcesToCheck`).
 *
 * Split out of PolicyWatcherCard.jsx.
 */
export default function PolicySourceList({ sources, load, flash }) {
  return (
    <>
      {sources.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
          No pages yet. For a provider Wenze knows, its official pages are added
          automatically the next time the watcher runs — or press Check now.
        </div>
      ) : (
        <ul style={{ fontSize: 12, paddingLeft: 18, marginTop: 6 }}>
          {sources.map((s) => (
            <li key={s.id} style={{ marginBottom: 3, opacity: s.enabled ? 1 : 0.6 }}>
              <label style={{ display: "inline-flex", gap: 4, alignItems: "center", marginRight: 6 }}>
                <input
                  type="checkbox" checked={s.enabled !== false}
                  aria-label={`Watch ${s.providerKey} ${s.kind}`}
                  onChange={async (e) => {
                    try {
                      await api.setAiPolicySourceEnabled(s.id, e.target.checked);
                      load();
                    } catch (err) {
                      flash("error", err?.message || "Could not change the page.");
                    }
                  }}
                />
                Watch
              </label>
              <code>{s.providerKey}</code> · {s.kind} ·{" "}
              <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>{" "}
              <span className="badge badge-muted" style={{ fontSize: 10 }}>
                {ORIGIN_LABEL[s.sourceOrigin] || s.sourceOrigin}
              </span>
              {s.movedFrom && (
                <span style={{ color: "var(--text-muted)" }}> — moved from {s.movedFrom}</span>
              )}
              {s.lostReportedAt && (
                <span style={{ color: "var(--danger)" }}> — could not be found; you have been told</span>
              )}
              {s.lastError && !s.lostReportedAt && <span style={{ color: "var(--warning)" }}> — {s.lastError}</span>}
              <button
                type="button" className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await api.deleteAiPolicySource(s.id);
                  load();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {sources.length > 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
          Untick Watch to stop checking a page. Remove only sticks for a page added by
          hand — Wenze adds a known provider&apos;s pages back at the next check.
        </div>
      )}
    </>
  );
}
