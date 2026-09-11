import React from "react";

import PageFailure from "../components/PageFailure";
import useOperations from "./operations/useOperations";
import FindingsListCard from "./operations/FindingsListCard";
import FindingDetailModal from "./operations/FindingDetailModal";
import HistoryTab from "./operations/HistoryTab";
import ChecksTab from "./operations/ChecksTab";
import IdentityTab from "./operations/IdentityTab";
import RetentionTab from "./operations/RetentionTab";
import * as api from "../api";

/**
 * Needs Attention — where the system says its own facts disagree.
 *
 * Layout and wiring only. Every fetch, every piece of state and every action
 * lives in `operations/useOperations.js`, the same split HomeTimePage uses.
 *
 * Three tabs, in the order the work actually happens: what is wrong, what has
 * been done about it, and what the system is allowed to do by itself. The last
 * one is deliberately last — a page that opens on its automation settings
 * invites turning things on before reading what they would do.
 */
const TABS = [
  { key: "findings", label: "Needs attention" },
  { key: "history", label: "History" },
  { key: "checks", label: "Automation" },
  { key: "identity", label: "Identity" },
  { key: "retention", label: "Retention" },
];

export default function OperationsPage() {
  const [status, setStatus] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);
  const ops = useOperations({ flash });

  const loadPreview = React.useCallback(async () => {
    try {
      setPreview(await api.previewAutoCorrections());
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not preview.");
    }
  }, [flash]);

  return (
    <div>
      <div className="page-header">
        <h2>🔎 Needs Attention</h2>
        <p>
          Every fifteen minutes the system compares its own records and files a
          finding wherever two of them disagree. Nothing here is a guess: each one
          carries the exact values it was built from, and a correction may only be
          applied when the corrected value is already recorded somewhere else.
        </p>
      </div>

      {/* Kept beside the last good data rather than replacing it — a failed
          refresh must never render as a reassuring empty page. */}
      {ops.failure && (
        <PageFailure
          error={ops.failure}
          where="OperationsPage"
          variant="inline"
          onRetry={ops.load}
        />
      )}

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>
          {status.text}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`btn btn-sm ${ops.tab === t.key ? "btn-primary" : "btn-ghost"}`}
            onClick={() => ops.setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {ops.tab === "findings" && <FindingsListCard {...ops} />}
      {ops.tab === "history" && <HistoryTab {...ops} />}
      {ops.tab === "checks" && (
        <ChecksTab {...ops} preview={preview} loadPreview={loadPreview} />
      )}
      {ops.tab === "identity" && <IdentityTab flash={flash} />}
      {ops.tab === "retention" && <RetentionTab flash={flash} />}

      {ops.selectedId && <FindingDetailModal {...ops} />}
    </div>
  );
}
