import React, { Suspense, lazy, useEffect } from "react";
import useTabRoute from "../navigation/useTabRoute";
import PageErrorBoundary from "../components/PageErrorBoundary";
import SettingsNav from "./settings/SettingsNav";
import { SETTINGS_SECTION_ALIASES, SETTINGS_SECTION_KEYS, settingsSectionLabel } from "./settings/sections";

/**
 * Settings — tab shell. Each tab lives in ./settings/ and is lazy-loaded so
 * its code is fetched only when the tab is opened (smaller initial bundle).
 *
 * Secrets are write-only from the UI: the API returns only a masked "••••abcd"
 * hint and never the raw value. Leaving a key field blank on Save keeps the
 * stored value.
 *
 * Notifications, Auto Reactions and Bot Group Access are NOT integrations —
 * nothing to authenticate — but they are configuration, and they were each a
 * top-level sidebar entry or buried inside another tab before.
 *
 * AUTO REACTIONS AND GROUP ACCESS ARE TWO TABS, NOT ONE "BOT SETTINGS" TAB WITH
 * TWO PANELS. The grouped version was written first and reverted: a single page
 * key for two screens meant a held `#group_access` link resolved to the group
 * and then opened the OTHER one, silently and indistinguishably from the
 * `#auto_reactions` link. One key per screen is what makes a link mean
 * something, and a tab is already lazy and already shown one at a time, so the
 * grouping bought nothing the tab bar was not already doing.
 *
 * Samsara is one integration in two sections since November 2026: Samsara
 * (the connection, the safety-event switches, missing-video recovery — one
 * settings row, one Save) and Samsara Video & Music (the driver-group music
 * overlay, ./settings/SafetyEventsTab.jsx, with its own Save). On one screen
 * they had two Save buttons and nothing said which saved what.
 *
 * GROUPED, AND EVERY SECTION HAS AN ADDRESS (October 2026). Thirteen sections in
 * one row of tabs read as a list of everything ever added; they are now under
 * groups (./settings/sections.js; five since November 2026) in the page's own navigation, and the
 * open section is the second half of the address — `#settings/board`. One
 * sidebar entry opens this page; the six it used to have are legacy keys that
 * land on the same sections.
 */

const LocationProvidersTab = lazy(() => import("./settings/LocationProvidersTab"));
const RecruitersTab = lazy(() => import("./settings/RecruitersTab"));
const RcConnectionTab = lazy(() => import("./settings/RcConnectionTab"));
const BitrixTab = lazy(() => import("./settings/BitrixTab"));
const SamsaraTab = lazy(() => import("./settings/SamsaraTab"));
const SafetyEventsTab = lazy(() => import("./settings/SafetyEventsTab"));
const DispatcherBoardTab = lazy(() => import("./settings/DispatcherBoardTab"));
const AiTab = lazy(() => import("./settings/AiTab"));
const AiTasksTab = lazy(() => import("./settings/AiTasksTab"));
const WenzeQuestionsTab = lazy(() => import("./settings/WenzeQuestionsTab"));
const ProviderTermsTab = lazy(() => import("./settings/ProviderTermsTab"));
const NotificationsTab = lazy(() => import("./settings/NotificationsTab"));
const SafetyApprovalsTab = lazy(() => import("./settings/SafetyApprovalsTab"));
const AutoReactionsPanel = lazy(() => import("./settings/bot/AutoReactionsPanel"));
const GroupAccessPanel = lazy(() => import("./settings/bot/GroupAccessPanel"));
const RetiredLeftoversTab = lazy(() => import("./settings/RetiredLeftoversTab"));
const GrossRaceTab = lazy(() => import("./settings/GrossRaceTab"));
const MetaCrmTab = lazy(() => import("./settings/MetaCrmTab"));
const AdminAccountsTab = lazy(() => import("./settings/admins/AdminAccountsTab"));

/**
 * `tab` is the section named in the address (`#settings/board`) and
 * `onTabChange` writes a new one; rendered on its own, `tab` is only where it
 * opens. An unrecognised section opens the first one rather than a blank page.
 */
export default function SettingsPage({ tab: routeTab, onTabChange }) {
  // A section merged into another (`#settings/groups`) opens the one its
  // content is in, and the address is corrected to say so.
  const aliasedTo = SETTINGS_SECTION_ALIASES[routeTab] || null;
  useEffect(() => {
    if (aliasedTo && onTabChange) onTabChange(aliasedTo);
  }, [aliasedTo]);
  const [tab, setTab] = useTabRoute(SETTINGS_SECTION_KEYS, { tab: aliasedTo || routeTab, onTabChange });
  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
        <p>Connections to outside services, the AI, where the bot posts, who can sign in, and maintenance.</p>
      </div>
      <div className="settings-layout">
        <SettingsNav value={tab} onChange={setTab} />
        <section className="settings-content" aria-label={settingsSectionLabel(tab)}>
          {/* One boundary per section, keyed on it: a section that fails (or
              whose chunk does not load after a deploy) leaves the section list
              usable, and choosing another section clears it. */}
          <PageErrorBoundary resetKey={tab}>
          <Suspense fallback={<div className="loading"><div className="spinner"></div> Loading…</div>}>
            {tab === "location" && <LocationProvidersTab />}
            {tab === "ringcentral" && <RecruitersTab />}
            {tab === "rc_connection" && <RcConnectionTab />}
            {tab === "bitrix" && <BitrixTab />}
            {tab === "metacrm" && <MetaCrmTab />}
            {tab === "samsara" && <SamsaraTab />}
            {tab === "samsara_video" && <SafetyEventsTab />}
            {tab === "board" && <DispatcherBoardTab />}
            {tab === "safety" && <SafetyApprovalsTab />}
            {tab === "ai" && <AiTab />}
            {tab === "ai_tasks" && <AiTasksTab />}
            {tab === "ai_questions" && <WenzeQuestionsTab />}
            {tab === "ai_terms" && <ProviderTermsTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "reactions" && <AutoReactionsPanel />}
            {tab === "access" && <GroupAccessPanel />}
            {tab === "grossrace" && <GrossRaceTab />}
            {tab === "admins" && <AdminAccountsTab />}
            {tab === "leftovers" && <RetiredLeftoversTab />}
          </Suspense>
          </PageErrorBoundary>
        </section>
      </div>
    </div>
  );
}
