import React, { Suspense, lazy, useState } from "react";
import PageErrorBoundary from "../components/PageErrorBoundary";

/**
 * Finance Monitor — the read-only screen over what the finance group posted.
 *
 * FOUR TABS, LAZY, AND THE BOUNDARY IS BELOW THE TAB BAR. One tab throwing
 * must not blank the others or the tab bar itself: the whole point of the page
 * is that somebody can get at the money codes, and losing all four because one
 * table hit a bad row is the failure mode a boundary wrapped around the WHOLE
 * page produces. Only the active tab is mounted, so one boundary is enough —
 * and `resetKey` is the tab, so switching away clears the error rather than
 * leaving the page stuck on it.
 *
 * The settings — which group, whether attachments are read, when the summary
 * goes out — live in Settings → Finance Monitor. This page is what was
 * captured, and nothing here changes a money code, an amount or a status by
 * hand. Its actions re-run machinery that already exists: re-read a message
 * with the current parser, queue an attachment again, or send the weekly
 * summary now.
 */

const TABS = [
  { key: "moneycodes", label: "💵 Money codes", load: () => import("./finance/MoneycodesTab") },
  { key: "documents", label: "📎 Attachments", load: () => import("./finance/DocumentsTab") },
  { key: "messages", label: "💬 Messages", load: () => import("./finance/MessagesTab") },
  { key: "reports", label: "🗓️ Weekly summaries", load: () => import("./finance/ReportsTab") },
];

const COMPONENTS = Object.fromEntries(TABS.map((t) => [t.key, lazy(t.load)]));

export default function FinancePage() {
  const [tab, setTab] = useState("moneycodes");
  const Active = COMPONENTS[tab];

  return (
    <div>
      <div className="page-header">
        <h2>💵 Finance Monitor</h2>
        <p>
          The money codes posted in the finance group, what came with them, and what went out
          each week. Read-only — Wenze records what was posted and never changes it.
        </p>
      </div>

      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn ${tab === t.key ? "btn-primary" : "btn-ghost"} touch-target`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <PageErrorBoundary resetKey={tab}>
        <Suspense fallback={<div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>}>
          <Active />
        </Suspense>
      </PageErrorBoundary>
    </div>
  );
}
