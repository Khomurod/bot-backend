import React, { Suspense, lazy } from "react";
import PageErrorBoundary from "../components/PageErrorBoundary";
import TabBar, { tabPanelProps } from "../components/ui/TabBar";
import useTabRoute from "../navigation/useTabRoute";

/**
 * Communications → Messages — everything Wenze says to a driver group, on one
 * page. (The page was titled "Communications", the same as its sidebar group;
 * since October 2026 the entry and the page say what it holds.)
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
 * THE OPEN TAB IS IN THE ADDRESS (`#communications/scheduled`), and the five
 * retired page keys land on their own tab (navigation/pageKeys.js). The key
 * list is exported for the test that holds those legacy links to real tabs.
 */

const SendMessageTab = lazy(() => import("./communications/SendMessageTab"));
const SurveysTab = lazy(() => import("./communications/SurveysTab"));
const ScheduledTab = lazy(() => import("./communications/ScheduledTab"));
const HistoryTab = lazy(() => import("./communications/HistoryTab"));
const EditByLinkTab = lazy(() => import("./communications/EditByLinkTab"));

const TABS = [
  { key: "send", label: "Send Message", Component: SendMessageTab },
  { key: "surveys", label: "Surveys", Component: SurveysTab },
  { key: "scheduled", label: "Scheduled", Component: ScheduledTab },
  { key: "history", label: "History", Component: HistoryTab },
  { key: "edit_by_link", label: "Edit by Link", Component: EditByLinkTab },
];

export const COMMUNICATIONS_TAB_KEYS = Object.freeze(TABS.map((t) => t.key));

export default function CommunicationsPage({ tab: routeTab, onTabChange }) {
  const [tab, setTab] = useTabRoute(COMMUNICATIONS_TAB_KEYS, { tab: routeTab, onTabChange });
  const active = TABS.find((t) => t.key === tab) || TABS[0];
  const Active = active.Component;

  return (
    <div>
      <div className="page-header">
        <h2>Messages</h2>
        <p>Messages, surveys and the queue — what the bot says to driver groups.</p>
      </div>
      <TabBar
        tabs={TABS.map((t) => ({ key: t.key, label: t.label }))}
        value={tab}
        onChange={setTab}
        ariaLabel="Message sections"
        idPrefix="communications"
      />
      <div {...tabPanelProps("communications", tab)}>
      <PageErrorBoundary resetKey={active.key}>
        <Suspense fallback={<div className="loading"><div className="spinner"></div> Loading…</div>}>
          <Active />
        </Suspense>
      </PageErrorBoundary>
      </div>
    </div>
  );
}
