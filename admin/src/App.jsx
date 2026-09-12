import React, { Suspense, lazy, useEffect, useState } from "react";
import * as api from "./api";
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from "./pages/LoginPage";
import { AuthProvider } from "./context/AuthContext";
import AdminSidebar from "./components/AdminSidebar";
import PageErrorBoundary from "./components/PageErrorBoundary";
import DatabaseUsageBanner from "./components/DatabaseUsageBanner";

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
 */
function LazyPage({ pageKey, children }) {
  return (
    <PageErrorBoundary resetKey={pageKey}>
      <Suspense fallback={pageLoadingFallback}>{children}</Suspense>
    </PageErrorBoundary>
  );
}

function getPageFromPath(pathname) {
  // `/dispatch` is NOT here any more. The Dispatch Center is retired and the
  // server answers 410 on that path before the SPA is ever served, so a held
  // bookmark gets a plain "this feature has been removed" rather than the shell
  // quietly rendering Driver Groups. See server/routes/retiredRoutes.js.
  if (pathname === "/raise" || pathname.startsWith("/raise/")) {
    return "raise_public";
  }
  if (pathname === "/recruiters" || pathname.startsWith("/recruiters/")) {
    return "recruiters_public";
  }
  return "groups";
}

function getPathForPage() {
  return "/admin";
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState(() => getPageFromPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [adminExpanded, setAdminExpanded] = useState(false);
  const isRaisePublicPage = page === "raise_public";
  const isRecruitersPublicPage = page === "recruiters_public";

  useEffect(() => {
    // Back/forward must move the selected page AND the active sidebar item.
    const handlePopState = () => {
      setPage(getPageFromPath(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    handlePopState();

    return () => window.removeEventListener("popstate", handlePopState);
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

    const nextPath = getPathForPage(nextPage);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
  };

  const handleLogout = () => {
    api.logout();
    setAuthed(false);
    setSession(null);
    setPage("groups");
    setMobileMenuOpen(false);
    if (window.location.pathname !== "/admin") {
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
    // After login, getPageFromPath restores the originally requested page, so
    // the user lands back where they asked for.
    return (
      <LoginPage
        onLogin={(loginSession) => {
          setAuthed(true);
          setSession(loginSession);
          setPage(getPageFromPath(window.location.pathname));
        }}
      />
    );
  }

  const pages = {
    facebook_leads: <FacebookLeadsPage />,
    leads: <LeadsPage />,
    // Send Message, Surveys, Scheduled, History and Edit by Link are five tabs
    // of ONE page now; `broadcast`, `questions`, `scheduled`, `bot_messages`
    // and `manager` are gone as page keys rather than left here pointing at a
    // tab, because page state is in-memory and comes only from the sidebar —
    // a key no nav item produces would be a map entry nothing can reach.
    // See pages/CommunicationsPage.jsx.
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
    settings: <SettingsPage />,
    recruiter_kpis: <RecruiterKpiPage />,
    live_locations: <LiveLocationsPage />,
    route_control: <RouteControlPage />,
    operations: <OperationsPage />,
  };

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
        adminExpanded={adminExpanded}
        onToggleAdmin={() => setAdminExpanded(!adminExpanded)}
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
          <LazyPage pageKey={page}>
            {pages[page] || pages.groups}
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
