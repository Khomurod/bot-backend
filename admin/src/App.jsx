import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import * as api from "./api";
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from "./pages/LoginPage";
import { AuthProvider } from "./context/AuthContext";
import AdminSidebar, { labelForPage } from "./components/AdminSidebar";
import Icon from "./components/ui/Icon";
import PageErrorBoundary from "./components/PageErrorBoundary";
import DatabaseUsageBanner from "./components/DatabaseUsageBanner";
import ChangePasswordModal from "./components/ChangePasswordModal";
import { DEFAULT_PAGE_KEY, hashForRoute, routeFromHash } from "./navigation/pageKeys";

// Every other page is lazy-loaded so its code is fetched only when the page
// is opened — the initial admin bundle stays small.
const GroupsPage = lazy(() => import("./pages/GroupsPage"));
const CommunicationsPage = lazy(() => import("./pages/CommunicationsPage"));
const BirthdaysPage = lazy(() => import("./pages/BirthdaysPage"));
const FacebookLeadsPage = lazy(() => import("./pages/FacebookLeadsPage"));
const LeadsPage = lazy(() => import("./pages/LeadsPage"));
const MileageBonusPage = lazy(() => import("./pages/MileageBonusPage"));
const HomeTimePage = lazy(() => import("./pages/HomeTimePage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const RecruiterKpiPage = lazy(() => import("./pages/RecruiterKpiPage"));
const RecruitersPublicPage = lazy(() => import("./pages/RecruitersPublicPage"));
const GrossRacePage = lazy(() => import("./pages/grossRace/GrossRacePage"));
const LiveLocationsPage = lazy(() => import("./pages/LiveLocationsPage"));
const OperationsPage = lazy(() => import("./pages/OperationsPage"));
const RetentionPage = lazy(() => import("./pages/RetentionPage"));
const SystemHealthPage = lazy(() => import("./pages/SystemHealthPage"));

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
 * THE CALLER ALSO PASSES `key={page}`, so leaving a page and coming back is a
 * fresh mount — and a tab change within a page is NOT one: the tab comes from
 * the address as a prop, and remounting the page on every tab would refetch
 * everything it had loaded. `pageKey` DOES include the tab, so a section that
 * failed is cleared by choosing another one — the six sidebar entries Settings
 * used to have did that by being six keys.
 */
function LazyPage({ pageKey, children }) {
  return (
    <PageErrorBoundary resetKey={pageKey}>
      <Suspense fallback={pageLoadingFallback}>{children}</Suspense>
    </PageErrorBoundary>
  );
}

/**
 * Which page — and which of its tabs — a URL names.
 *
 * THE PATH DECIDES THE SHELL; THE HASH DECIDES THE ADMIN PAGE AND TAB
 * (`/admin#settings/board`). The two public
 * pages have paths of their own and no sidebar. Every admin page shares
 * `/admin`, so the page within it is the hash — which is new. Until now
 * `/admin` was the only URL the panel ever produced, so no admin screen could
 * be bookmarked, shared in a chat, or reached with Back.
 *
 * An absent, unreadable or retired hash resolves through
 * `navigation/pageKeys.js`: a key that moved opens where its content went, and
 * anything else opens Driver Groups — the page the shell has always opened on.
 *
 * `/dispatch` and `/dispatchteam` are the Gross Grand Prix race displays, and
 * only those exact paths: `/dispatch/…` was the retired Dispatch Center, which
 * the server answers with 410 before the SPA is ever served, so a held deep
 * link gets "this feature has been removed" rather than the shell quietly
 * rendering Driver Groups. See server/routes/retiredRoutes.js.
 */
function routeFromLocation(pathname, hash) {
  if (pathname === "/dispatch") return { page: "gross_race_dispatchers", tab: null };
  if (pathname === "/dispatchteam") return { page: "gross_race_teams", tab: null };
  if (pathname === "/recruiters" || pathname.startsWith("/recruiters/")) {
    return { page: "recruiters_public", tab: null };
  }
  return routeFromHash(hash) || { page: DEFAULT_PAGE_KEY, tab: null };
}

function currentRoute() {
  return routeFromLocation(window.location.pathname, window.location.hash);
}

/**
 * Every page key the shell can render, and what it renders.
 *
 * Module level, and EXPORTED, on purpose. This list and the sidebar's item list
 * are the same vocabulary authored twice; exporting it is what lets
 * `navigation/pageKeys.test.jsx` assert they agree, which nothing did before —
 * a typo in either simply missed the lookup and rendered Driver Groups.
 *
 * Each entry is a function of the route, because a page with tabs takes its
 * open tab from the address (`#settings/board`) and reports a change back; a
 * page without tabs ignores it. One key, one page: a tab is no longer a key.
 */
const PAGE_COMPONENTS = {
  // Drivers
  groups: () => <GroupsPage />,
  live_locations: () => <LiveLocationsPage />,
  home_time: (route) => <HomeTimePage {...route} />,
  mileage_bonus: () => <MileageBonusPage />,
  retention: () => <RetentionPage />,
  // Recruiting
  leads: () => <LeadsPage />,
  facebook_leads: (route) => <FacebookLeadsPage {...route} />,
  recruiter_kpis: () => <RecruiterKpiPage />,
  // Communications. Send Message, Surveys, Scheduled, History and Edit by Link
  // are five tabs of ONE page; their old keys live in LEGACY_PAGE_KEYS, so a
  // bookmarked `#broadcast` opens that tab instead of Driver Groups.
  communications: (route) => <CommunicationsPage {...route} />,
  company_birthdays: (route) => <BirthdaysPage {...route} />,
  // Monitoring
  operations: (route) => <OperationsPage {...route} />,
  system_health: () => <SystemHealthPage />,
  // Administration
  users: () => <UsersPage />,
  settings: (route) => <SettingsPage {...route} />,
};

export { PAGE_COMPONENTS };

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [route, setRoute] = useState(() => currentRoute());
  const page = route.page;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  // Opened from the phone drawer, Change password hands focus back to the menu
  // button when it closes: the drawer it was opened from has slid away.
  const menuButtonRef = useRef(null);
  const [passwordFromDrawer, setPasswordFromDrawer] = useState(false);
  const isRecruitersPublicPage = page === "recruiters_public";
  const grossRaceView = { gross_race_teams: "teams", gross_race_dispatchers: "dispatchers" }[page] || null;

  useEffect(() => {
    // Back/forward must move the selected page AND the active sidebar item.
    // `hashchange` is listened to as well as `popstate` because a hash-only
    // change made by typing in the address bar does not always fire popstate.
    const handleLocationChange = () => {
      const next = currentRoute();
      setRoute(next);
      // An old or mangled admin hash is rewritten IN PLACE to the address of
      // what it opened (`#settings_board` → `#settings/board`), so the link
      // somebody copies from here on is the current one. replaceState: the old
      // address must not become a Back step that re-redirects.
      if (window.location.pathname.startsWith("/admin") && window.location.hash) {
        const canonical = hashForRoute(next.page, next.tab);
        if (window.location.hash !== canonical) {
          window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}${canonical}`);
        }
      }
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
    setRoute({ page: nextPage, tab: null });
    setMobileMenuOpen(false);

    // pushState, not replaceState: moving between sections is navigation a
    // person expects Back to undo. The hash is what makes the destination
    // nameable at all — every admin page is the same path.
    const nextUrl = `/admin${hashForRoute(nextPage)}`;
    if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
      window.history.pushState({}, "", nextUrl);
    }
  };

  // A tab change REPLACES the address rather than adding to it: Back leaves the
  // page, as it did before tabs had addresses, instead of stepping through
  // every tab somebody glanced at. The address still names the tab, so it can
  // be bookmarked and shared.
  //
  // The query string is KEPT: `?dev=1` is what shows Customer Inquiries' Activity
  // Log tab, and dropping it on the first tab click took the tab away.
  const changeTab = (nextTab) => {
    setRoute((current) => ({ ...current, tab: nextTab }));
    const nextHash = hashForRoute(page, nextTab);
    if (window.location.hash !== nextHash) {
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}${nextHash}`);
    }
  };

  const handleLogout = () => {
    api.logout();
    setAuthed(false);
    setSession(null);
    setRoute({ page: DEFAULT_PAGE_KEY, tab: null });
    setMobileMenuOpen(false);
    // Drop the hash too: leaving `#settings/ai` on a signed-out shell would
    // send the next person who signs in straight back to it.
    if (`${window.location.pathname}${window.location.hash}` !== "/admin") {
      window.history.replaceState({}, "", "/admin");
    }
  };

  // Full-bleed public leaderboard — no admin chrome, no auth.
  if (isRecruitersPublicPage) {
    return <LazyPage pageKey="recruiters_public"><RecruitersPublicPage /></LazyPage>;
  }

  // The Gross Grand Prix displays for the office screens — no chrome, no auth.
  if (grossRaceView) {
    return <LazyPage pageKey={page}><GrossRacePage key={grossRaceView} view={grossRaceView} /></LazyPage>;
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
    // `/admin#home_time` lands back on Driver Home Time rather than the default.
    return (
      <LoginPage
        onLogin={(loginSession) => {
          setAuthed(true);
          setSession(loginSession);
          setRoute(currentRoute());
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
        onChangePassword={() => {
          setPasswordFromDrawer(mobileMenuOpen);
          setMobileMenuOpen(false);
          setChangingPassword(true);
        }}
      />
      {changingPassword && (
        <ChangePasswordModal
          onClose={() => setChangingPassword(false)}
          returnFocusRef={passwordFromDrawer ? menuButtonRef : null}
          onSignInAgain={() => { setChangingPassword(false); handleLogout(); }}
        />
      )}
      {/* On a phone the sidebar is a drawer; tapping outside it closes it. */}
      <div
        className={`sidebar-backdrop ${mobileMenuOpen ? "is-open" : ""}`}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />
      <main className="main-content" onClick={() => setMobileMenuOpen(false)}>
        {/* Phones and narrow tablets only (CSS): the menu button and where you are. */}
        <div className="topbar">
          <button
            type="button"
            ref={menuButtonRef}
            className="mobile-menu-btn"
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setMobileMenuOpen(!mobileMenuOpen);
            }}
          >
            <Icon name={mobileMenuOpen ? "close" : "menu"} size={20} />
          </button>
          <span className="topbar-title">{(isFullAdmin && labelForPage(page)) || "Wenze"}</span>
        </div>
        <div className="main-inner">
        {/* Shown only at 80%+ of the monthly database transfer allowance, so
            running out is not discovered by reads starting to fail. */}
        <DatabaseUsageBanner />
        {isFullAdmin ? (
          <LazyPage key={page} pageKey={`${page}/${route.tab || ""}`}>
            {(PAGE_COMPONENTS[page] || PAGE_COMPONENTS[DEFAULT_PAGE_KEY])({ tab: route.tab, onTabChange: changeTab })}
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
        </div>
      </main>
    </div>
    </AuthProvider>
  );
}
