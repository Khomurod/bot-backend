import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import api from "../../api/trailerDepartment";
import TrailerDisabledPanel from "./TrailerDisabledPanel";
import { permittedTrailerSections } from "./trailerNavigation";
import "./trailerDepartment.css";

const Home = lazy(() => import("./TrailerHomePage"));
const RentalsSection = lazy(() => import("./sections/RentalsSection"));
const TrailersSection = lazy(() => import("./sections/TrailersSection"));
const MoneySection = lazy(() => import("./sections/MoneySection"));
const MoreSection = lazy(() => import("./sections/MoreSection"));

const PAGES = {
  home: Home,
  rentals: RentalsSection,
  trailers: TrailersSection,
  money: MoneySection,
  more: MoreSection,
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

  const Page = PAGES[permitted ? section : allowed[0]?.key] || Home;

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
