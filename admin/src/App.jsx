import React, { Suspense, lazy, useEffect, useState } from "react";
import * as api from "./api";
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from "./pages/LoginPage";
import { AuthProvider } from "./context/AuthContext";
import AdminSidebar from "./components/AdminSidebar";
import PageErrorBoundary from "./components/PageErrorBoundary";
import DatabaseUsageBanner from "./components/DatabaseUsageBanner";
import { DEFAULT_PAGE_KEY, hashForPageKey, pageKeyFromHash } from "./navigation/pageKeys";

// Every other page is lazy-loaded so its code is fetched only when the page
// is opened — the initial admin bundle stays small.
const GroupsPage = lazy(() => import("./pages/GroupsPage"));
const CommunicationsPage = lazy(() => import("./pages/CommunicationsPage"));
const CompanyBirthdaysPage = lazy(() => import("./pages/CompanyBirthdaysPage"));
const FacebookLeadsPage = lazy(() => import("./pages/FacebookLeadsPage"));
const LeadsPage = lazy(() => import("./pages/LeadsPage"));
const MileageBonusPage = lazy(() => import("./pages/MileageBonusPage"));
const RaiseApprovalPage = lazy(() => import("./pages/RaiseApprovalPage"));
const RaisePublicPage = lazy(() => import("./pages/RaisePublicPage"));
const HomeTimePage = lazy(() => import("./pages/HomeTimePage"));
const GroupAccessPage = lazy(() => import("./pages/GroupAccessPage"));
const FuelMonitorPage = lazy(() => import("./pages/FuelMonitorPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const AutoReactionsPage = lazy(() => import("./pages/AutoReactionsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const RecruiterKpiPage = lazy(() => import("./pages/RecruiterKpiPage"));
const RecruitersPublicPage = lazy(() => import("./pages/RecruitersPublicPage"));
const LiveLocationsPage = lazy(() => import("./pages/LiveLocationsPage"));
const RouteControlPage = lazy(() => import("./pages/RouteControlPage"));
const OperationsPage = lazy(() => import("./pages/OperationsPage"));

const pageLoadingFallback = (
  <div className="loading">
    <div className="spinner"></div> Loading...
  </div>
);

/**
 * Shared wrapper for a lazy page: a per-section error boundary plus the
 * suspense fallback.
 *
 * `pageKey` is what keeps sections independent. The boundary it feeds resets
 * whenever that key changes, so a section that threw cannot leave the boundary
 * latched and make every section opened afterwards show the same failure — the
 * production symptom where Driver Groups, Mileage Bonuses "and other sections"
 * all reported "Could not load this page" because only the first one had
 * actually failed.
 *
 * THE CALLER ALSO PASSES `key={page}`, and that is load-bearing rather than
 * tidiness. Several page keys render the SAME component on a different tab —
 * `settings_integrations` / `settings_board` / `settings_ai` are one
 * SettingsPage, `operations` / `system_health` one OperationsPage. React
 * reconciles same-type elements in the same position, so without a key the
 * instance survives the navigation and a tab read once in a `useState`
 * initialiser keeps whatever it opened on: the URL moves, the sidebar
 * highlight moves, the screen does not.
 */
function LazyPage({ pageKey, children }) {
  return (
    <PageErrorBoundary resetKey={pageKey}>
      <Suspense fallback={pageLoadingFallback}>{children}</Suspense>
    </PageErrorBoundary>
  );
}

/**
 * Which page a URL names.
 *
 * THE PATH DECIDES THE SHELL; THE HASH DECIDES THE ADMIN PAGE. The two public
 * pages have paths of their own and no sidebar. Every admin page shares
 * `/admin`, so the page within it is the hash — which is new. Until now
 * `/admin` was the only URL the panel ever produced, so no admin screen could
 * be bookmarked, shared in a chat, or reached with Back.
 *
 * An absent, unreadable or retired hash resolves through
 * `navigation/pageKeys.js`: a key that moved opens where its content went, and
 * anything else opens Driver Groups — the page the shell has always opened on.
 *
 * `/dispatch` is NOT here. The Dispatch Center is retired and the server
 * answers 410 on that path before the SPA is ever served, so a held bookmark
 * gets a plain "this feature has been removed" rather than the shell quietly
 * rendering Driver Groups. See server/routes/retiredRoutes.js.
 */
function pageFromLocation(pathname, hash) {
  if (pathname === "/raise" || pathname.startsWith("/raise/")) {
    return "raise_public";
  }
  if (pathname === "/recruiters" || pathname.startsWith("/recruiters/")) {
    return "recruiters_public";
  }
  return pageKeyFromHash(hash) || DEFAULT_PAGE_KEY;
}

function initialPage() {
  return pageFromLocation(window.location.pathname, window.location.hash);
}

/**
 * Every page key the shell can render, and what it renders.
 *
 * Module level, and EXPORTED, on purpose. This list and the sidebar's item list
 * are the same vocabulary authored twice; exporting it is what lets
 * `navigation/pageKeys.test.jsx` assert they agree, which nothing did before —
 * a typo in either simply missed the lookup and rendered Driver Groups.
 *
 * Several keys are the same component on a different tab. That is the point:
 * "Dispatcher Board" is what a person looks for in a sidebar, and it happens to
 * be a tab of the Settings page.
 */
const PAGE_COMPONENTS = {
  facebook_leads: <FacebookLeadsPage />,
  leads: <LeadsPage />,
  // Send Message, Surveys, Scheduled, History and Edit by Link are five tabs
  // of ONE page. Their old keys live in LEGACY_PAGE_KEYS, not here, so a
  // bookmarked `#broadcast` resolves to this page instead of silently opening
  // Driver Groups. See pages/CommunicationsPage.jsx.
  communications: <CommunicationsPage />,
  groups: <GroupsPage />,
  company_birthdays: <CompanyBirthdaysPage />,
  mileage_bonus: <MileageBonusPage />,
  raise_approval: <RaiseApprovalPage />,
  home_time: <HomeTimePage />,
  fuel_monitor: <FuelMonitorPage />,
  users: <UsersPage />,
  auto_reactions: <AutoReactionsPage />,
  group_access: <GroupAccessPage />,
  // Three sidebar entries, one Settings page. "Settings" alone did not say
  // which settings, so the bare key is retired into LEGACY_PAGE_KEYS and each
  // entry names the thing a person came looking for.
  settings_integrations: <SettingsPage />,
  settings_board: <SettingsPage initialTab="board" />,
  settings_ai: <SettingsPage initialTab="ai" />,
  recruiter_kpis: <RecruiterKpiPage />,
  live_locations: <LiveLocationsPage />,
  route_control: <RouteControlPage />,
  operations: <OperationsPage />,
  // "Is everything running?" is a question about the whole system, not a
  // sub-question of Needs Attention, so it gets its own sidebar entry onto the
  // tab that answers it.
  system_health: <OperationsPage initialTab="systems" />,
};

export { PAGE_COMPONENTS };

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState(() => initialPage());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isRaisePublicPage = page === "raise_public";
  const isRecruitersPublicPage = page === "recruiters_public";

  useEffect(() => {
    // Back/forward must move the selected page AND the active sidebar item.
    // `hashchange` is listened to as well as `popstate` because a hash-only
    // change made by typing in the address bar does not always fire popstate.
    const handleLocationChange = () => {
      setPage(initialPage());
    };

    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    handleLocationChange();

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem("token");
        if (token) {
          const verified = await api.verifyAuth();
          if (!verified) localStorage.removeItem("token");
          setSession(verified);
          setAuthed(Boolean(verified));
        }
      } catch (err) {
        localStorage.removeItem("token");
        setAuthed(false);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const navigateToPage = (nextPage) => {
    setPage(nextPage);
    setMobileMenuOpen(false);

    // pushState, not replaceState: moving between sections is navigation a
    // person expects Back to undo. The hash is what makes the destination
    // nameable at all — every admin page is the same path.
    const nextUrl = `/admin${hashForPageKey(nextPage)}`;
    if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
      window.history.pushState({}, "", nextUrl);
    }
  };

  const handleLogout = () => {
    api.logout();
    setAuthed(false);
    setSession(null);
    setPage(DEFAULT_PAGE_KEY);
    setMobileMenuOpen(false);
    // Drop the hash too: leaving `#settings_ai` on a signed-out shell would
    // send the next person who signs in straight back to it.
    if (`${window.location.pathname}${window.location.hash}` !== "/admin") {
      window.history.replaceState({}, "", "/admin");
    }
  };

  if (isRaisePublicPage) {
    return (
      <main className="main-content" style={{ marginLeft: 0 }}>
        <LazyPage pageKey="raise_public"><RaisePublicPage /></LazyPage>
      </main>
    );
  }

  // Full-bleed public leaderboard — no admin chrome, no auth.
  if (isRecruitersPublicPage) {
    return <LazyPage pageKey="recruiters_public"><RecruitersPublicPage /></LazyPage>;
  }

  if (checking) {
    return (
      <div className="loading" style={{ minHeight: "100vh" }}>
        <div className="spinner"></div> Loading...
      </div>
    );
  }

  if (!authed) {
    // After login, the URL is re-read so a person who arrived on
    // `/admin#fuel_monitor` lands back on Fuel Monitor rather than the default.
    return (
      <LoginPage
        onLogin={(loginSession) => {
          setAuthed(true);
          setSession(loginSession);
          setPage(initialPage());
        }}
      />
    );
  }


  // Every section is company-wide administration, so an account without
  // admin.full_access has nothing it can open. Say so plainly rather than
  // rendering a section whose every request would come back 403.
  const isFullAdmin = session?.permissions?.includes("admin.full_access");

  return (
    <AuthProvider session={session}>
    <div className="app-layout">
      <AdminSidebar
        session={session}
        page={page}
        mobileMenuOpen={mobileMenuOpen}
        onNavigateToPage={navigateToPage}
        onLogout={handleLogout}
      />
      <main className="main-content" onClick={() => setMobileMenuOpen(false)}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: "20px" }}>
          <button
            className="mobile-menu-btn"
            onClick={(event) => {
              event.stopPropagation();
              setMobileMenuOpen(!mobileMenuOpen);
            }}
          >
            ☰
          </button>
        </div>
        {/* Shown only at 80%+ of the monthly database transfer allowance, so
            running out is not discovered by reads starting to fail. */}
        <DatabaseUsageBanner />
        {isFullAdmin ? (
          <LazyPage key={page} pageKey={page}>
            {PAGE_COMPONENTS[page] || PAGE_COMPONENTS[DEFAULT_PAGE_KEY]}
          </LazyPage>
        ) : (
          <div className="card">
            <h2>No sections available</h2>
            <p>
              This account does not have administrator access, so there is
              nothing here it can open. Ask a super administrator to grant the
              access you need.
            </p>
          </div>
        )}
      </main>
    </div>
    </AuthProvider>
  );
}
