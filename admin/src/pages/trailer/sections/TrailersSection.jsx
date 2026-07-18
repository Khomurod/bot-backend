import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import { hasTrailerPermission } from "../trailerNavigation";
import SectionTabs, { useSectionTab, TabPanel } from "./SectionTabs";

const TrailerList = lazy(() => import("../TrailerAssetsPage"));
const TrailerDetail = lazy(() => import("../TrailerDetailPage"));
const TrailerEditDialog = lazy(() => import("../TrailerEditDialog"));
const MapPage = lazy(() => import("../TrailerMapPage"));
const Tracking = lazy(() => import("../../TrailerTrackingPage"));
const Mentions = lazy(() => import("../mentions/MentionsPage"));

function readTrailerParam() {
  return new URLSearchParams(window.location.search).get("trailer") || null;
}

function writeTrailerParam(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("trailer", id);
  else url.searchParams.delete("trailer");
  window.history.replaceState({}, "", url);
}

/**
 * Trailers section: the trailer list, the map, "Trailer updates" (the renamed
 * AI tracking feed) and "Unknown trailer messages" (the renamed mentions
 * review). Tabs the user has no permission for are not rendered at all.
 */
export default function TrailersSection({ navigate }) {
  const { permissions } = useAuth();
  const tabs = useMemo(() => [
    { key: "all", label: "All trailers", allowed: hasTrailerPermission(permissions, "trailers.view") },
    { key: "map", label: "Map", allowed: hasTrailerPermission(permissions, "trailer_map.view") },
    { key: "updates", label: "Trailer updates", allowed: hasTrailerPermission(permissions, "trailers.view") },
    {
      key: "unknown",
      label: "Unknown messages",
      allowed: hasTrailerPermission(permissions, "trailer_unmatched_mentions.manage"),
    },
  ].filter((t) => t.allowed), [permissions]);

  const [tab, setTab] = useSectionTab(tabs, "all");
  const [trailerId, setTrailerId] = useState(readTrailerParam);
  const [editing, setEditing] = useState(null);
  const [detailKey, setDetailKey] = useState(0);

  useEffect(() => {
    const onPop = () => setTrailerId(readTrailerParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openTrailer = (row) => { writeTrailerParam(row?.id ?? row); setTrailerId(row?.id ?? row); };
  const closeTrailer = () => { writeTrailerParam(null); setTrailerId(null); };

  return (
    <div>
      {!trailerId && <SectionTabs tabs={tabs} active={tab} onChange={setTab} idBase="trailer-trailers" />}
      <Suspense fallback={<div className="loading"><div className="spinner" />Loading…</div>}>
        {trailerId ? (
          <>
            <TrailerDetail
              key={detailKey}
              trailerId={trailerId}
              onBack={closeTrailer}
              onEdit={(t) => setEditing(t)}
            />
            {editing && (
              <TrailerEditDialog
                trailer={editing}
                onClose={() => setEditing(null)}
                onSaved={() => { setEditing(null); setDetailKey((k) => k + 1); }}
              />
            )}
          </>
        ) : (
          <TabPanel idBase="trailer-trailers" activeKey={tab}>
            {tab === "all" && <TrailerList navigate={navigate} onOpen={openTrailer} />}
            {tab === "map" && <MapPage navigate={navigate} />}
            {tab === "updates" && <Tracking navigate={navigate} />}
            {tab === "unknown" && <Mentions navigate={navigate} />}
          </TabPanel>
        )}
      </Suspense>
    </div>
  );
}
