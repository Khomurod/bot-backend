/**
 * /answers — presentation sections (all Uzbek). Every section renders only
 * anonymous aggregated data (no names, tokens, or individual records).
 * Department and dispatch-team results render for ANY group size — including
 * a single respondent — as explicitly requested for this internal event.
 */
import { useState } from "react";

const PATTERN_ORDER = ["victim", "complaint", "waiting", "blame", "ownership", "builder"];

function PatternBars({ counts, meta }) {
  const max = Math.max(1, ...PATTERN_ORDER.map((p) => counts[p] || 0));
  return (
    <div className="sos-bars">
      {PATTERN_ORDER.map((p) => (
        <div key={p} className="sos-bar-row">
          <div className="sos-bar-label">{meta[p].name}</div>
          <div className="sos-bar-track">
            <div className={`sos-bar-fill sos-fill-${p}`} style={{ width: `${((counts[p] || 0) / max) * 100}%` }} />
          </div>
          <div className="sos-bar-value">{Math.round((counts[p] || 0) * 10) / 10}</div>
        </div>
      ))}
    </div>
  );
}

function TopPatternStory({ topPatterns, meta }) {
  if (!topPatterns || topPatterns.length === 0) return null;
  const main = meta[topPatterns[0]];
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ marginBottom: 6 }}>
        Eng koʻp uchragan javob uslubi: <b>{main.name}</b>.
      </p>
      <p style={{ marginBottom: 6 }}>✅ <b>Yaxshi tomoni:</b> {main.positive}</p>
      <p style={{ marginBottom: 6 }}>⚠️ <b>Eʼtibor beriladigan jihati:</b> {main.risk}</p>
      <p style={{ marginBottom: 0 }}>💬 <b>Foydali SOS savoli:</b> “{main.sosQuestion}”</p>
    </div>
  );
}

export function CompanySection({ summary }) {
  const meta = summary.patternMeta;
  const company = summary.company;
  return (
    <div className="sos-card">
      <div className="sos-card-kicker">Kompaniya boʻyicha umumiy manzara</div>
      <h2>Butun jamoaning SOS profili</h2>
      <div className="sos-grid">
        <div>
          <p style={{ fontWeight: 700, marginBottom: 8 }}>Asosiy javob uslubi boʻyicha (odamlar soni)</p>
          <PatternBars counts={company.primaryCounts} meta={meta} />
        </div>
        <div>
          <p style={{ fontWeight: 700, marginBottom: 8 }}>Barcha javoblar boʻyicha (ball ulushi)</p>
          <PatternBars counts={company.answerPatternCounts} meta={meta} />
          <TopPatternStory topPatterns={company.topPatterns} meta={meta} />
        </div>
      </div>
    </div>
  );
}

export function TechniquesSection({ presentation }) {
  return (
    <div className="sos-card">
      <div className="sos-card-kicker">Kitobdan asosiy usul</div>
      <h2>Notoʻgʻri savolni SOS savoliga almashtiring</h2>
      {presentation.techniques.map((tech) => (
        <div key={tech.from} className="sos-swap">
          <span className="from">“{tech.from}”</span>
          <span className="arrow">→</span>
          <span className="to">“{tech.to}”</span>
        </div>
      ))}
    </div>
  );
}

function QuestionDistributions({ questions }) {
  const [open, setOpen] = useState(false);
  const answered = questions.filter((q) => q.options.some((o) => o.count > 0));
  if (answered.length === 0) return null;
  return (
    <div className="sos-qdist">
      <button type="button" className="sos-toggle-link" onClick={() => setOpen(!open)}>
        {open ? "▲ Savollar boʻyicha taqsimotni yashirish" : "▼ Savollar boʻyicha taqsimotni koʻrish"}
      </button>
      {open && answered.map((q, qi) => {
        const max = Math.max(1, ...q.options.map((o) => o.count));
        return (
          <div key={q.key} style={{ marginBottom: 14 }}>
            <div className="sos-qdist-q">{qi + 1}. {q.textUz}</div>
            {q.options.map((o) => (
              <div key={o.key} className="sos-qdist-opt">
                <div className="sos-qdist-text">{o.textUz}</div>
                <div className="sos-qdist-meter">
                  <div className="sos-qdist-track">
                    <div className="sos-qdist-fill" style={{ width: `${(o.count / max) * 100}%` }} />
                  </div>
                  <div className="sos-qdist-n">{o.count}</div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function DepartmentsSection({ summary }) {
  const meta = summary.patternMeta;
  const active = summary.departments.filter((d) => d.count > 0);
  if (active.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="sos-card" style={{ marginBottom: 18 }}>
        <div className="sos-card-kicker">Boʻlimlar kesimida</div>
        <h2>Har bir boʻlimning oʻz manzarasi</h2>
        <p style={{ marginBottom: 0 }}>
          Maqsad — taqqoslash yoki baholash emas: har bir boʻlim oʻz kuchli tomonini va oʻsish nuqtasini koʻradi.
        </p>
      </div>
      <div className="sos-grid">
        {active.map((dept) => (
          <div key={dept.key} className="sos-card">
            <h2>
              {dept.labelUz}
              <span className="sos-badge">{dept.count} ta javob</span>
            </h2>
            <PatternBars counts={dept.primaryCounts} meta={meta} />
            <TopPatternStory topPatterns={dept.topPatterns} meta={meta} />
            {dept.technique && <div className="sos-technique">🛠 {dept.technique}</div>}
            {dept.sosQuestions && dept.sosQuestions.map((q) => (
              <div key={q} className="sos-q-chip" style={{ marginTop: 8 }}>“{q}”</div>
            ))}
            {dept.questions && <QuestionDistributions questions={dept.questions} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TeamsSection({ summary }) {
  const meta = summary.patternMeta;
  const teams = summary.dispatchTeams || [];
  if (teams.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="sos-card" style={{ marginBottom: 18 }}>
        <div className="sos-card-kicker">Dispetcherlik jamoalari</div>
        <h2>Jamoalar kesimida</h2>
        <p style={{ marginBottom: 0 }}>
          Har bir jamoa — bitta katta jamoaning qismi. Natijalar reyting emas, oʻsish uchun koʻzgu.
        </p>
      </div>
      <div className="sos-grid">
        {teams.map((team) => (
          <div key={team.teamName} className="sos-card">
            <h2>
              {team.teamName}
              <span className="sos-badge">{team.count} ta javob</span>
            </h2>
            <PatternBars counts={team.primaryCounts} meta={meta} />
            <TopPatternStory topPatterns={team.topPatterns} meta={meta} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PracticesSection({ presentation }) {
  return (
    <div className="sos-card">
      <div className="sos-card-kicker">Kundalik amaliyot</div>
      <h2>SOS tamoyillari — har kuni</h2>
      <ul className="sos-list" style={{ fontSize: 17 }}>
        {presentation.practices.map((practice) => (
          <li key={practice}>{practice}</li>
        ))}
      </ul>
    </div>
  );
}
