import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import dept from "../../../api/trailerDepartment";
import { hasTrailerPermission } from "../trailerNavigation";
import { useLoad } from "../TrailerUi";
import RentalsListPage from "../rentals/RentalsListPage";
import RentalDetailPage from "../rentals/RentalDetailPage";
import StartRentalWizard from "../rentals/StartRentalWizard";

/** Which view the URL asks for: the wizard, one rental, or the list. */
function readView() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("action") === "start") return { name: "wizard" };
  if (p.get("rental")) return { name: "detail", id: p.get("rental") };
  return { name: "list" };
}

function writeView(view) {
  const url = new URL(window.location.href);
  url.searchParams.delete("action");
  url.searchParams.delete("rental");
  if (view.name === "wizard") url.searchParams.set("action", "start");
  if (view.name === "detail") url.searchParams.set("rental", view.id);
  window.history.replaceState({}, "", url);
}

/**
 * Rentals section: ONE unified list (agreements + mirrored legacy rentals),
 * the start-a-rental wizard, and the rental detail. The active view lives in
 * the URL so reload and back/forward behave.
 */
export default function RentalsSection() {
  const { permissions } = useAuth();
  const canManage = hasTrailerPermission(permissions, "trailer_agreements.manage", "trailer_rentals.create");
  const [view, setViewState] = useState(readView);
  const [banner, setBanner] = useState(null);

  const companies = useLoad(() => dept.companies({ active: true }), []);
  const assets = useLoad(() => dept.trailers(), []);

  useEffect(() => {
    const onPop = () => setViewState(readView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setView = useCallback((next) => { writeView(next); setViewState(next); }, []);

  if (view.name === "wizard" && canManage) {
    return (
      <StartRentalWizard
        companies={companies.data?.companies || []}
        trailers={assets.data?.trailers || []}
        onCancel={() => setView({ name: "list" })}
        onCompanyAdded={() => companies.reload()}
        onCreated={(agreement, trailerCount) => {
          setBanner(`Rental created. Next: complete pickup inspections for ${trailerCount} trailer${trailerCount === 1 ? "" : "s"}.`);
          setView({ name: "detail", id: agreement.id });
        }}
      />
    );
  }

  if (view.name === "detail") {
    return (
      <div>
        {banner && (
          <div className="alert alert-success trailer-banner">
            {banner}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBanner(null)}>Dismiss</button>
          </div>
        )}
        <RentalDetailPage
          agreementId={view.id}
          trailers={assets.data?.trailers || []}
          onBack={() => { setBanner(null); setView({ name: "list" }); }}
        />
      </div>
    );
  }

  return (
    <RentalsListPage
      canManage={canManage}
      onStart={() => setView({ name: "wizard" })}
      onOpen={(id) => setView({ name: "detail", id })}
    />
  );
}
