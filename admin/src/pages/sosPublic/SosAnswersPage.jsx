/**
 * Public /answers (real) and /answers/test — the live SOS presentation screen.
 * Entirely in Uzbek, projector-friendly, auto-updating (20s visibility-aware
 * polling). Receives ONLY anonymous, COMPANY-WIDE aggregates from the mode's
 * summary API — names, individual results and any department or dispatch-team
 * breakdown never reach this page (the API does not send them).
 *
 * Test mode adds a clear TEST banner and an admin-authenticated test-data
 * cleanup control (deletes is_test rows only — enforced server-side).
 *
 * Both modes also offer the 10-minute presentation timer. It is a pure frontend
 * overlay: it never reads or writes SOS data, and rendering it behind a single
 * `timerOpen` flag guarantees one instance — so it cannot start twice.
 */
import { useEffect, useState } from "react";
import "./sosPublic.css";
import { getSosSummary } from "../../api/sos";
import useVisibleInterval from "../../utils/useVisibleInterval";
import {
  CompanySection, TechniquesSection, PracticesSection,
} from "./SosAnswersSections";
import SosTestCleanup from "./SosTestCleanup";
import SosPresentationTimer from "./SosPresentationTimer";
import { primeChimeAudio } from "./sosTimerChime";

const REFRESH_MS = 20_000;

export default function SosAnswersPage({ isTest = false }) {
  const [summary, setSummary] = useState(null);
  const [stale, setStale] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);

  async function load() {
    try {
      setSummary(await getSosSummary(isTest));
      setStale(false);
    } catch (err) {
      setStale(true); // keep last-good data on screen during blips
    }
  }

  useEffect(() => {
    document.title = isTest ? "TEST — SOS Jamoaviy natijalar" : "SOS — Jamoaviy natijalar";
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  const questionsUrl = `${window.location.origin}/questions${isTest ? "/test" : ""}`;
  const top = summary.company.topPatterns?.[0];
  const topRow = top && (summary.company.primaryPatterns || []).find((r) => r.pattern === top);

  return (
    <div className="sos-root sos-answers">
      <div className="sos-shell sos-shell--wide">
        {isTest && (
          <div className="sos-test-banner" style={{ textAlign: "center", fontSize: 17 }}>
            🧪 <b>TEST rejimi</b> — bu sinov sahifasi: faqat /questions/test orqali yuborilgan javoblar koʻrsatiladi.
            Haqiqiy natijalarga taʼsir qilmaydi.
          </div>
        )}

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
          <button
            type="button"
            className="sos-btn sos-btn--primary sos-timer-launch"
            onClick={() => {
              // Start the audio context HERE, inside the click: ten minutes
              // later there is no user gesture to satisfy autoplay policy.
              primeChimeAudio();
              setTimerOpen(true);
            }}
          >
            ⏱️ 10 daqiqalik taymer
          </button>
        </div>

        {!summary.open && (
          <div className="sos-closed-banner">🔒 Soʻrovnoma yakunlandi — quyida yakuniy jamoaviy natijalar.</div>
        )}

        <div className="sos-stat-row">
          <div className="sos-stat">
            <div className="sos-stat-value">{summary.total}</div>
            <div className="sos-stat-label">toʻldirilgan soʻrovnoma</div>
          </div>
          {topRow && (
            <div className="sos-stat">
              <div className="sos-stat-value">{topRow.percent}%</div>
              <div className="sos-stat-label">{summary.patternMeta[top].name} — eng koʻp uchragan uslub</div>
            </div>
          )}
        </div>

        {!hasData && (
          <div className="sos-card sos-center">
            <div className="sos-emoji" aria-hidden="true">📱</div>
            <h1>Hali javoblar yoʻq</h1>
            <p style={{ fontSize: 18 }}>
              Soʻrovnomani telefoningizda oching: <b style={{ color: "#ea580c" }}>{questionsUrl}</b>
            </p>
          </div>
        )}

        {hasData && <CompanySection summary={summary} />}
        <TechniquesSection presentation={p} />
        <PracticesSection presentation={p} />

        {isTest && <SosTestCleanup onCleared={load} />}

        <div className="sos-footer-note">
          Natijalar anonim va butun kompaniya boʻyicha umumlashtirilgan — ismlar, shaxsiy javob
          varaqlari, boʻlim va jamoa kesimidagi natijalar koʻrsatilmaydi
        </div>
      </div>

      {timerOpen && (
        <SosPresentationTimer isTest={isTest} onClose={() => setTimerOpen(false)} />
      )}
    </div>
  );
}
