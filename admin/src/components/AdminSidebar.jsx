import React, { useEffect, useState } from "react";
import Icon from "./ui/Icon";
import { applyTheme, effectiveTheme, storedTheme, watchSystemTheme } from "./ui/theme";

const NAV_SECTIONS = [
  {
    label: 'Operations',
    items: [
      { key: 'operations', icon: 'alert', label: 'Needs Attention' },
      { key: 'live_locations', icon: 'pin', label: 'Live Locations' },
      { key: 'home_time', icon: 'home', label: 'Driver Home Time' },
      { key: 'system_health', icon: 'activity', label: 'System & AI Health' },
    ],
  },
  {
    label: 'Groups',
    items: [
      { key: 'groups', icon: 'users', label: 'Groups' },
      { key: 'mileage_bonus', icon: 'flag', label: 'Mileage Bonuses' },
    ],
  },
  {
    label: 'Communications',
    items: [
      { key: 'communications', icon: 'message', label: 'Communications' },
      { key: 'company_birthdays', icon: 'cake', label: 'Birthdays' },
    ],
  },
  {
    label: 'Recruiting',
    items: [
      { key: 'leads', icon: 'inbox', label: 'Leads' },
      { key: 'facebook_leads', icon: 'chat', label: 'Customer Inquiries' },
      { key: 'recruiter_kpis', icon: 'phone', label: 'Recruiter KPIs' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { key: 'users', icon: 'user', label: 'Users & Access' },
      { key: 'settings_integrations', icon: 'plug', label: 'Integrations' },
      { key: 'settings_board', icon: 'board', label: 'Dispatcher Board' },
      { key: 'settings_ai', icon: 'bot', label: 'AI & Autonomy' },
      { key: 'settings_notifications', icon: 'bell', label: 'Notification Routing' },
      { key: 'settings_reactions', icon: 'smile', label: 'Auto Reactions' },
      { key: 'settings_access', icon: 'shield', label: 'Bot Group Access' },
    ],
  },
];

/** The sidebar label of a page key, for the top bar's title. */
function labelForPage(key) {
  for (const section of NAV_SECTIONS) {
    const item = section.items.find((i) => i.key === key);
    if (item) return item.label;
  }
  return null;
}

/**
 * The main admin sidebar.
 *
 * Every section here is company-wide administration, so the whole nav is gated
 * on `admin.full_access`: an account without it has no section to show. (There
 * used to be one exception — the Trailer Department, which trailer-scoped
 * accounts could open without full access. That feature is gone.)
 *
 * FIVE SECTIONS, AND NO "ADMIN" DRAWER. Recruiting is its own section, the
 * operational monitors (Home Time, System health) sit in Operations where
 * somebody looking for "is this working" would look, and Settings is a section
 * rather than a drawer.
 *
 * October 2026 redesign: line icons instead of emoji, the signed-in account
 * and the light/dark switch in the footer. The items, their order and their
 * keys did not change.
 *
 * A key here MUST exist in `navigation/pageKeys.js` PAGE_KEYS and in App.jsx's
 * page map. `pageKeys.test.jsx` holds all three lists to each other, because a
 * typo in any one of them used to render Driver Groups in silence.
 */
export default function AdminSidebar({
  session,
  page,
  mobileMenuOpen,
  onNavigateToPage,
  onLogout,
}) {
  const isFullAdmin = session?.permissions?.includes('admin.full_access');
  const visibleSections = isFullAdmin ? NAV_SECTIONS : [];
  const [theme, setTheme] = useState(() => effectiveTheme());
  // Until a person picks a theme the page follows the operating system; keep
  // the switch's label in step when the OS changes (e.g. scheduled dark mode).
  useEffect(() => watchSystemTheme((next) => {
    if (!storedTheme()) setTheme(next);
  }), []);
  const username = session?.username || session?.user?.username || '';

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <aside className={`sidebar ${mobileMenuOpen ? "mobile-open" : ""}`} aria-label="Main navigation">
      <div className="sidebar-logo">
        <span className="sidebar-logo-mark"><Icon name="truck" size={18} /></span>
        <div>
          <h1>Wenze</h1>
          <p>Driver Feedback · Admin</p>
        </div>
      </div>
      <nav className="sidebar-nav">
        {visibleSections.map((section) => (
          <div key={section.label} className="nav-section">
            <div className="nav-section-header">{section.label}</div>
            {section.items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`nav-item ${page === item.key ? "active" : ""}`}
                aria-current={page === item.key ? "page" : undefined}
                onClick={() => onNavigateToPage(item.key)}
              >
                <span className="nav-icon"><Icon name={item.icon} /></span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        {username && (
          <div className="sidebar-user">
            <span className="sidebar-user-avatar" aria-hidden="true">{username.slice(0, 2)}</span>
            <div style={{ minWidth: 0 }}>
              <div className="sidebar-user-name">{username}</div>
              <div className="sidebar-user-role">{isFullAdmin ? 'Administrator' : 'Limited access'}</div>
            </div>
          </div>
        )}
        <button type="button" className="logout-btn" onClick={toggleTheme}>
          <span className="nav-icon"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></span>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <button type="button" className="logout-btn logout-btn--danger" onClick={onLogout}>
          <span className="nav-icon"><Icon name="logout" /></span>
          Sign Out
        </button>
      </div>
    </aside>
  );
}

export { NAV_SECTIONS, labelForPage };
