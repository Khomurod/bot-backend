import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import "./trailerDepartment.css";
const Dashboard = lazy(() => import("./TrailerDashboard"));
const Rentals = lazy(() => import("./TrailerRentalsPage"));
const Trailers = lazy(() => import("./TrailerAssetsPage"));
const Companies = lazy(() => import("./TrailerCompaniesPage"));
const Payments = lazy(() => import("./TrailerPaymentsPage"));
const MapPage = lazy(() => import("./TrailerMapPage"));
const Reports = lazy(() => import("./TrailerReportsPage"));
const Tracking = lazy(() => import("../TrailerTrackingPage"));
const Settings = lazy(() => import("./TrailerSettingsPage"));
const Users = lazy(() => import("./TrailerUsersPage"));

const ITEMS = [
  ["dashboard", "Dashboard", "trailers.view"],
  ["rentals", "Rentals", "trailer_rentals.view"],
  ["trailers", "Trailers", "trailers.view"],
  ["companies", "Companies", "trailer_rentals.view"],
  ["payments", "Payments", "trailer_payments.view"],
  ["map", "Trailer Map", "trailer_map.view"],
  ["reports", "Reports", "trailer_reports.view"],
  ["tracking", "AI Tracking", "trailers.view"],
  ["settings", "Settings", "trailer_settings.manage"],
  ["users", "Trailer Users", "trailer_users.manage"],
];
const PAGES = {
  dashboard: Dashboard,
  rentals: Rentals,
  trailers: Trailers,
  companies: Companies,
  payments: Payments,
  map: MapPage,
  reports: Reports,
  tracking: Tracking,
  settings: Settings,
  users: Users,
};
function fromPath() {
  return window.location.pathname.split("/")[3] || "dashboard";
}
export default function TrailerDepartmentShell() {
  const { can } = useAuth();
  const allowed = useMemo(
    () => ITEMS.filter(([, , permission]) => can(permission)),
    [can],
  );
  const [section, setSection] = useState(() => fromPath());
  useEffect(() => {
    const pop = () => setSection(fromPath());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (!allowed.some(([key]) => key === section) && allowed[0])
      setSection(allowed[0][0]);
  }, [allowed, section]);
  const go = (key) => {
    setSection(key);
    window.history.pushState({}, "", `/admin/trailers/${key}`);
  };
  const Page = PAGES[section] || Dashboard;
  return (
    <div className="trailer-department">
      <div className="trailer-department-brand">
        <div>
          <strong>Trailer Department</strong>
          <span>Rental and Asset Management</span>
        </div>
        <nav>
          {allowed.map(([key, label]) => (
            <button
              key={key}
              className={section === key ? "active" : ""}
              onClick={() => go(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <Suspense
        fallback={
          <div className="loading">
            <div className="spinner" />
            Loading…
          </div>
        }
      >
        <Page navigate={go} />
      </Suspense>
    </div>
  );
}
