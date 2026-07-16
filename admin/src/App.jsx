import React, { Suspense, lazy, useEffect, useState } from "react";
import * as api from "./api";
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from "./pages/LoginPage";
import { AuthProvider } from "./context/AuthContext";

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
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const RecruiterKpiPage = lazy(() => import("./pages/RecruiterKpiPage"));
const RecruitersPublicPage = lazy(() => import("./pages/RecruitersPublicPage"));
const LiveLocationsPage = lazy(() => import("./pages/LiveLocationsPage"));
const RouteControlPage = lazy(() => import("./pages/RouteControlPage"));
const TrailerTrackingPage = lazy(() => import("./pages/TrailerTrackingPage"));
const TrailerDepartmentShell = lazy(() => import("./pages/trailer/TrailerDepartmentShell"));

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
  if (pathname === "/admin/trailers" || pathname.startsWith("/admin/trailers/")) {
    return "trailer_department";
  }
  return "groups";
}

function getPathForPage(page) {
  if (page === "dispatch") return "/dispatch";
  if (page === "trailer_department") return "/admin/trailers/dashboard";
  return "/admin";
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState(() => getPageFromPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [adminExpanded, setAdminExpanded] = useState(false);
  const isDispatchPage = page === "dispatch";
  const isRaisePublicPage = page === "raise_public";
  const isRecruitersPublicPage = page === "recruiters_public";

  useEffect(() => {
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
          if (verified && !verified.permissions?.includes('admin.full_access') && verified.permissions?.some((p) => p.startsWith('trailer'))) {
            setPage('trailer_department');
            window.history.replaceState({}, '', '/admin/trailers/dashboard');
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
        <LazyPage><RaisePublicPage /></LazyPage>
      </main>
    );
  }

  // Full-bleed public leaderboard — no admin chrome, no auth.
  if (isRecruitersPublicPage) {
    return <LazyPage><RecruitersPublicPage /></LazyPage>;
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
          setPage(trailerOnly ? 'trailer_department' : getPageFromPath(window.location.pathname));
          if (trailerOnly) window.history.replaceState({}, '', '/admin/trailers/dashboard');
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
    group_access: <GroupAccessPage />,
    manager: <MessageManagerPage />,
    bot_messages: <BotMessagesPage />,
    scheduled: <ScheduledMessagesPage />,
    settings: <SettingsPage />,
    recruiter_kpis: <RecruiterKpiPage />,
    live_locations: <LiveLocationsPage />,
    route_control: <RouteControlPage />,
    trailer_tracking: <TrailerTrackingPage />,
    trailer_department: <TrailerDepartmentShell />,
  };

  const NAV_SECTIONS = [
    {
      label: 'Operations',
      color: '#22c55e',
      items: [
        { key: 'dispatch', icon: '🚚', label: 'Dispatch Center' },
        { key: 'live_locations', icon: '📍', label: 'Live Locations' },
        { key: 'route_control', icon: '🧭', label: 'Route Control' },
        { key: 'trailer_tracking', icon: '🚚', label: 'Trailer Tracking' },
        { key: 'trailer_department', icon: '🏢', label: 'Trailer Department' },
        { key: 'leads', icon: '📥', label: 'Leads' },
        { key: 'facebook_leads', icon: '👥', label: 'Customer Inquiries' },
        { key: 'recruiter_kpis', icon: '📞', label: 'Recruiter KPIs' },
      ],
    },
    {
      label: 'Communications',
      color: '#6366f1',
      items: [
        { key: 'broadcast', icon: '📢', label: 'Send Message' },
        { key: 'questions', icon: '📝', label: 'Surveys' },
      ],
    },
    {
      label: 'Team',
      color: '#a78bfa',
      items: [
        { key: 'groups', icon: '👷', label: 'Driver Groups' },
        { key: 'company_birthdays', icon: '🎂', label: 'Birthdays' },
        { key: 'mileage_bonus', icon: '🏁', label: 'Mileage Bonuses' },
        { key: 'raise_approval', icon: '💵', label: 'Driver Raises' },
        { key: 'home_time', icon: '🏠', label: 'Driver Home Time' },
        { key: 'fuel_monitor', icon: '⛽', label: 'Fuel Monitor' },
        { key: 'users', icon: '👤', label: 'Users' },
        { key: 'group_access', icon: '🔍', label: 'Bot Group Access' },
      ],
    },
  ];

  const ADMIN_ITEMS = [
    { key: 'manager', icon: '🛠️', label: 'Edit Message' },
    { key: 'bot_messages', icon: '📨', label: 'Bot Messages' },
    { key: 'scheduled', icon: '📅', label: 'Scheduled Messages' },
    { key: 'settings', icon: '⚙️', label: 'Settings' },
  ];

  const isFullAdmin = session?.permissions?.includes('admin.full_access');
  const visibleSections = NAV_SECTIONS.map((section) => ({ ...section, items: section.items.filter((item) => isFullAdmin || item.key === 'trailer_department') })).filter((section) => section.items.length);

  return (
    <AuthProvider session={session}>
    <div className="app-layout">
      <aside className={`sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-logo">
          <h1>🚛 Driver Feedback</h1>
          <p>Admin Panel</p>
        </div>
        <nav className="sidebar-nav">
          {visibleSections.map((section) => (
            <div key={section.label} className="nav-section">
              <div className="nav-section-header" style={{ borderLeftColor: section.color }}>
                {section.label}
              </div>
              {section.items.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${page === item.key ? "active" : ""}`}
                  onClick={() => navigateToPage(item.key)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          {isFullAdmin && <div className="nav-section">
            <button
              className="nav-section-header nav-section-toggle"
              onClick={() => setAdminExpanded(!adminExpanded)}
              style={{ borderLeftColor: '#64748b' }}
            >
              ⚙️ Admin
              <span className="nav-section-arrow">{adminExpanded ? '▾' : '▸'}</span>
            </button>
            {adminExpanded && ADMIN_ITEMS.map((item) => (
              <button
                key={item.key}
                className={`nav-item ${page === item.key ? "active" : ""}`}
                onClick={() => navigateToPage(item.key)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>}
        </nav>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout}>
            <span className="nav-icon">🚪</span>
            Sign Out
          </button>
        </div>
      </aside>
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
