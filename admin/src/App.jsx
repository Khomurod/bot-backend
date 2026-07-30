import React, { Suspense, lazy, useEffect, useState } from "react";
import * as api from "./api";
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from "./pages/LoginPage";
import { AuthProvider } from "./context/AuthContext";
import AdminSidebar from "./components/AdminSidebar";
import {
  defaultTrailerSection,
  trailerSectionFromPath,
  trailerSectionPath,
} from "./pages/trailer/trailerNavigation";

// Every other page is lazy-loaded so its code is fetched only when the page
// is opened — the initial admin bundle stays small.
const GroupsPage = lazy(() => import("./pages/GroupsPage"));
const QuestionsPage = lazy(() => import("./pages/QuestionsPage"));
const BroadcastPage = lazy(() => import("./pages/BroadcastPage"));
const ScheduledMessagesPage = lazy(() => import("./pages/ScheduledMessagesPage"));
const MessageManagerPage = lazy(() => import("./pages/MessageManagerPage"));
const BotMessagesPage = lazy(() => import("./pages/BotMessagesPage"));
const CompanyBirthdaysPage = lazy(() => import("./pages/CompanyBirthdaysPage"));
const DispatchPage = lazy(() => import("./pages/DispatchPage"));
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
const TrailerTrackingPage = lazy(() => import("./pages/TrailerTrackingPage"));
const TrailerDepartmentShell = lazy(() => import("./pages/trailer/TrailerDepartmentShell"));
// QBQ / SOS assessment: two public bright-themed pages + a full-admin section.
const SosQuestionsPage = lazy(() => import("./pages/sosPublic/SosQuestionsPage"));
const SosAnswersPage = lazy(() => import("./pages/sosPublic/SosAnswersPage"));
const SosAdminPage = lazy(() => import("./pages/sos/SosAdminPage"));

const pageLoadingFallback = (
  <div className="loading">
    <div className="spinner"></div> Loading...
  </div>
);

/**
 * A failed lazy chunk (deploy replaced the hashed file, network hiccup) must
 * never leave a blank screen — offer a reload instead.
 */
class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="loading" style={{ flexDirection: "column", gap: 12 }}>
          <div>Could not load this page (a new version may have been deployed).</div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Shared wrapper: chunk-failure boundary + suspense fallback for lazy pages. */
function LazyPage({ children }) {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={pageLoadingFallback}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}

function getPageFromPath(pathname) {
  if (pathname === "/dispatch" || pathname.startsWith("/dispatch/")) {
    return "dispatch";
  }
  if (pathname === "/raise" || pathname.startsWith("/raise/")) {
    return "raise_public";
  }
  if (pathname === "/recruiters" || pathname.startsWith("/recruiters/")) {
    return "recruiters_public";
  }
  if (pathname === "/questions" || pathname.startsWith("/questions/")) {
    return "sos_questions_public";
  }
  if (pathname === "/answers" || pathname.startsWith("/answers/")) {
    return "sos_answers_public";
  }
  if (pathname === "/admin/trailers" || pathname.startsWith("/admin/trailers/")) {
    return "trailer_department";
  }
  return "groups";
}

function getPathForPage(page) {
  if (page === "dispatch") return "/dispatch";
  return "/admin";
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState(() => getPageFromPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [adminExpanded, setAdminExpanded] = useState(false);
  const [trailerSection, setTrailerSection] = useState(() =>
    trailerSectionFromPath(window.location.pathname),
  );
  const [trailerExpanded, setTrailerExpanded] = useState(() =>
    getPageFromPath(window.location.pathname) === "trailer_department",
  );
  const isDispatchPage = page === "dispatch";
  const isRaisePublicPage = page === "raise_public";
  const isRecruitersPublicPage = page === "recruiters_public";
  const isSosQuestionsPage = page === "sos_questions_public";
  const isSosAnswersPage = page === "sos_answers_public";

  useEffect(() => {
    // Back/forward must move the selected page AND the active sidebar item.
    const handlePopState = () => {
      const nextPage = getPageFromPath(window.location.pathname);
      setPage(nextPage);
      if (nextPage === "trailer_department") {
        setTrailerSection(trailerSectionFromPath(window.location.pathname));
        setTrailerExpanded(true);
      }
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
          if (verified && !verified.permissions?.includes('admin.full_access') && verified.permissions?.some((p) => p.startsWith('trailer'))) {
            openTrailerDepartmentOnLoad(verified.permissions);
          }
        }
      } catch (err) {
        localStorage.removeItem("token");
        setAuthed(false);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  /** Trailer-only accounts land straight in the department on first paint. */
  function openTrailerDepartmentOnLoad(permissions) {
    const section = defaultTrailerSection(permissions);
    setPage("trailer_department");
    setTrailerSection(section);
    setTrailerExpanded(true);
    window.history.replaceState({}, "", trailerSectionPath(section));
  }

  const navigateToTrailerSection = (sectionKey, query) => {
    setPage("trailer_department");
    setTrailerSection(sectionKey);
    setTrailerExpanded(true);
    setMobileMenuOpen(false);
    const nextPath = trailerSectionPath(sectionKey) + (query ? `?${query}` : "");
    if (window.location.pathname !== nextPath || query) {
      window.history.pushState({}, "", nextPath);
    }
  };

  const navigateToPage = (nextPage) => {
    if (nextPage === "trailer_department") {
      return navigateToTrailerSection(defaultTrailerSection(session?.permissions));
    }
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
        <LazyPage><RaisePublicPage /></LazyPage>
      </main>
    );
  }

  // Full-bleed public leaderboard — no admin chrome, no auth.
  if (isRecruitersPublicPage) {
    return <LazyPage><RecruitersPublicPage /></LazyPage>;
  }

  // Public QBQ/SOS pages — own bright theme, no admin chrome, no auth.
  if (isSosQuestionsPage) {
    return <LazyPage><SosQuestionsPage /></LazyPage>;
  }
  if (isSosAnswersPage) {
    return <LazyPage><SosAnswersPage /></LazyPage>;
  }

  if (checking) {
    return (
      <div className="loading" style={{ minHeight: "100vh" }}>
        <div className="spinner"></div> Loading...
      </div>
    );
  }

  if (!authed) {
    // Covers /dispatch too: after login, getPageFromPath restores the
    // originally requested page, so the user lands back on Dispatch Center.
    return (
      <LoginPage
        onLogin={(loginSession) => {
          setAuthed(true);
          setSession(loginSession);
          const trailerOnly = !loginSession?.permissions?.includes('admin.full_access') && loginSession?.permissions?.some((p) => p.startsWith('trailer'));
          if (trailerOnly) openTrailerDepartmentOnLoad(loginSession.permissions);
          else setPage(getPageFromPath(window.location.pathname));
        }}
      />
    );
  }

  // Dispatch Center keeps its dedicated full-width layout (no sidebar), but
  // only renders once the admin token has been verified above.
  if (isDispatchPage) {
    return (
      <main className="main-content" style={{ marginLeft: 0 }}>
        <LazyPage><DispatchPage /></LazyPage>
      </main>
    );
  }



  const pages = {
    dispatch: <DispatchPage />,
    facebook_leads: <FacebookLeadsPage />,
    leads: <LeadsPage />,
    broadcast: <BroadcastPage />,
    questions: <QuestionsPage />,
    groups: <GroupsPage />,
    company_birthdays: <CompanyBirthdaysPage />,
    mileage_bonus: <MileageBonusPage />,
    raise_approval: <RaiseApprovalPage />,
    home_time: <HomeTimePage />,
    fuel_monitor: <FuelMonitorPage />,
    users: <UsersPage />,
    auto_reactions: <AutoReactionsPage />,
    group_access: <GroupAccessPage />,
    manager: <MessageManagerPage />,
    bot_messages: <BotMessagesPage />,
    scheduled: <ScheduledMessagesPage />,
    settings: <SettingsPage />,
    recruiter_kpis: <RecruiterKpiPage />,
    live_locations: <LiveLocationsPage />,
    route_control: <RouteControlPage />,
    trailer_tracking: <TrailerTrackingPage />,
    sos_admin: <SosAdminPage />,
    trailer_department: (
      <TrailerDepartmentShell
        section={trailerSection}
        onNavigate={navigateToTrailerSection}
      />
    ),
  };

  return (
    <AuthProvider session={session}>
    <div className="app-layout">
      <AdminSidebar
        session={session}
        page={page}
        mobileMenuOpen={mobileMenuOpen}
        trailerSection={trailerSection}
        trailerExpanded={trailerExpanded}
        onToggleTrailer={() => setTrailerExpanded((open) => !open)}
        onNavigateToPage={navigateToPage}
        onNavigateToTrailerSection={navigateToTrailerSection}
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
        <LazyPage>{pages[page] || pages.dispatch}</LazyPage>
      </main>
    </div>
    </AuthProvider>
  );
}
