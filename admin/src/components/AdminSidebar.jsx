import React from "react";

const NAV_SECTIONS = [
  {
    label: 'Operations',
    color: '#22c55e',
    items: [
      { key: 'operations', icon: '🔎', label: 'Needs Attention' },
      { key: 'live_locations', icon: '📍', label: 'Live Locations' },
      { key: 'route_control', icon: '🧭', label: 'Route Control' },
      { key: 'fuel_monitor', icon: '⛽', label: 'Fuel Monitor' },
      { key: 'home_time', icon: '🏠', label: 'Driver Home Time' },
      { key: 'system_health', icon: '🩺', label: 'System & AI Health' },
    ],
  },
  {
    label: 'Groups',
    color: '#a78bfa',
    items: [
      { key: 'groups', icon: '👷', label: 'Groups' },
      { key: 'mileage_bonus', icon: '🏁', label: 'Mileage Bonuses' },
      { key: 'raise_approval', icon: '💵', label: 'Driver Raises' },
    ],
  },
  {
    label: 'Communications',
    color: '#6366f1',
    items: [
      { key: 'communications', icon: '💬', label: 'Communications' },
      { key: 'company_birthdays', icon: '🎂', label: 'Birthdays' },
    ],
  },
  {
    label: 'Recruiting',
    color: '#f59e0b',
    items: [
      { key: 'leads', icon: '📥', label: 'Leads' },
      { key: 'facebook_leads', icon: '👥', label: 'Customer Inquiries' },
      { key: 'recruiter_kpis', icon: '📞', label: 'Recruiter KPIs' },
    ],
  },
  {
    label: 'Settings',
    color: '#64748b',
    items: [
      { key: 'users', icon: '👤', label: 'Users & Access' },
      { key: 'settings_integrations', icon: '🔌', label: 'Integrations' },
      { key: 'settings_board', icon: '🗂️', label: 'Dispatcher Board' },
      { key: 'settings_ai', icon: '🤖', label: 'AI & Autonomy' },
      { key: 'settings_finance', icon: '💵', label: 'Finance Monitor' },
      { key: 'settings_notifications', icon: '🔔', label: 'Notification Routing' },
      { key: 'settings_reactions', icon: '😀', label: 'Auto Reactions' },
      { key: 'settings_access', icon: '🔍', label: 'Bot Group Access' },
    ],
  },
];

/**
 * The main admin sidebar.
 *
 * Every section here is company-wide administration, so the whole nav is gated
 * on `admin.full_access`: an account without it has no section to show. (There
 * used to be one exception — the Trailer Department, which trailer-scoped
 * accounts could open without full access. That feature is gone.)
 *
 * FIVE SECTIONS, AND NO "ADMIN" DRAWER. There used to be three — Operations
 * (which also held the three recruiting screens), Communications (two entries)
 * and a "Team" section of nine — plus a collapsed ⚙️ Admin block. Since the
 * whole nav needs the same permission, a section named "Admin" said nothing
 * about what was inside it, and collapsing it by default put those screens one
 * click further away than the rest for no reason. Recruiting is now its own
 * section instead of the tail of Operations, the operational monitors (Fuel,
 * Home Time, System health) moved OUT of "Team" into Operations where somebody
 * looking for "is this working" would look, and Settings is a section rather
 * than a drawer.
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

  return (
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
                onClick={() => onNavigateToPage(item.key)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button className="logout-btn" onClick={onLogout}>
          <span className="nav-icon">🚪</span>
          Sign Out
        </button>
      </div>
    </aside>
  );
}

export { NAV_SECTIONS };
