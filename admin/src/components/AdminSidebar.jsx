import React from "react";

const NAV_SECTIONS = [
  {
    label: 'Operations',
    color: '#22c55e',
    items: [
      { key: 'operations', icon: '🔎', label: 'Needs Attention' },
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
      { key: 'auto_reactions', icon: '😀', label: 'Auto Reactions' },
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

/**
 * The main admin sidebar.
 *
 * Every section here is company-wide administration, so the whole nav is gated
 * on `admin.full_access`: an account without it has no section to show. (There
 * used to be one exception — the Trailer Department, which trailer-scoped
 * accounts could open without full access. That feature is gone.)
 */
export default function AdminSidebar({
  session,
  page,
  mobileMenuOpen,
  onNavigateToPage,
  adminExpanded,
  onToggleAdmin,
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
        {isFullAdmin && <div className="nav-section">
          <button
            className="nav-section-header nav-section-toggle"
            onClick={onToggleAdmin}
            style={{ borderLeftColor: '#64748b' }}
          >
            ⚙️ Admin
            <span className="nav-section-arrow">{adminExpanded ? '▾' : '▸'}</span>
          </button>
          {adminExpanded && ADMIN_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${page === item.key ? "active" : ""}`}
              onClick={() => onNavigateToPage(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>}
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

export { NAV_SECTIONS, ADMIN_ITEMS };
