import React, { Suspense, lazy, useState } from "react";
import PageErrorBoundary from "../components/PageErrorBoundary";

/**
 * Communications — everything Wenze says to a driver group, on one page.
 *
 * These five screens were five separate sidebar entries, and three of them sat
 * under the collapsible admin block rather than next to the other two, so
 * "send a message", "see what was sent" and "fix what was sent" were three
 * different places in three different parts of the nav. They are one job.
 *
 * NOTHING ON THE SERVER MOVED. Every route, every API client function and every
 * request these tabs make is exactly what it was; this stage is the admin panel
 * agreeing with itself about where a thing lives.
 *
 * Each tab is lazy-loaded: the Send Message composer alone pulls four hooks,
 * two composers and the media uploader, and opening the page to read the queue
 * should not fetch any of it.
 *
 * EACH TAB GETS ITS OWN ERROR BOUNDARY, keyed on the tab. Without it these five
 * share App's single boundary, whose reset key is `communications` for all of
 * them — so one tab throwing would blank the whole section INCLUDING this tab
 * bar, and switching tabs would not clear it because the key never changed. A
 * person would have to leave Communications entirely to get back to Scheduled
 * because Surveys failed. As five separate pages each had its own key and each
 * failure stayed put; this keeps that true.
 *
 * NO `initialTab` PROP AND NO EXPORTED TAB LIST YET. Both were drafted for the
 * deep links that C3's page-key map introduces; adding them here would be a
 * public surface whose only caller would be its own test, which is the shape
 * that has produced three tested-but-uncalled modules in this repository
 * already. They arrive with the thing that needs them.
 */

const SendMessageTab = lazy(() => import("./communications/SendMessageTab"));
const SurveysTab = lazy(() => import("./communications/SurveysTab"));
const ScheduledTab = lazy(() => import("./communications/ScheduledTab"));
const HistoryTab = lazy(() => import("./communications/HistoryTab"));
const EditByLinkTab = lazy(() => import("./communications/EditByLinkTab"));

const TABS = [
  { key: "send", icon: "📢", label: "Send Message", Component: SendMessageTab },
  { key: "surveys", icon: "📝", label: "Surveys", Component: SurveysTab },
  { key: "scheduled", icon: "📅", label: "Scheduled", Component: ScheduledTab },
  { key: "history", icon: "📨", label: "History", Component: HistoryTab },
  { key: "edit_by_link", icon: "🛠️", label: "Edit by Link", Component: EditByLinkTab },
];

export default function CommunicationsPage() {
  const [tab, setTab] = useState(TABS[0].key);
  const active = TABS.find((t) => t.key === tab) || TABS[0];
  const Active = active.Component;

  return (
    <div>
      <div className="page-header">
        <h2>💬 Communications</h2>
        <p>Messages, surveys and the queue — what the bot says to driver groups.</p>
      </div>
      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`btn ${tab === t.key ? "btn-primary" : "btn-ghost"} touch-target`}
            onClick={() => setTab(t.key)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <PageErrorBoundary resetKey={active.key}>
        <Suspense fallback={<div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>}>
          <Active />
        </Suspense>
      </PageErrorBoundary>
    </div>
  );
}
