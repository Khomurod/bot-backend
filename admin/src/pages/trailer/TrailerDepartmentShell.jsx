import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import api from "../../api/trailerDepartment";
import TrailerDisabledPanel from "./TrailerDisabledPanel";
import { permittedTrailerSections } from "./trailerNavigation";
import "./trailerDepartment.css";

const Dashboard = lazy(() => import("./TrailerDashboard"));
const Rentals = lazy(() => import("./TrailerRentalsPage"));
const Agreements = lazy(() => import("./agreement/AgreementsPage"));
const Trailers = lazy(() => import("./TrailerAssetsPage"));
const Companies = lazy(() => import("./TrailerCompaniesPage"));
const Payments = lazy(() => import("./TrailerPaymentsPage"));
const MapPage = lazy(() => import("./TrailerMapPage"));
const Reports = lazy(() => import("./TrailerReportsPage"));
const Tracking = lazy(() => import("../TrailerTrackingPage"));
const MasterImport = lazy(() => import("./masterImport/MasterImportPage"));
const Mentions = lazy(() => import("./mentions/MentionsPage"));
const Settings = lazy(() => import("./TrailerSettingsPage"));
const Users = lazy(() => import("./TrailerUsersPage"));

const PAGES = {
  dashboard: Dashboard,
  rentals: Rentals,
  agreements: Agreements,
  trailers: Trailers,
  companies: Companies,
  payments: Payments,
  map: MapPage,
  reports: Reports,
  tracking: Tracking,
  masterImport: MasterImport,
  mentions: Mentions,
  settings: Settings,
  users: Users,
};

/**
 * Renders the selected department page. Navigation lives in the main admin
 * sidebar (App.jsx) — `section` and `onNavigate` are the only router state, so
 * the shell never competes with App for the URL.
 */
export default function TrailerDepartmentShell({ section, onNavigate }) {
  const { permissions, isSuperAdmin } = useAuth();
  const allowed = useMemo(() => permittedTrailerSections(permissions), [permissions]);
  // "checking" → "enabled" | "disabled" | "failed": a failed status request is
  // not the same as a department that is genuinely turned off.
  const [status, setStatus] = useState({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    api
      .status()
      .then(({ enabled }) => {
        if (!cancelled) setStatus({ state: enabled ? "enabled" : "disabled" });
      })
      .catch((error) => {
        if (!cancelled) setStatus({ state: "failed", message: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const permitted = allowed.some((item) => item.key === section);
  useEffect(() => {
    if (!permitted && allowed[0]) onNavigate?.(allowed[0].key);
  }, [permitted, allowed, onNavigate]);

  const Page = PAGES[permitted ? section : allowed[0]?.key] || Dashboard;

  return (
    <div className="trailer-department">
      <div className="trailer-department-brand">
        <div>
          <strong>Trailer Department</strong>
          <span>Rental and Asset Management</span>
        </div>
      </div>
      {status.state === "checking" && (
        <div className="loading">
          <div className="spinner" />
          Loading…
        </div>
      )}
      {status.state === "failed" && (
        <div className="alert alert-danger">
          Could not check whether the Trailer Department is enabled: {status.message}
        </div>
      )}
      {status.state === "disabled" && <TrailerDisabledPanel isSuperAdmin={isSuperAdmin} />}
      {status.state === "enabled" && (
        <Suspense
          fallback={
            <div className="loading">
              <div className="spinner" />
              Loading…
            </div>
          }
        >
          <Page navigate={onNavigate} />
        </Suspense>
      )}
    </div>
  );
}
