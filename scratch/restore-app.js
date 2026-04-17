const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin', 'src', 'App.jsx');
let content = fs.readFileSync(filePath, 'utf8');

// I will reconstruct the file from known good parts and the fixes.
// I have the original file content from my history.

const head = `import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as api from './api';

function getDaysUntilBirthday(dateString) {
  if (!dateString) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bday = new Date(dateString);
  let nextBday = new Date(today.getFullYear(), bday.getUTCMonth(), bday.getUTCDate());
  if (nextBday < today) {
    nextBday.setFullYear(today.getFullYear() + 1);
  }
  return Math.ceil((nextBday - today) / (1000 * 60 * 60 * 24));
}

// ─────────────── Telegram Message Preview ───────────────
function TelegramPreview({ text, buttons, label, langTabs, mediaItems, mediaPosition }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [activeLang, setActiveLang] = React.useState('en');

  const displayText = langTabs && langTabs[activeLang]?.text !== undefined ? langTabs[activeLang].text : text;
  const displayButtons = langTabs && langTabs[activeLang]?.buttons !== undefined ? langTabs[activeLang].buttons : buttons;
  const effectivePosition = mediaPosition || 'above';
  const items = mediaItems || [];
  const hasMedia = items.length > 0;
  const multi = items.length > 1;

  const MediaBlock = hasMedia ? (
    <div className="tg-media-placeholder">
      {multi ? (
        // Album grid
        <div style={{ display: 'grid', gridTemplateColumns: items.length === 2 ? '1fr 1fr' : '1fr 1fr 1fr', gap: 4 }}>
          {items.map((m, i) => (
            <div key={i} style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 6, padding: 10, textAlign: 'center', fontSize: 18 }}>
              {m.previewUrl && m.type === 'photo'
                ? <img src={m.previewUrl} alt="" style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 4 }} />
                : (m.type === 'video' ? '🎬' : '📷')
              }
            </div>
          ))}
        </div>
      ) : (
        // Single item
        items[0].previewUrl && items[0].type === 'photo' ? (
          <img src={items[0].previewUrl} alt="media preview" style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 8 }} />
        ) : (
          <span>{items[0].type === 'video' ? '🎬 Video' : '📷 Photo'}</span>
        )
      )}
      {multi && <div style={{ fontSize: 11, color: '#8a9bb0', marginTop: 6 }}>🖼️ Album · {items.length} items</div>}
    </div>
  ) : null;

  return (
    <div style={{ padding: 16 }}>
      {label && <p style={{ fontSize: 12, color: '#64748b', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</p>}
      {langTabs && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {['en', 'ru', 'uz'].map(lang => (
            <button
              key={lang}
              type="button"
              onClick={() => setActiveLang(lang)}
              style={{
                padding: '4px 14px', fontSize: 12, fontWeight: 600,
                border: activeLang === lang ? '2px solid var(--primary)' : '1px solid var(--border)',
                borderRadius: 6,
                background: activeLang === lang ? 'var(--primary)' : 'transparent',
                color: activeLang === lang ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer', textTransform: 'uppercase',
              }}
            >
              {{ en: '🇺🇸 EN', ru: '🇷🇺 RU', uz: '🇺🇿 UZ' }[lang]}
            </button>
          ))}
        </div>
      )}
      <div className="telegram-preview">
        {MediaBlock && effectivePosition === 'above' && MediaBlock}
        <div className="tg-text" dangerouslySetInnerHTML={{ __html: (displayText || '<span style="color:#6b7d8e">Type a message to see preview...</span>').replace(/\\n/g, '<br/>') }} />
        {displayButtons && displayButtons.length > 0 && (
          <div className="tg-buttons">
            {displayButtons.map((btn, i) => (
              <div className="tg-btn" key={i}>{btn}</div>
            ))}
          </div>
        )}
        {MediaBlock && effectivePosition === 'below' && MediaBlock}
        <div className="tg-time">{timeStr}</div>
      </div>
    </div>
  );
}

// ─────────────── Media Uploader (multi-file) ───────────────
// onAdd(item): item = { file_id, type, previewUrl }  — called when a file is uploaded
// onRemove(index): remove item at index
// items: [{ file_id, type, previewUrl }]
function MediaUploader({ onAdd, onRemove, items }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const fileInputRef = useRef(null);
  const MAX_ITEMS = 10;
  const ACCEPTED = '.jpg,.jpeg,.png,.webp,.mp4,.mov';
  const MAX_MB = 20;

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    if (!files.length) return;

    if (items && items.length + files.length > MAX_ITEMS) {
      setUploadError(\`Maximum \${MAX_ITEMS} media items allowed. You tried to add \${files.length} more.\`);
      return;
    }

    for (const file of files) {
      if (file.size > MAX_MB * 1024 * 1024) {
        setUploadError(\`File \${file.name} is too large. Maximum size is \${MAX_MB}MB.\`);
        return;
      }
    }

    setUploadError(null);
    setUploading(true);
    setUploadProgress(\`0 / \${files.length}\`);

    let uploadedCount = 0;
    for (const file of files) {
      try {
        const result = await api.uploadMedia(file);
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
        onAdd({ file_id: result.file_id, type: result.media_type, previewUrl });
        uploadedCount++;
        setUploadProgress(\`\${uploadedCount} / \${files.length}\`);
      } catch (err) {
        setUploadError(err.message || \`Upload failed for \${file.name}.\`);
        break; // Stop uploading further files if one fails
      }
    }
    setUploading(false);
    setUploadProgress(null);
  };

  const canAddMore = !uploading && (!items || items.length < MAX_ITEMS);

  return (
    <div className="media-upload-section">
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
        📎 Media Attachments{' '}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>(optional · up to {MAX_ITEMS})</span>
      </h3>

      {/* Uploaded items list */}
      {items && items.length > 0 && (
        <div className="media-item-list">
          {items.map((item, index) => (
            <div className="media-item-row" key={index}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 48, height: 48, background: 'var(--bg-secondary)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>
                    {item.type === 'video' ? '🎬' : '📷'}
                  </div>
                )}
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{item.type}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    #\${index + 1} of \${items.length}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => onRemove(index)}
                style={{ flexShrink: 0 }}
              >
                ✕ Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add button / dropzone */}
      {canAddMore && (
        <div
          className="media-dropzone"
          style={items && items.length > 0 ? { marginTop: 10, padding: '14px 20px' } : {}}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED}
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          {uploading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="spinner" style={{ margin: 0 }} />
              Uploading to Telegram... {uploadProgress && \`(\${uploadProgress})\`}
            </div>
          ) : items && items.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20 }}>➕</span>
              <span style={{ fontWeight: 600 }}>Add Another ({items.length}/{MAX_ITEMS})</span>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📤</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Upload Photo or Video</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>JPG, PNG, WEBP, MP4, MOV · Max {MAX_MB}MB · Up to {MAX_ITEMS} files</div>
            </div>
          )}
        </div>
      )}

      {!canAddMore && !uploading && items.length >= MAX_ITEMS && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Maximum {MAX_ITEMS} media items reached.</div>
      )}

      {uploadError && <div className="alert alert-error" style={{ marginTop: 8, marginBottom: 0 }}>⚠️ {uploadError}</div>}
    </div>
  );
}
`;

// I need the tail from the current file, starting from MediaPositionSelector
let tail = '';
const lines = content.split('\\n');
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('function MediaPositionSelector')) {
        tail = lines.slice(i).join('\\n');
        break;
    }
}

if (!tail) {
    // Fallback if the file is REALLY broken
    console.error('Could not find MediaPositionSelector in current file. Manual restoration needed.');
    process.exit(1);
}

fs.writeFileSync(filePath, head + '\\n' + tail);
console.log('App.jsx partially restored. Now applying other fixes...');

// Now apply the sorting and broadcast button fixes to the newly restored file
content = fs.readFileSync(filePath, 'utf8');

// Sort Groups
content = content.replace(
  '    try {\\n      const data = await api.getGroups();\\n      setGroups(data);',
  '    try {\\n      const data = await api.getGroups();\\n      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday));\\n      setGroups(sorted);'
);

// Select All Drivers
const oldDriverSelection = \`{targetType === 'specific_drivers' && (
                    <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)', padding: 8, marginBottom: 16 }}>
                      {driverGroups.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>No driver groups found.</p>
                        : driverGroups.map(g => (
                          <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}>
                            <input type="checkbox" checked={selectedDriverIds.includes(g.id)} onChange={() => toggleDriverId(g.id)} style={{ accentColor: 'var(--accent)' }} />
                            <span style={{ fontWeight: 600 }}>{g.group_name || 'Unknown'}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({g.language?.toUpperCase()})</span>
                          </label>
                        ))}
                    </div>
                  )}\`;

const newDriverSelection = \`{targetType === 'specific_drivers' && (
                    <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)', padding: 8, marginBottom: 16 }}>
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
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({g.language?.toUpperCase()})</span>
                            </label>
                          ))}
                        </>
                      )}
                    </div>
                  )}\`;

content = content.replace(oldDriverSelection, newDriverSelection);

// Send button text
content = content.replace(
  "{sending ? '⏳ Sending...' : '📤 Send to All Groups'}",
  "{sending ? '⏳ Sending...' : targetType === 'all' ? '📤 Send to All Groups' : '📤 Send to Selected'}"
);

content = content.replace(
  "{confSending ? '⏳ Sending...' : '📤 Send to All Groups'}",
  "{confSending ? '⏳ Sending...' : '📤 Send Broadcast'}"
);

// Sort Employee Birthdays
content = content.replace(
  '    try {\\n      const data = await api.getEmployeeBirthdays();\\n      setEmployees(data);',
  '    try {\\n      const data = await api.getEmployeeBirthdays();\\n      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));\\n      setEmployees(sorted);'
);

fs.writeFileSync(filePath, content);
console.log('App.jsx fully restored and fixed.');
