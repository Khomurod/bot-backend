import React from "react";
import TrailerNavItem from "./TrailerNavItem";
import { permittedTrailerSections } from "../pages/trailer/trailerNavigation";

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

/**
 * The main admin sidebar. Trailer Department stays an Operations item, but
 * renders its permitted pages as nested children — trailer-only accounts see
 * that item and nothing else.
 */
export default function AdminSidebar({
  session,
  page,
  mobileMenuOpen,
  trailerSection,
  trailerExpanded,
  onToggleTrailer,
  onNavigateToPage,
  onNavigateToTrailerSection,
  adminExpanded,
  onToggleAdmin,
  onLogout,
}) {
  const isFullAdmin = session?.permissions?.includes('admin.full_access');
  const visibleSections = NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => isFullAdmin || item.key === 'trailer_department'),
    }))
    .filter((section) => section.items.length);
  const trailerSections = permittedTrailerSections(session?.permissions);

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
            {section.items.map((item) =>
              item.key === "trailer_department" ? (
                <TrailerNavItem
                  key={item.key}
                  item={item}
                  sections={trailerSections}
                  active={page === "trailer_department"}
                  activeSection={trailerSection}
                  expanded={trailerExpanded}
                  onToggle={onToggleTrailer}
                  onOpenDepartment={() => onNavigateToPage(item.key)}
                  onSelectSection={onNavigateToTrailerSection}
                />
              ) : (
                <button
                  key={item.key}
                  className={`nav-item ${page === item.key ? "active" : ""}`}
                  onClick={() => onNavigateToPage(item.key)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                </button>
              ),
            )}
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
