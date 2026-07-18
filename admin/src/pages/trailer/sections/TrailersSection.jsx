import React, { lazy, Suspense, useMemo } from "react";
import { useAuth } from "../../../context/AuthContext";
import { hasTrailerPermission } from "../trailerNavigation";
import SectionTabs, { useSectionTab } from "./SectionTabs";

const TrailerList = lazy(() => import("../TrailerAssetsPage"));
const MapPage = lazy(() => import("../TrailerMapPage"));
const Tracking = lazy(() => import("../../TrailerTrackingPage"));
const Mentions = lazy(() => import("../mentions/MentionsPage"));

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

  return (
    <div>
      <SectionTabs tabs={tabs} active={tab} onChange={setTab} />
      <Suspense fallback={<div className="loading"><div className="spinner" />Loading…</div>}>
        {tab === "all" && <TrailerList navigate={navigate} />}
        {tab === "map" && <MapPage navigate={navigate} />}
        {tab === "updates" && <Tracking navigate={navigate} />}
        {tab === "unknown" && <Mentions navigate={navigate} />}
      </Suspense>
    </div>
  );
}
