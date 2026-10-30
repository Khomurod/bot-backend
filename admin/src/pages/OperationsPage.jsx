import React from "react";

import PageFailure from "../components/PageFailure";
import useOperations from "./operations/useOperations";
import FindingsListCard from "./operations/FindingsListCard";
import FindingDetailModal from "./operations/FindingDetailModal";
import HistoryTab from "./operations/HistoryTab";
import ChecksTab from "./operations/ChecksTab";
import IdentityTab from "./operations/IdentityTab";
import LearningTab from "./operations/LearningTab";
import ConfigurationBanner from "./operations/ConfigurationBanner";
import * as api from "../api";
import TabBar, { tabPanelProps } from "../components/ui/TabBar";
import useTabRoute from "../navigation/useTabRoute";

/**
 * Needs Attention — where the system says its own facts disagree.
 *
 * Layout and wiring only. Every fetch, every piece of state and every action
 * lives in `operations/useOperations.js`, the same split HomeTimePage uses.
 *
 * The tabs are one pipeline, in the order the work happens: what is wrong,
 * what has been done about it, what the system may do by itself, the identity
 * backfill (a correction-grade action on the same permission), and what Wenze
 * learned from how its corrections were received. Automation is never first —
 * a page that opens on its automation settings invites turning things on
 * before reading what they would do.
 *
 * Retention and "What is running" were tabs here until October 2026 and are
 * pages of their own now (Drivers → Retention, Monitoring → System Health):
 * neither is a finding. docs/redesign/structure.md.
 */
const TABS = [
  { key: "findings", label: "Needs attention" },
  { key: "history", label: "History" },
  { key: "checks", label: "Automation" },
  { key: "identity", label: "Driver Identity" },
  // "Suggestions", not "What Wenze learned": Settings → AI has a card called
  // "What Wenze learned from you" that is a different thing (lessons from the
  // owner's answers), and two screens with one name is a search for the wrong one.
  { key: "learning", label: "Suggestions" },
];

/** The open tab is the second half of the address (`#operations/history`). */
export default function OperationsPage({ tab: routeTab, onTabChange }) {
  const [status, setStatus] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);
  const [tab, setTab] = useTabRoute(TABS.map((t) => t.key), { tab: routeTab, onTabChange });
  const ops = useOperations({ flash, tab, setTab });

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
        <h2>Needs Attention</h2>
        <p>
          Every fifteen minutes the system compares its own records and files a
          finding wherever two of them disagree. Nothing here is a guess: each one
          carries the exact values it was built from, and a correction may only be
          applied when the corrected value is already recorded somewhere else.
        </p>
      </div>

      {/* Above everything, because a feature that finds things and cannot say
          so is worse than one that is switched off: it looks like it is
          working. Renders nothing once a destination is set. */}
      <ConfigurationBanner />

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

      <TabBar tabs={TABS} value={ops.tab} onChange={ops.setTab} ariaLabel="Operations sections" idPrefix="operations" />

      <div {...tabPanelProps("operations", ops.tab)}>
      {ops.tab === "findings" && <FindingsListCard {...ops} />}
      {ops.tab === "history" && <HistoryTab {...ops} />}
      {ops.tab === "checks" && (
        <ChecksTab {...ops} preview={preview} loadPreview={loadPreview} />
      )}
      {ops.tab === "identity" && <IdentityTab flash={flash} />}
      {ops.tab === "learning" && <LearningTab flash={flash} />}
      </div>

      {ops.selectedId && <FindingDetailModal {...ops} />}
    </div>
  );
}
