import React, { useEffect, useState } from "react";
import * as api from "./api";
import LoginPage from "./pages/LoginPage";
import GroupsPage from "./pages/GroupsPage";
import QuestionsPage from "./pages/QuestionsPage";
import BroadcastPage from "./pages/BroadcastPage";
import AiFeaturesPage from "./pages/AiFeaturesPage";
import ScheduledMessagesPage from "./pages/ScheduledMessagesPage";
import EmployeeVotingPage from "./pages/EmployeeVotingPage";
import ChatLogsPage from "./pages/ChatLogsPage";
import MessageManagerPage from "./pages/MessageManagerPage";
import CompanyBirthdaysPage from "./pages/CompanyBirthdaysPage";
import DispatchPage from "./pages/DispatchPage";
import FacebookLeadsPage from "./pages/FacebookLeadsPage";

function getPageFromPath(pathname) {
  if (pathname === "/dispatch" || pathname.startsWith("/dispatch/")) {
    return "dispatch";
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
  const isDispatchPage = page === "dispatch";

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
    groups: <GroupsPage />,
    questions: <QuestionsPage />,
    broadcast: <BroadcastPage />,
    dispatch: <DispatchPage />,
    ai_insights: <AiFeaturesPage />,
    scheduled: <ScheduledMessagesPage />,
    voting: <EmployeeVotingPage />,
    logs: <ChatLogsPage />,
    manager: <MessageManagerPage />,
    company_birthdays: <CompanyBirthdaysPage />,
    facebook_leads: <FacebookLeadsPage />,
  };

  return (
    <div className="app-layout">
      <aside className={`sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-logo">
          <h1>🚛 Driver Feedback</h1>
          <p>Admin Panel</p>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${page === "groups" ? "active" : ""}`}
            onClick={() => navigateToPage("groups")}
          >
            <span className="nav-icon">👥</span>
            Groups
          </button>
          <button
            className={`nav-item ${page === "questions" ? "active" : ""}`}
            onClick={() => navigateToPage("questions")}
          >
            <span className="nav-icon">📝</span>
            Questions
          </button>
          <button
            className={`nav-item ${page === "broadcast" ? "active" : ""}`}
            onClick={() => navigateToPage("broadcast")}
          >
            <span className="nav-icon">📢</span>
            Broadcast
          </button>
          <button
            className={`nav-item ${page === "dispatch" ? "active" : ""}`}
            onClick={() => navigateToPage("dispatch")}
          >
            <span className="nav-icon">📄</span>
            Dispatch
          </button>
          <button
            className={`nav-item ${page === "ai_insights" ? "active" : ""}`}
            onClick={() => navigateToPage("ai_insights")}
          >
            <span className="nav-icon">🧠</span>
            AI Insights
          </button>
          <button
            className={`nav-item ${page === "logs" ? "active" : ""}`}
            onClick={() => navigateToPage("logs")}
          >
            <span className="nav-icon">💬</span>
            Live Chat Logs
          </button>
          <button
            className={`nav-item ${page === "scheduled" ? "active" : ""}`}
            onClick={() => navigateToPage("scheduled")}
          >
            <span className="nav-icon">📅</span>
            Scheduled
          </button>
          <button
            className={`nav-item ${page === "voting" ? "active" : ""}`}
            onClick={() => navigateToPage("voting")}
          >
            <span className="nav-icon">🏆</span>
            Employee Voting
          </button>
          <button
            className={`nav-item ${page === "manager" ? "active" : ""}`}
            onClick={() => navigateToPage("manager")}
          >
            <span className="nav-icon">🛠️</span>
            Message Manager
          </button>
          <button
            className={`nav-item ${page === "company_birthdays" ? "active" : ""}`}
            onClick={() => navigateToPage("company_birthdays")}
          >
            <span className="nav-icon">🏢</span>
            Employee Birthdays
          </button>
          <button
            className={`nav-item ${page === "facebook_leads" ? "active" : ""}`}
            onClick={() => navigateToPage("facebook_leads")}
          >
            <span className="nav-icon">📣</span>
            Facebook Leads
          </button>
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
        {pages[page] || pages.groups}
      </main>
    </div>
  );
}
