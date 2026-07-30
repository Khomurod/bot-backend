/**
 * /questions — personal result screen. Renders the server-computed result
 * (primary + optional secondary pattern) in the employee's language, with
 * strengths, development areas, book techniques, SOS questions, the
 * "tendency, not personality" reminder, and an encouraging close.
 */
import { STRINGS } from "./sosStrings";

const PATTERN_ORDER = ["victim", "complaint", "waiting", "blame", "ownership", "builder"];

function PatternBlock({ kicker, block, t, secondary = false }) {
  return (
    <div className={`sos-result-pattern${secondary ? " sos-result-pattern--secondary" : ""}`}>
      <div className="sos-result-kicker">{kicker}</div>
      <div className="sos-result-name">{block.name}</div>
      <div className="sos-result-headline">{block.headline}</div>
      <p style={{ marginBottom: 0 }}>{block.explanation}</p>

      <div className="sos-section-title">💪 {t.strengthsTitle}</div>
      <ul className="sos-list">
        {block.strengths.map((s, i) => <li key={i}>{s}</li>)}
      </ul>

      <div className="sos-section-title">🌱 {t.risksTitle}</div>
      <ul className="sos-list">
        {block.risks.map((r, i) => <li key={i}>{r}</li>)}
      </ul>

      <div className="sos-section-title">📘 {t.techniquesTitle}</div>
      <ul className="sos-list">
        {block.techniques.map((x, i) => <li key={i}>{x}</li>)}
      </ul>

      <div className="sos-section-title">❓ {t.sosQuestionsTitle}</div>
      {block.sosQuestions.map((q, i) => (
        <div key={i} className="sos-q-chip">“{q}”</div>
      ))}
    </div>
  );
}

export default function SosResultScreen({ result }) {
  const t = STRINGS[result.language] || STRINGS.uz;
  const common = result.common || {};
  const scores = result.scores || {};
  const maxScore = Math.max(1, ...PATTERN_ORDER.map((p) => scores[p] || 0));

  return (
    <div>
      <div className="sos-card">
        <div className="sos-emoji sos-center" aria-hidden="true">🎉</div>
        <h1 className="sos-center">{t.resultTitle}</h1>
        <p className="sos-center">{t.resultIntro}</p>
      </div>

      <div className="sos-card">
        <PatternBlock kicker={common.primaryTitle || ""} block={result.primary} t={t} />
        {result.secondary && (
          <PatternBlock kicker={common.secondaryTitle || ""} block={result.secondary} t={t} secondary />
        )}
      </div>

      <div className="sos-card">
        <h2>{t.scoresTitle}</h2>
        <div className="sos-bars">
          {PATTERN_ORDER.map((p) => (
            <div key={p} className="sos-bar-row">
              <div className="sos-bar-label">{(result.patternNames && result.patternNames[p]) || ""}</div>
              <div className="sos-bar-track">
                <div className={`sos-bar-fill sos-fill-${p}`} style={{ width: `${((scores[p] || 0) / maxScore) * 100}%` }} />
              </div>
              <div className="sos-bar-value">{scores[p] || 0}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="sos-card">
        <div className="sos-note">💡 {common.reminder}</div>
        <p style={{ marginTop: 14, fontWeight: 600 }}>{common.encouragement}</p>
      </div>
    </div>
  );
}
