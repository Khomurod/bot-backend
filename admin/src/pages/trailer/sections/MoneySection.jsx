import React, { lazy, Suspense, useMemo } from "react";
import { useAuth } from "../../../context/AuthContext";
import { hasTrailerPermission } from "../trailerNavigation";
import SectionTabs, { useSectionTab } from "./SectionTabs";

const Payments = lazy(() => import("../TrailerPaymentsPage"));
const Credits = lazy(() => import("../money/CompanyCreditsPage"));

/**
 * Money section: invoices & payments, company credits and overdue balances.
 * The invoices/payments tab reuses the finance page; "Overdue" opens it
 * pre-filtered to overdue invoices.
 */
export default function MoneySection({ navigate }) {
  const { permissions } = useAuth();
  const tabs = useMemo(() => [
    { key: "invoices", label: "Invoices & payments", allowed: hasTrailerPermission(permissions, "trailer_payments.view") },
    { key: "overdue", label: "Overdue balances", allowed: hasTrailerPermission(permissions, "trailer_payments.view") },
    { key: "credits", label: "Company credits", allowed: hasTrailerPermission(permissions, "trailer_payments.view") },
  ].filter((t) => t.allowed), [permissions]);

  const [tab, setTab] = useSectionTab(tabs, "invoices");

  return (
    <div>
      <SectionTabs tabs={tabs} active={tab} onChange={setTab} />
      <Suspense fallback={<div className="loading"><div className="spinner" />Loading…</div>}>
        {tab === "invoices" && <Payments navigate={navigate} />}
        {tab === "overdue" && <Payments navigate={navigate} statusFilter="overdue" />}
        {tab === "credits" && <Credits navigate={navigate} />}
      </Suspense>
    </div>
  );
}
