import React from "react";
import { COMMITMENT_META, RANGES, pctLabel } from "./efficiencyShared";

/**
 * Home Time → Efficiency: the company card (split out of
 * HomeTimeEfficiencyTab.jsx, November 2026).
 *
 * FOUR HEADLINE NUMBERS, THE REST IN ONE LINE. It showed eleven number tiles,
 * a donut and three paragraphs of definitions before the driver table; the
 * owner reads two or three of them. Every number is still here — the four that
 * answer "are we keeping the policy and our promises?", then one line with the
 * others — and the definitions are behind "How is this calculated?".
 */
/** Accessible donut: labelled arcs (never color-only). Falls back to an empty ring. */
function Donut({ segments, size = 168, stroke = 26 }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Cycle compliance breakdown">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--neutral-soft)" strokeWidth={stroke} />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * circumference;
          const dash = `${len} ${circumference - len}`;
          const el = (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
            >
              <title>{`${s.label}: ${s.value} (${total ? Math.round((s.value / total) * 100) : 0}%)`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </g>
      <text x="50%" y="47%" textAnchor="middle" fontSize="26" fontWeight="700" fill="currentColor">
        {total}
      </text>
      <text x="50%" y="61%" textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.7">
        cycles
      </text>
    </svg>
  );
}
export default function CompanyEfficiencyCard({ company, range, setRange, donutSegments }) {
  const total = (company.total_completed_cycles || 0) + (company.incomplete || 0);
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="home-time-section-head">
        <div>
          <h3>Company home-time efficiency</h3>
          <p>
            Company drivers&apos; completed cycles against the policy: at least{" "}
            <strong>{company.road_allowance_days} days</strong> on the road, no more than{" "}
            <strong>{company.home_allowance_days} days</strong> at home.
          </p>
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 180 }}>
          <label>Date range</label>
          <select className="form-select" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", marginTop: 12 }}>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <Donut segments={donutSegments} />
          <div>
            {donutSegments.map((s) => {
              const share = total ? Math.round((s.value / total) * 100) : 0;
              return (
                <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: "inline-block" }} />
                  <span style={{ minWidth: 130 }}>{s.label}</span>
                  <strong>{s.value}</strong>
                  <span style={{ opacity: 0.6 }}>({share}%)</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="home-time-summary-strip" style={{ flex: 1, minWidth: 260 }}>
          <div className="home-time-summary-chip">
            <strong>{pctLabel(company.strict_efficiency_pct)}</strong>
            <span>Strict efficiency</span>
          </div>
          <div className="home-time-summary-chip">
            <strong>{pctLabel(company.operational_efficiency_pct)}</strong>
            <span>Incl. approved exceptions</span>
          </div>
          <div className="home-time-summary-chip">
            <strong>{pctLabel(company.commitment_pct)}</strong>
            <span>Commitments met</span>
          </div>
          <div className="home-time-summary-chip">
            <strong>{company.total_completed_cycles}</strong>
            <span>Cycles analyzed</span>
          </div>
        </div>
      </div>

      <p className="home-time-muted" style={{ margin: "10px 0 0" }}>
        {company.total_eligible_drivers} eligible drivers · {company.approved_exception} approved exceptions ·
        approved home windows: {company.commitment_evaluated || 0} evaluated,{" "}
        <span style={{ color: COMMITMENT_META.met.color }}>{company.commitment_met || 0} met</span>,{" "}
        <span style={(company.commitment_broken || 0) ? { color: COMMITMENT_META.broken.color } : undefined}>
          {company.commitment_broken || 0} broken
        </span>, {company.commitment_incomplete || 0} awaiting return,{" "}
        {company.commitment_none || 0} with no approved dates.
      </p>
      {(company.commitment_evaluated || 0) === 0 && (
        <p className="home-time-muted" style={{ margin: "6px 0 0" }}>
          No approved home windows with registered dates have completed in this range yet, so there is not enough
          data to score company commitment.
        </p>
      )}

      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer" }} className="home-time-muted">How is this calculated?</summary>
        <p className="home-time-muted" style={{ margin: "8px 0 0" }}>
          From actual completed cycles; owner operators are not counted (the policy does not apply to them).
          Strict efficiency = compliant cycles ÷ all policy-eligible completed cycles. Operational efficiency also
          credits approved exceptions. Incomplete cycles (home stay not yet closed) are excluded from both.
        </p>
        <p className="home-time-muted" style={{ margin: "8px 0 0" }}>
          Commitments: of the home windows the company <strong>approved</strong>, how often what actually happened
          matched the registered dates — the driver got home by the promised day and was back on the road by the
          promised return (±{company.commitment_grace_days ?? 1}d). Cycles with no approved dates, or whose home stay
          is still open, are counted separately and never as met or broken.
        </p>
      </details>
    </div>
  );
}
