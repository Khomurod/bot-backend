import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import api from "../../api/trailerDepartment";
import { Card, PageHeader, useLoad } from "./TrailerUi";
import { visibleQuickActions } from "./homeQuickActions";
import {
  GUIDE_STEPS, isOnboardingDismissed, dismissOnboarding,
} from "./homeOnboarding";
import HomeGuide from "./HomeGuide";

const ATTENTION_COPY = {
  pickups_due: (c) => `${c} pickup${c > 1 ? "s" : ""} due today or overdue`,
  overdue_returns: (c) => `${c} trailer${c > 1 ? "s" : ""} past the expected return date`,
  overdue_invoices: (c) => `${c} overdue invoice${c > 1 ? "s" : ""}`,
  unknown_messages: (c) => `${c} unknown trailer message${c > 1 ? "s" : ""} to review`,
  failed_notifications: (c) => `${c} notification${c > 1 ? "s" : ""} failed to send`,
  trailers_needing_review: (c) => `${c} trailer${c > 1 ? "s" : ""} need${c > 1 ? "" : "s"} review`,
};

/** Attention link → section + query the in-app navigation understands. */
function linkTarget(link) {
  const url = new URL(link, window.location.origin);
  const section = url.pathname.split("/")[3] || "home";
  return { section, query: url.searchParams.toString() };
}

function timeAgo(value) {
  if (!value) return "";
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export default function TrailerHomePage({ navigate }) {
  const { permissions, user } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.home(), []);
  const [welcomeDismissed, setWelcomeDismissed] = useState(
    () => isOnboardingDismissed(window.localStorage, user?.id),
  );
  const [guideOpen, setGuideOpen] = useState(false);
  const go = (section, query) => navigate?.(section, query);
  const dismissWelcome = () => {
    dismissOnboarding(window.localStorage, user?.id);
    setWelcomeDismissed(true);
  };

  // Each quick action gates on its OWN permission — no broad fallback.
  const quickActions = visibleQuickActions(permissions);

  if (loading) return <div className="loading"><div className="spinner" />Loading…</div>;

  const summaryCards = [
    ["Available", data?.summary?.available, "trailers", "tab=all&condition=available"],
    ["Currently rented", data?.summary?.rented, "trailers", "tab=rented"],
    ["Pickups today", data?.summary?.pickups_today, "rentals", "tab=upcoming_pickups"],
    ["Overdue returns", data?.summary?.overdue_returns, "rentals", "tab=needs_attention"],
  ];

  return (
    <div className="trailer-home">
      <PageHeader
        title="Home"
        subtitle="What needs your attention across rentals, trailers and money."
        actions={<button type="button" className="btn btn-secondary" onClick={reload}>Refresh</button>}
      />
      {error && <div className="alert alert-danger">{error}</div>}

      {!welcomeDismissed && (
        <Card className="trailer-welcome">
          <div>
            <strong>Welcome to the Trailer Department</strong>
            <p>
              Everything lives in five places: <b>Home</b> shows what needs attention,{" "}
              <b>Rentals</b> is where you start, pick up and return rentals, <b>Trailers</b> is
              the trailer list and map, <b>Money</b> is invoices and payments, and <b>More</b>{" "}
              holds companies, reports and settings.
            </p>
            <button type="button" className="btn btn-link" onClick={() => setGuideOpen(true)}>
              Open the 1-minute guide →
            </button>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={dismissWelcome}
          >
            Got it
          </button>
        </Card>
      )}
      {guideOpen && (
        <HomeGuide steps={GUIDE_STEPS} onClose={() => setGuideOpen(false)} />
      )}

      {quickActions.length > 0 && (
        <div className="trailer-quick-actions">
          {quickActions.map((a) => (
            <button
              key={a.label}
              type="button"
              className="btn btn-primary trailer-quick-action"
              onClick={() => go(a.section, a.query)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      <Card>
        <h3>What needs attention</h3>
        {!data?.attention?.length && (
          <p className="trailer-empty-line">Nothing needs attention right now — everything is on track.</p>
        )}
        {data?.attention?.map((row) => {
          const target = linkTarget(row.link);
          return (
            <button
              key={row.type}
              type="button"
              className="trailer-attention-row"
              onClick={() => go(target.section, target.query)}
            >
              <span className="trailer-attention-dot" aria-hidden="true" />
              <span>{(ATTENTION_COPY[row.type] || ((c) => `${c} item(s)`))(row.count)}</span>
              <span className="trailer-attention-age">oldest {timeAgo(row.oldest_at)}</span>
              <span aria-hidden="true">→</span>
            </button>
          );
        })}
      </Card>

      <div className="trailer-metric-grid trailer-home-summary">
        {summaryCards.map(([label, value, section, query]) => (
          <button key={label} type="button" className="trailer-summary-card" onClick={() => go(section, query)}>
            <span>{label}</span>
            <strong>{value ?? 0}</strong>
          </button>
        ))}
      </div>

      <div className="trailer-two-col">
        <Card>
          <h3>Today</h3>
          <ul className="trailer-today-list">
            <li>{data?.today?.pickups ?? 0} pickups planned</li>
            <li>{data?.today?.returns ?? 0} returns expected</li>
            <li>{data?.today?.overdue ?? 0} returns overdue</li>
            <li>{data?.today?.payments ?? 0} payments recorded</li>
          </ul>
        </Card>
        <Card>
          <h3>Recent activity</h3>
          {!data?.activity?.length && <p className="trailer-empty-line">No recent activity yet.</p>}
          {data?.activity?.map((row, i) => (
            <div className="trailer-activity-row" key={i}>
              <span>{row.text}</span>
              <span className="trailer-attention-age">{timeAgo(row.at)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
