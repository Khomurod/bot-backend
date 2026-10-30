import React, { useEffect, useState } from "react";
import Icon from "./ui/Icon";
import { applyTheme, effectiveTheme, storedTheme, watchSystemTheme } from "./ui/theme";

/**
 * The sidebar: five groups, business work first, the system after it,
 * configuration last. One entry per page — a page's tabs are inside the page
 * and in its address, never extra sidebar entries (six entries used to open
 * the one Settings page). Why each thing is where it is:
 * docs/redesign/structure.md.
 */
const NAV_SECTIONS = [
  {
    label: 'Drivers',
    items: [
      { key: 'groups', icon: 'users', label: 'Driver Groups' },
      { key: 'live_locations', icon: 'pin', label: 'Live Locations' },
      { key: 'home_time', icon: 'home', label: 'Home Time' },
      { key: 'mileage_bonus', icon: 'flag', label: 'Mileage Bonuses' },
      { key: 'retention', icon: 'lifebuoy', label: 'Retention' },
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
    label: 'Communications',
    items: [
      { key: 'communications', icon: 'message', label: 'Messages' },
      { key: 'company_birthdays', icon: 'cake', label: 'Birthdays' },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { key: 'operations', icon: 'alert', label: 'Needs Attention' },
      { key: 'system_health', icon: 'activity', label: 'System Health' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { key: 'users', icon: 'user', label: 'Telegram Users' },
      { key: 'settings', icon: 'sliders', label: 'Settings' },
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
 * FIVE GROUPS, NO DRAWERS: Drivers, Recruiting, Communications, Monitoring,
 * Administration (NAV_SECTIONS above). Line icons, the signed-in account and
 * the light/dark switch in the footer.
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
  onChangePassword,
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
        {onChangePassword && (
          <button type="button" className="logout-btn" onClick={onChangePassword}>
            <span className="nav-icon"><Icon name="key" /></span>
            Change password
          </button>
        )}
        <button type="button" className="logout-btn logout-btn--danger" onClick={onLogout}>
          <span className="nav-icon"><Icon name="logout" /></span>
          Sign Out
        </button>
      </div>
    </aside>
  );
}

export { NAV_SECTIONS, labelForPage };
