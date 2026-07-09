import React, { Suspense, lazy, useEffect, useState } from "react";
import * as api from "./api";
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from "./pages/LoginPage";

// After a deployment the hashed chunk filenames change, so a browser still
// running the OLD index.html asks for a chunk that no longer exists → the
// dynamic import rejects. `lazyWithRetry` recovers automatically: on the first
// failure it forces ONE full page reload (fetching the fresh index.html with the
// new hashes). A sessionStorage flag prevents an infinite reload loop — if the
// import still fails after we've already reloaded once, the error propagates to
// ChunkErrorBoundary so the user gets a manual Reload button instead.
const CHUNK_RELOAD_FLAG = "adminChunkReloadedOnce";
function lazyWithRetry(importer) {
  return lazy(async () => {
    try {
      const mod = await importer();
      // Loaded cleanly — clear the guard so a future stale deploy can retry too.
      try { window.sessionStorage.removeItem(CHUNK_RELOAD_FLAG); } catch { /* ignore */ }
      return mod;
    } catch (err) {
      let alreadyReloaded = false;
      try { alreadyReloaded = window.sessionStorage.getItem(CHUNK_RELOAD_FLAG) === "1"; } catch { /* ignore */ }
      if (!alreadyReloaded) {
        try { window.sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1"); } catch { /* ignore */ }
        // Cache-busting hard reload: re-request index.html so the new chunk
        // hashes are picked up. Return a never-settling promise so nothing
        // renders (and the error boundary does not flash) before the reload.
        hardReload();
        return new Promise(() => {});
      }
      throw err; // second failure → let ChunkErrorBoundary show the Reload UI
    }
  });
}

/** Force a fresh index.html fetch, defeating an intermediate/browser cache. */
function hardReload() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("_r", String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

// Every other page is lazy-loaded so its code is fetched only when the page
// is opened — the initial admin bundle stays small.
const GroupsPage = lazyWithRetry(() => import("./pages/GroupsPage"));
const QuestionsPage = lazyWithRetry(() => import("./pages/QuestionsPage"));
const BroadcastPage = lazyWithRetry(() => import("./pages/BroadcastPage"));
const ScheduledMessagesPage = lazyWithRetry(() => import("./pages/ScheduledMessagesPage"));
const MessageManagerPage = lazyWithRetry(() => import("./pages/MessageManagerPage"));
const BotMessagesPage = lazyWithRetry(() => import("./pages/BotMessagesPage"));
const CompanyBirthdaysPage = lazyWithRetry(() => import("./pages/CompanyBirthdaysPage"));
const DispatchPage = lazyWithRetry(() => import("./pages/DispatchPage"));
const FacebookLeadsPage = lazyWithRetry(() => import("./pages/FacebookLeadsPage"));
const LeadsPage = lazyWithRetry(() => import("./pages/LeadsPage"));
const MileageBonusPage = lazyWithRetry(() => import("./pages/MileageBonusPage"));
const RaiseApprovalPage = lazyWithRetry(() => import("./pages/RaiseApprovalPage"));
const RaisePublicPage = lazyWithRetry(() => import("./pages/RaisePublicPage"));
const HomeTimePage = lazyWithRetry(() => import("./pages/HomeTimePage"));
const GroupAccessPage = lazyWithRetry(() => import("./pages/GroupAccessPage"));
const FuelMonitorPage = lazyWithRetry(() => import("./pages/FuelMonitorPage"));
const UsersPage = lazyWithRetry(() => import("./pages/UsersPage"));
const SettingsPage = lazyWithRetry(() => import("./pages/SettingsPage"));
const RecruiterKpiPage = lazyWithRetry(() => import("./pages/RecruiterKpiPage"));
const RecruitersPublicPage = lazyWithRetry(() => import("./pages/RecruitersPublicPage"));
const LiveLocationsPage = lazyWithRetry(() => import("./pages/LiveLocationsPage"));
const RouteControlPage = lazyWithRetry(() => import("./pages/RouteControlPage"));

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
          <button
            className="btn btn-primary"
            onClick={() => {
              // Clear the one-shot guard so the button's reload is allowed to
              // try the auto-recovery path again with a fresh index.html.
              try { window.sessionStorage.removeItem(CHUNK_RELOAD_FLAG); } catch { /* ignore */ }
              hardReload();
            }}
          >
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
  return "groups";
}

function getPathForPage(page) {
  return page === "dispatch" ? "/dispatch" : "/admin";
}

export default function App() {
  const [authed, setAuthed] = useState(false);
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
          const valid = await api.verifyAuth();
          if (!valid) localStorage.removeItem("token");
          setAuthed(valid);
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
        onLogin={() => {
          setAuthed(true);
          setPage(getPageFromPath(window.location.pathname));
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
  };

  const NAV_SECTIONS = [
    {
      label: 'Operations',
      color: '#22c55e',
      items: [
        { key: 'dispatch', icon: '🚚', label: 'Dispatch Center' },
        { key: 'live_locations', icon: '📍', label: 'Live Locations' },
        { key: 'route_control', icon: '🧭', label: 'Route Control' },
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

  return (
    <div className="app-layout">
      <aside className={`sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-logo">
          <h1>🚛 Driver Feedback</h1>
          <p>Admin Panel</p>
        </div>
        <nav className="sidebar-nav">
          {NAV_SECTIONS.map((section) => (
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
          <div className="nav-section">
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
          </div>
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
  );
}
