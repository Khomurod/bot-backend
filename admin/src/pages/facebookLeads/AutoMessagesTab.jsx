import React from "react";
import { friendlyTimezone } from "../../utils/formatTime";
import { WEEKDAYS, TIMEZONES, emptyRule } from "./constants";
import { PreviewPanel } from "./PreviewPanel";
import { PlaceholderChips } from "./PlaceholderChips";
import { RecruiterMessagesSection } from "./RecruiterMessagesSection";

/**
 * The auto-reply editor: sender identity, timezone, the ordered time-window
 * rules, the outside-hours fallback, and both previews.
 *
 * PRECEDENCE, top to bottom: the assigned recruiter's own message (the
 * Recruiter messages section) beats everything; failing that RULE ORDER IS
 * PRECEDENCE — the first window that matches a lead's arrival time wins — so
 * the ↑/↓ buttons are functional, not cosmetic, and every move renumbers
 * sort_order through useAutoMessages; failing that, the fallback.
 *
 * Presentational: every control calls a handler from useAutoMessages, which
 * owns the debounced previews and the save.
 *
 * TWO COLUMNS SINCE NOVEMBER 2026. The editor on the left, in the order the
 * rules apply in reverse — basics, time rules, fallback, then the per-recruiter
 * messages that beat them — with Save in a bar that stays in view. On the
 * right, kept in view: the placeholder chips (they insert into whichever
 * template has focus) and both previews, "now" and "the one you are editing",
 * in one place. They used to be above and below 1,800 px of editor, the chips
 * floating outside any card.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function AutoMessagesTab({
  settings, setSettings, rules, setRules, placeholders,
  previewTarget, nowPreview, editPreview, nowSubtitle, editingLabel,
  sampleLead, setSampleLead, timezone,
  focusRule, focusFallback, insertPlaceholder, fallbackRef, ruleRefs,
  recruiterMessages, setRecruiterTemplate, focusRecruiter, recruiterRefs,
  saving, handleSave, handleReset, toggleDay, moveRule,
}) {
  return (
  <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
    <div style={{ flex: "1 1 520px", minWidth: 0 }}>
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={settings.is_enabled !== false}
            onChange={(e) => setSettings({ ...settings, is_enabled: e.target.checked })}
          />
          Enable auto-SMS for new leads
        </label>

        {/* auto-fit, not two fixed columns: on a phone the second column cut
            "Central Time (America/Chicago)" off. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
          <label>
            Timezone
            <select
              className="form-input"
              value={timezone}
              onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{friendlyTimezone(tz)} ({tz})</option>
              ))}
            </select>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              All rule start/end times use this timezone.
            </span>
          </label>
          <label>
            Rep name
            <input
              className="form-input"
              value={settings.rep_name || ""}
              onChange={(e) => setSettings({ ...settings, rep_name: e.target.value })}
            />
          </label>
          <label>
            Company name
            <input
              className="form-input"
              value={settings.company_name || ""}
              onChange={(e) => setSettings({ ...settings, company_name: e.target.value })}
            />
          </label>
          <label>
            Position label
            <input
              className="form-input"
              value={settings.position_label || ""}
              onChange={(e) => setSettings({ ...settings, position_label: e.target.value })}
            />
          </label>
        </div>

        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 0 }}>
          Which message a lead gets: their recruiter&apos;s own message if one is set (last on this
          page); otherwise the first greeting-schedule rule that matches (top to bottom); otherwise the fallback.
        </p>
      </div>
      {/* "Greeting schedule", not "Time rules" (November 2026): Teach Wenze has
          working hours too, and the two are separate on purpose
          (docs/architecture/recruiting-after-hours.md). */}
      <h3 style={{ marginBottom: 4 }}>Greeting schedule</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
        Picks which first text a new lead gets, by when they arrive. Separate on purpose from the
        working hours on Teach Wenze, which decide when Wenze may answer a candidate.
      </p>
      {rules.map((rule, index) => (
        <div
          key={index}
          className="card"
          style={{
            marginBottom: 12,
            padding: 16,
            opacity: rule.is_active === false ? 0.6 : 1,
            outline: previewTarget.kind === "rule" && previewTarget.index === index
              ? "1px solid var(--accent)"
              : undefined,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
            <input
              className="form-input"
              style={{ flex: 1, minWidth: 140 }}
              value={rule.label || ""}
              onChange={(e) => setRules((prev) => prev.map((r, i) => (
                i === index ? { ...r, label: e.target.value } : r
              )))}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={rule.is_active !== false}
                onChange={(e) => setRules((prev) => prev.map((r, i) => (
                  i === index ? { ...r, is_active: e.target.checked } : r
                )))}
              />
              Active
            </label>
            <button type="button" className="btn btn-secondary" onClick={() => moveRule(index, -1)} disabled={index === 0}>↑</button>
            <button type="button" className="btn btn-secondary" onClick={() => moveRule(index, 1)} disabled={index === rules.length - 1}>↓</button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setRules((prev) => prev.filter((_, i) => i !== index));
                if (previewTarget.kind === "rule" && previewTarget.index >= index) {
                  focusRule(Math.max(0, previewTarget.index - 1));
                }
              }}
              disabled={rules.length <= 1}
            >
              Remove
            </button>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {WEEKDAYS.map((d) => (
              <label key={d.value} style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={(rule.days_of_week || []).includes(d.value)}
                  onChange={() => toggleDay(index, d.value)}
                />
                {" "}{d.label}
              </label>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 4, alignItems: "flex-end" }}>
            <label>
              Start
              <input
                type="time"
                className="form-input"
                value={rule.start_time_local || "08:00"}
                onChange={(e) => setRules((prev) => prev.map((r, i) => (
                  i === index ? { ...r, start_time_local: e.target.value } : r
                )))}
              />
            </label>
            <label>
              End
              <input
                type="time"
                className="form-input"
                value={rule.end_time_local || "17:00"}
                onChange={(e) => setRules((prev) => prev.map((r, i) => (
                  i === index ? { ...r, end_time_local: e.target.value } : r
                )))}
              />
            </label>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Times in {friendlyTimezone(timezone)} ({timezone})
          </p>

          <textarea
            ref={(el) => { ruleRefs.current[index] = el; }}
            className="form-input"
            rows={4}
            placeholder="SMS template for this time window..."
            value={rule.message_template || ""}
            onFocus={() => focusRule(index)}
            onChange={(e) => setRules((prev) => prev.map((r, i) => (
              i === index ? { ...r, message_template: e.target.value } : r
            )))}
          />
        </div>
      ))}

      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginBottom: 16 }}
        onClick={() => {
          const nextIndex = rules.length;
          setRules((prev) => [...prev, emptyRule(prev.length)]);
          focusRule(nextIndex);
        }}
      >
        + Add time rule
      </button>
      <h3>Fallback message (outside hours)</h3>
      <textarea
        ref={fallbackRef}
        className="form-input"
        rows={4}
        style={{
          outline: previewTarget.kind === "fallback" ? "1px solid var(--accent)" : undefined,
        }}
        value={settings.fallback_template || ""}
        onFocus={focusFallback}
        onChange={(e) => setSettings({ ...settings, fallback_template: e.target.value })}
      />
      <div style={{ marginTop: 16 }}>
      <RecruiterMessagesSection
        recruiterMessages={recruiterMessages}
        setRecruiterTemplate={setRecruiterTemplate}
        focusRecruiter={focusRecruiter}
        recruiterRefs={recruiterRefs}
        previewTarget={previewTarget}
      />
      </div>
      {/* Always in view (sticky), so Save is never 1,800 px from the field
          being edited. */}
      <div style={{ display: "flex", gap: 8, position: "sticky", bottom: 0, zIndex: 2, background: "var(--bg-primary)", padding: "10px 0", marginTop: 8, borderTop: "1px solid var(--border)" }}>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save settings"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={handleReset}>Reset</button>
      </div>
    </div>

    <aside style={{ flex: "0 1 380px", minWidth: 280, position: "sticky", top: 16, alignSelf: "flex-start" }}>
      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
          Insert into the message you are editing:
        </div>
        <PlaceholderChips placeholders={placeholders} onInsert={insertPlaceholder} />
      </div>
      <PreviewPanel
        title="📱 Live Preview — What New Leads Receive Now"
        subtitle={nowSubtitle}
        preview={nowPreview}
      />
      <div style={{ marginTop: 12 }}>
        <details className="collapse-panel">
          <summary>Customize test lead data</summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 12, marginBottom: 16 }}>
            <input
              className="form-input"
              placeholder="Full name"
              value={sampleLead.full_name}
              onChange={(e) => setSampleLead({ ...sampleLead, full_name: e.target.value })}
            />
            <input
              className="form-input"
              placeholder="Phone"
              value={sampleLead.phone_number}
              onChange={(e) => setSampleLead({ ...sampleLead, phone_number: e.target.value })}
            />
            <input
              className="form-input"
              placeholder="Email"
              value={sampleLead.email}
              onChange={(e) => setSampleLead({ ...sampleLead, email: e.target.value })}
            />
          </div>
        </details>

        <div style={{ marginTop: 12 }}>
          <PreviewPanel
            title="✏️ Editing Preview"
            subtitle={`Previewing: ${editingLabel}. Click a rule or fallback above to switch.`}
            preview={editPreview}
          />
        </div>
      </div>
    </aside>
  </div>
  );
}
