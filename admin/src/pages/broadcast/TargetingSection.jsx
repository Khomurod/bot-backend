import React from "react";

/**
 * Audience and language — SHARED by both tabs.
 *
 * One selection governs whichever tab sends, which is the point: separate
 * per-tab pickers would let an admin choose drivers on one tab and send from
 * the other. The force-language control lives here for the same reason — both
 * payloads honour it.
 *
 * An empty selection in the driver or language modes is refused by
 * useBroadcastTargeting rather than silently widening to everyone.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function TargetingSection({
  targetType, setTargetType, targetActiveFilter, setTargetActiveFilter,
  selectedDriverIds, setSelectedDriverIds, selectedLanguages, driverGroups,
  forceLanguage, setForceLanguage, toggleDriverId, toggleLanguage,
}) {
  return (


  <div className="card" style={{ marginBottom: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>🎯 Audience &amp; language</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Force Language:</label>
        <select className="form-input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }} value={forceLanguage || ''} onChange={(e) => setForceLanguage(e.target.value || null)}>
          <option value="">🔄 Auto (Group Default)</option>
          <option value="en">🇺🇸 EN</option>
          <option value="ru">🇷🇺 RU</option>
          <option value="uz">🇺🇿 UZ</option>
        </select>
      </div>
    </div>
    <details className="collapse-panel">
      <summary>Target groups</summary>
      <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="target" value="all" checked={targetType === 'all'} onChange={() => setTargetType('all')} style={{ accentColor: 'var(--accent)' }} />
            All Groups
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="target" value="specific_drivers" checked={targetType === 'specific_drivers'} onChange={() => setTargetType('specific_drivers')} style={{ accentColor: 'var(--accent)' }} />
            Specific Drivers
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="target" value="language_groups" checked={targetType === 'language_groups'} onChange={() => setTargetType('language_groups')} style={{ accentColor: 'var(--accent)' }} />
            By Language
          </label>
        </div>

        {targetType === 'specific_drivers' && (
          <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)', padding: 8, marginBottom: 8 }}>
            {driverGroups.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>No driver groups found.</p> : (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, paddingRight: 8 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                    if (selectedDriverIds.length === driverGroups.length) {
                      setSelectedDriverIds([]);
                    } else {
                      setSelectedDriverIds(driverGroups.map(g => g.id));
                    }
                  }} style={{ padding: '4px 8px', fontSize: 11 }}>
                    {selectedDriverIds.length === driverGroups.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>
                {driverGroups.map(g => (
                  <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={selectedDriverIds.includes(g.id)} onChange={() => toggleDriverId(g.id)} style={{ accentColor: 'var(--accent)' }} />
                    <span style={{ fontWeight: 600 }}>{g.group_name || 'Unknown'}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                      ({g.language?.toUpperCase()}) {g.active === false ? '(Inactive)' : '(Active)'}
                    </span>
                  </label>
                ))}
              </>
            )}
          </div>
        )}

        {targetType === 'language_groups' && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 0, flexWrap: 'wrap' }}>
            {['en', 'ru', 'uz'].map(l => (
              <label key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', background: 'var(--bg-primary)', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                <input type="checkbox" checked={selectedLanguages.includes(l)} onChange={() => toggleLanguage(l)} style={{ accentColor: 'var(--accent)' }} />
                {l.toUpperCase()}
              </label>
            ))}
          </div>
        )}

        {(targetType === 'all' || targetType === 'language_groups') && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>Driver status</p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ].map((opt) => (
                <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="target_active_filter"
                    value={opt.value}
                    checked={targetActiveFilter === opt.value}
                    onChange={() => setTargetActiveFilter(opt.value)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  </div>
  );
}
