import React, { useState, useEffect } from "react";
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

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState("groups");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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

  const handleLogout = () => {
    api.logout();
    setAuthed(false);
  };

  if (checking) {
    return (
      <div className="loading" style={{ minHeight: "100vh" }}>
        <div className="spinner"></div> Loading...
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onLogin={() => setAuthed(true)} />;
  }

  const pages = {
    groups: <GroupsPage />,
    questions: <QuestionsPage />,
    broadcast: <BroadcastPage />,
    ai_insights: <AiFeaturesPage />,
    scheduled: <ScheduledMessagesPage />,
    voting: <EmployeeVotingPage />,
    logs: <ChatLogsPage />,
    manager: <MessageManagerPage />,
    company_birthdays: <CompanyBirthdaysPage />,
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
            onClick={() => setPage("groups")}
          >
            <span className="nav-icon">👥</span>
            Groups
          </button>
          <button
            className={`nav-item ${page === "questions" ? "active" : ""}`}
            onClick={() => setPage("questions")}
          >
            <span className="nav-icon">📝</span>
            Questions
          </button>
          <button
            className={`nav-item ${page === "broadcast" ? "active" : ""}`}
            onClick={() => setPage("broadcast")}
          >
            <span className="nav-icon">📢</span>
            Broadcast
          </button>
          <button
            className={`nav-item ${page === "ai_insights" ? "active" : ""}`}
            onClick={() => setPage("ai_insights")}
          >
            <span className="nav-icon">🧠</span>
            AI Insights
          </button>
          <button
            className={`nav-item ${page === "logs" ? "active" : ""}`}
            onClick={() => setPage("logs")}
          >
            <span className="nav-icon">💬</span>
            Live Chat Logs
          </button>
          <button
            className={`nav-item ${page === "scheduled" ? "active" : ""}`}
            onClick={() => setPage("scheduled")}
          >
            <span className="nav-icon">📅</span>
            Scheduled
          </button>
          <button
            className={`nav-item ${page === "voting" ? "active" : ""}`}
            onClick={() => setPage("voting")}
          >
            <span className="nav-icon">🏆</span>
            Employee Voting
          </button>
          <button
            className={`nav-item ${page === "manager" ? "active" : ""}`}
            onClick={() => setPage("manager")}
          >
            <span className="nav-icon">🛠️</span>
            Message Manager
          </button>
          <button
            className={`nav-item ${page === "company_birthdays" ? "active" : ""}`}
            onClick={() => setPage("company_birthdays")}
          >
            <span className="nav-icon">🏢</span>
            Employee Birthdays
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
          <button className="mobile-menu-btn" onClick={(e) => { e.stopPropagation(); setMobileMenuOpen(!mobileMenuOpen); }}>
            ☰
          </button>
        </div>
        {pages[page]}
      </main>
    </div>
  );
}
