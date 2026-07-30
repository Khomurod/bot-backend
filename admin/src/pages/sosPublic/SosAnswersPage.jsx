/**
 * Public /answers page — the live SOS presentation screen for the
 * team-building session. Entirely in Uzbek, projector-friendly, auto-updating
 * (20s visibility-aware polling). Receives ONLY anonymous aggregates from
 * /api/sos/summary — names and individual results never reach this page.
 */
import { useEffect, useState } from "react";
import "./sosPublic.css";
import { getSosSummary } from "../../api/sos";
import useVisibleInterval from "../../utils/useVisibleInterval";
import {
  CompanySection, TechniquesSection, DepartmentsSection, TeamsSection, PracticesSection,
} from "./SosAnswersSections";

const REFRESH_MS = 20_000;

export default function SosAnswersPage() {
  const [summary, setSummary] = useState(null);
  const [stale, setStale] = useState(false);

  async function load() {
    try {
      setSummary(await getSosSummary());
      setStale(false);
    } catch (err) {
      setStale(true); // keep last-good data on screen during blips
    }
  }

  useEffect(() => {
    document.title = "SOS — Jamoaviy natijalar";
    load();
  }, []);
  useVisibleInterval(load, REFRESH_MS);

  if (!summary) {
    return (
      <div className="sos-root sos-answers">
        <div className="sos-shell sos-shell--wide sos-center">
          <div className="sos-spinner" aria-hidden="true" />
          <p style={{ color: "#6b7280" }}>Yuklanmoqda…</p>
        </div>
      </div>
    );
  }

  const p = summary.presentation;
  const hasData = summary.total > 0;

  return (
    <div className="sos-root sos-answers">
      <div className="sos-shell sos-shell--wide">
        <div className="sos-hero">
          <h1 className="sos-hero-title">
            Savol Ortidagi Savol — <span className="accent">SOS</span>
          </h1>
          <p className="sos-hero-sub">
            {p.subtitle} · {summary.open ? <span><span className="sos-live-dot" />jonli yangilanmoqda</span> : "yakuniy natijalar"}
            {stale ? " · qayta ulanmoqda…" : ""}
          </p>
          <div className="sos-central-q">
            <span className="intro">{p.centralQuestionIntro}</span>
            “{p.centralQuestion}”
          </div>
        </div>

        {!summary.open && (
          <div className="sos-closed-banner">🔒 Soʻrovnoma yakunlandi — quyida yakuniy jamoaviy natijalar.</div>
        )}

        <div className="sos-stat-row">
          <div className="sos-stat">
            <div className="sos-stat-value">{summary.total}</div>
            <div className="sos-stat-label">toʻldirilgan soʻrovnoma</div>
          </div>
          <div className="sos-stat">
            <div className="sos-stat-value">{summary.departments.filter((d) => d.count > 0).length}</div>
            <div className="sos-stat-label">ishtirok etgan boʻlim</div>
          </div>
        </div>

        {!hasData && (
          <div className="sos-card sos-center">
            <div className="sos-emoji" aria-hidden="true">📱</div>
            <h1>Hali javoblar yoʻq</h1>
            <p style={{ fontSize: 18 }}>
              Soʻrovnomani telefoningizda oching: <b style={{ color: "#ea580c" }}>{window.location.origin}/questions</b>
            </p>
          </div>
        )}

        {hasData && <CompanySection summary={summary} />}
        <TechniquesSection presentation={p} />
        {hasData && <DepartmentsSection summary={summary} />}
        {hasData && <TeamsSection summary={summary} />}
        <PracticesSection presentation={p} />

        <div className="sos-footer-note">
          Natijalar anonim va umumlashtirilgan · Kichik guruhlar (3 kishidan kam) maxfiylik uchun ochilmaydi
        </div>
      </div>
    </div>
  );
}
