/**
 * /answers — presentation sections (all Uzbek).
 *
 * ONE company-wide picture: "this is how we, as one company, tend to react".
 * There are deliberately NO department or dispatch-team sections, no group
 * comparisons and no question distributions — the public summary API does not
 * send them at all (see services/sosAssessment/aggregation.js).
 *
 * Every number here is a share of RESPONDENTS whose primary tendency is that
 * pattern, and every example quote is authored content from the assessment
 * itself — never anyone's submitted answer.
 */

function CompanyPatternRow({ row, meta }) {
  const info = meta[row.pattern];
  return (
    <li className="sos-pattern-row" data-pattern={row.pattern}>
      <div className="sos-pattern-head">
        <span className="sos-pattern-name">{info.name}</span>
        <span className="sos-pattern-figures">
          <b className="sos-pattern-percent">{row.percent}%</b>
          <span className="sos-pattern-count">{row.count} kishi</span>
        </span>
      </div>
      <div className="sos-bar-track">
        <div
          className={`sos-bar-fill sos-fill-${row.pattern}`}
          style={{ width: `${row.percent}%` }}
        />
      </div>
      <p className="sos-pattern-example">
        <span className="label">Misol javob:</span> “{info.example}”
      </p>
    </li>
  );
}

export function CompanySection({ summary }) {
  const meta = summary.patternMeta;
  const rows = summary.company.primaryPatterns || [];
  return (
    <div className="sos-card">
      <div className="sos-card-kicker">Kompaniya boʻyicha umumiy manzara</div>
      <h2>Biz, bitta jamoa sifatida, qanday javob beramiz</h2>
      <p className="sos-pattern-intro">
        Har bir foiz — asosiy javob uslubi shu turga kirgan xodimlarning barcha
        ishtirokchilarga nisbatan ulushi. Jami {summary.total} ta javob.
      </p>
      <ul className="sos-patterns">
        {rows.map((row) => (
          <CompanyPatternRow key={row.pattern} row={row} meta={meta} />
        ))}
      </ul>
      <TopPatternStory topPatterns={summary.company.topPatterns} meta={meta} />
    </div>
  );
}

function TopPatternStory({ topPatterns, meta }) {
  if (!topPatterns || topPatterns.length === 0) return null;
  const main = meta[topPatterns[0]];
  return (
    <div className="sos-pattern-story">
      <p style={{ marginBottom: 6 }}>
        Eng koʻp uchragan javob uslubi: <b>{main.name}</b>.
      </p>
      <p style={{ marginBottom: 6 }}>✅ <b>Yaxshi tomoni:</b> {main.positive}</p>
      <p style={{ marginBottom: 6 }}>⚠️ <b>Eʼtibor beriladigan jihati:</b> {main.risk}</p>
      <p style={{ marginBottom: 0 }}>💬 <b>Foydali SOS savoli:</b> “{main.sosQuestion}”</p>
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
