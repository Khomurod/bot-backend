import React, { useEffect, useState } from "react";
import * as api from "./api";
import LoginPage from "./pages/LoginPage";
import GroupsPage from "./pages/GroupsPage";
import QuestionsPage from "./pages/QuestionsPage";
import BroadcastPage from "./pages/BroadcastPage";
import ScheduledMessagesPage from "./pages/ScheduledMessagesPage";
import EmployeeVotingPage from "./pages/EmployeeVotingPage";
import MessageManagerPage from "./pages/MessageManagerPage";
import CompanyBirthdaysPage from "./pages/CompanyBirthdaysPage";
import DispatchPage from "./pages/DispatchPage";
import FacebookLeadsPage from "./pages/FacebookLeadsPage";
import LeadsPage from "./pages/LeadsPage";
import MileageBonusPage from "./pages/MileageBonusPage";
import RaiseApprovalPage from "./pages/RaiseApprovalPage";
import RaisePublicPage from "./pages/RaisePublicPage";
import HomeTimePage from "./pages/HomeTimePage";
import GroupAccessPage from "./pages/GroupAccessPage";
import FuelMonitorPage from "./pages/FuelMonitorPage";
import LocationMonitorPage from "./pages/LocationMonitorPage";
import RoastPage from "./pages/RoastPage";

function getPageFromPath(pathname) {
  if (pathname === "/dispatch" || pathname.startsWith("/dispatch/")) {
    return "dispatch";
  }
  if (pathname === "/raise" || pathname.startsWith("/raise/")) {
    return "raise_public";
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

  if (isDispatchPage) {
    return (
      <main className="main-content" style={{ marginLeft: 0 }}>
        <DispatchPage />
      </main>
    );
  }

  if (isRaisePublicPage) {
    return (
      <main className="main-content" style={{ marginLeft: 0 }}>
        <RaisePublicPage />
      </main>
    );
  }

  if (checking) {
    return (
      <div className="loading" style={{ minHeight: "100vh" }}>
        <div className="spinner"></div> Loading...
      </div>
    );
  }

  if (!authed) {
    return (
      <LoginPage
        onLogin={() => {
          setAuthed(true);
          setPage(getPageFromPath(window.location.pathname));
        }}
      />
    );
  }



  const pages = {
    dispatch: <DispatchPage />,
    facebook_leads: <FacebookLeadsPage />,
    leads: <LeadsPage />,
    broadcast: <BroadcastPage />,
    questions: <QuestionsPage />,
    voting: <EmployeeVotingPage />,
    groups: <GroupsPage />,
    company_birthdays: <CompanyBirthdaysPage />,
    roast: <RoastPage />,
    mileage_bonus: <MileageBonusPage />,
    raise_approval: <RaiseApprovalPage />,
    home_time: <HomeTimePage />,
    fuel_monitor: <FuelMonitorPage />,
    location_monitor: <LocationMonitorPage />,
    group_access: <GroupAccessPage />,
    manager: <MessageManagerPage />,
    scheduled: <ScheduledMessagesPage />,
  };

  const NAV_SECTIONS = [
    {
      label: 'Operations',
      color: '#22c55e',
      items: [
        { key: 'dispatch', icon: '🚚', label: 'Dispatch Center' },
        { key: 'leads', icon: '📥', label: 'Leads' },
        { key: 'facebook_leads', icon: '👥', label: 'Customer Inquiries' },
      ],
    },
    {
      label: 'Communications',
      color: '#6366f1',
      items: [
        { key: 'broadcast', icon: '📢', label: 'Send Message' },
        { key: 'questions', icon: '📝', label: 'Surveys' },
        { key: 'voting', icon: '🏆', label: 'Driver Polls' },
      ],
    },
    {
      label: 'Team',
      color: '#a78bfa',
      items: [
        { key: 'groups', icon: '👷', label: 'Driver Groups' },
        { key: 'company_birthdays', icon: '🎂', label: 'Birthdays' },
        { key: 'roast', icon: '😏', label: 'Roast Bot' },
        { key: 'mileage_bonus', icon: '🏁', label: 'Mileage Bonuses' },
        { key: 'raise_approval', icon: '💵', label: 'Driver Raises' },
        { key: 'home_time', icon: '🏠', label: 'Driver Home Time' },
        { key: 'fuel_monitor', icon: '⛽', label: 'Fuel Monitor' },
        { key: 'location_monitor', icon: '📡', label: 'Location Monitor' },
        { key: 'group_access', icon: '🔍', label: 'Bot Group Access' },
      ],
    },
  ];

  const ADMIN_ITEMS = [
    { key: 'manager', icon: '🛠️', label: 'Edit Message' },
    { key: 'scheduled', icon: '📅', label: 'Scheduled Messages' },
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
        {pages[page] || pages.dispatch}
      </main>
    </div>
  );
}
