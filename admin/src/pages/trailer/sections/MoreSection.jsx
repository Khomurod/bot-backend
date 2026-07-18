import React, { lazy, Suspense, useMemo } from "react";
import { useAuth } from "../../../context/AuthContext";
import { hasTrailerPermission } from "../trailerNavigation";
import SectionTabs, { useSectionTab } from "./SectionTabs";

const Companies = lazy(() => import("../TrailerCompaniesPage"));
const MasterImport = lazy(() => import("../masterImport/MasterImportPage"));
const Reports = lazy(() => import("../TrailerReportsPage"));
const Users = lazy(() => import("../TrailerUsersPage"));
const Settings = lazy(() => import("../TrailerSettingsPage"));
const Audit = lazy(() => import("../more/AuditPage"));

/**
 * More section: companies, "Update trailer list" (the renamed master import),
 * reports, team access and settings — each visible only with its permission.
 */
export default function MoreSection({ navigate }) {
  const { permissions } = useAuth();
  const tabs = useMemo(() => [
    {
      key: "companies",
      label: "Companies",
      allowed: hasTrailerPermission(permissions, "trailer_rentals.view", "trailer_companies.manage"),
    },
    {
      key: "trailer-list",
      label: "Update trailer list",
      allowed: hasTrailerPermission(permissions, "trailer_imports.manage"),
    },
    { key: "reports", label: "Reports", allowed: hasTrailerPermission(permissions, "trailer_reports.view") },
    { key: "team", label: "Team access", allowed: hasTrailerPermission(permissions, "trailer_users.manage") },
    { key: "audit", label: "Audit trail", allowed: hasTrailerPermission(permissions, "trailer_reports.view") },
    { key: "settings", label: "Settings", allowed: hasTrailerPermission(permissions, "trailer_settings.manage") },
  ].filter((t) => t.allowed), [permissions]);

  const [tab, setTab] = useSectionTab(tabs, "companies");

  return (
    <div>
      <SectionTabs tabs={tabs} active={tab} onChange={setTab} />
      <Suspense fallback={<div className="loading"><div className="spinner" />Loading…</div>}>
        {tab === "companies" && <Companies navigate={navigate} />}
        {tab === "trailer-list" && <MasterImport navigate={navigate} />}
        {tab === "reports" && <Reports navigate={navigate} />}
        {tab === "team" && <Users navigate={navigate} />}
        {tab === "audit" && <Audit navigate={navigate} />}
        {tab === "settings" && <Settings navigate={navigate} />}
      </Suspense>
    </div>
  );
}
