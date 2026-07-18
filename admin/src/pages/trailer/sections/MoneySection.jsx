import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import { hasTrailerPermission } from "../trailerNavigation";
import SectionTabs, { useSectionTab } from "./SectionTabs";

const Payments = lazy(() => import("../TrailerPaymentsPage"));
const PaymentDialogLoader = lazy(() => import("../TrailerPaymentsPage").then((m) => ({ default: m.PaymentDialog })));
const InvoiceDetail = lazy(() => import("../money/InvoiceDetailPage"));
const Credits = lazy(() => import("../money/CompanyCreditsPage"));

function readInvoiceParam() {
  return new URLSearchParams(window.location.search).get("invoice") || null;
}

function writeInvoiceParam(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("invoice", id);
  else url.searchParams.delete("invoice");
  window.history.replaceState({}, "", url);
}

/**
 * Money section: invoices & payments (with the invoice drill-down), overdue
 * balances and company credits. The open invoice lives in the URL (?invoice=).
 */
export default function MoneySection({ navigate }) {
  const { permissions, can } = useAuth();
  const tabs = useMemo(() => [
    { key: "invoices", label: "Invoices & payments", allowed: hasTrailerPermission(permissions, "trailer_payments.view") },
    { key: "overdue", label: "Overdue balances", allowed: hasTrailerPermission(permissions, "trailer_payments.view") },
    { key: "credits", label: "Company credits", allowed: hasTrailerPermission(permissions, "trailer_payments.view") },
  ].filter((t) => t.allowed), [permissions]);

  const [tab, setTab] = useSectionTab(tabs, "invoices");
  const [invoiceId, setInvoiceId] = useState(readInvoiceParam);
  const [paying, setPaying] = useState(null);
  const [detailKey, setDetailKey] = useState(0);

  useEffect(() => {
    const onPop = () => setInvoiceId(readInvoiceParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openInvoice = (row) => { writeInvoiceParam(row?.id ?? row); setInvoiceId(row?.id ?? row); };
  const closeInvoice = () => { writeInvoiceParam(null); setInvoiceId(null); };

  return (
    <div>
      {!invoiceId && <SectionTabs tabs={tabs} active={tab} onChange={setTab} />}
      <Suspense fallback={<div className="loading"><div className="spinner" />Loading…</div>}>
        {invoiceId ? (
          <>
            <InvoiceDetail
              key={detailKey}
              invoiceId={invoiceId}
              onBack={closeInvoice}
              canReverse={can("trailer_payments.reverse")}
              onRecordPayment={(inv) => setPaying(inv)}
            />
            {paying && (
              <PaymentDialogLoader
                invoice={paying}
                can={can}
                onClose={() => setPaying(null)}
                onSaved={() => { setPaying(null); setDetailKey((k) => k + 1); }}
              />
            )}
          </>
        ) : (
          <>
            {tab === "invoices" && <Payments navigate={navigate} onOpenInvoice={openInvoice} />}
            {tab === "overdue" && <Payments navigate={navigate} statusFilter="overdue" onOpenInvoice={openInvoice} />}
            {tab === "credits" && <Credits navigate={navigate} />}
          </>
        )}
      </Suspense>
    </div>
  );
}
