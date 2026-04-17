const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin', 'src', 'App.jsx');
let content = fs.readFileSync(filePath, 'utf8');

// Task 2: MediaUploader
content = content.replace(
  'function MediaUploader({ onAdd, onRemove, items }) {',
  'function MediaUploader({ onAdd, onRemove, items }) {\n  const [uploadProgress, setUploadProgress] = useState(null);'
);

const oldHandleFileChange = `  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    if (!file) return;

    if (file.size > MAX_MB * 1024 * 1024) {
      setUploadError(\`File too large. Maximum size is \${MAX_MB}MB.\`);
      return;
    }

    setUploadError(null);
    setUploading(true);
    try {
      const result = await api.uploadMedia(file);
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      onAdd({ file_id: result.file_id, type: result.media_type, previewUrl });
    } catch (err) {
      setUploadError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };`;

const newHandleFileChange = `  const handleFileChange = async (e) => {
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
  };`;

content = content.replace(oldHandleFileChange, newHandleFileChange);

content = content.replace(
  "type=\"file\"\n            accept={ACCEPTED}\n            style={{ display: 'none' }}\n            onChange={handleFileChange}",
  "type=\"file\"\n            accept={ACCEPTED}\n            multiple\n            style={{ display: 'none' }}\n            onChange={handleFileChange}"
);

content = content.replace(
  "{uploading ? (\n            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div className=\"spinner\" style={{ margin: 0 }} />Uploading to Telegram...</div>",
  "{uploading ? (\n            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>\n              <div className=\"spinner\" style={{ margin: 0 }} />\n              Uploading to Telegram... {uploadProgress && `(${uploadProgress})`}\n            </div>"
);

// Task 3: BroadcastPage Select All
const oldDriverSelection = `{targetType === 'specific_drivers' && (
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
                  )}`;

const newDriverSelection = `{targetType === 'specific_drivers' && (
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
                  )}`;

content = content.replace(oldDriverSelection, newDriverSelection);

// Update send buttons text
content = content.replace(
  "{sending ? '⏳ Sending...' : '📤 Send to All Groups'}",
  "{sending ? '⏳ Sending...' : targetType === 'all' ? '📤 Send to All Groups' : '📤 Send to Selected'}"
);

content = content.replace(
  "{confSending ? '⏳ Sending...' : '📤 Send to All Groups'}",
  "{confSending ? '⏳ Sending...' : '📤 Send Broadcast'}"
);

// Task 4: Sort Birthdays
content = content.replace(
  '      const data = await api.getGroups();\n      setGroups(data);',
  '      const data = await api.getGroups();\n      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.driver_birthday) - getDaysUntilBirthday(b.driver_birthday));\n      setGroups(sorted);'
);

// (CompanyBirthdaysPage loadData was already patched in the failed-but-partially-successful multi_replace)
// Wait, I should check if it was REALLY patched.
// Actually, I'll just add it to the script in case it wasn't.

if (!content.includes('const sorted = data.sort((a, b) => getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));')) {
  content = content.replace(
    '      const data = await api.getEmployeeBirthdays();\n      setEmployees(data);',
    '      const data = await api.getEmployeeBirthdays();\n      const sorted = data.sort((a, b) => getDaysUntilBirthday(a.birthday) - getDaysUntilBirthday(b.birthday));\n      setEmployees(sorted);'
  );
}

fs.writeFileSync(filePath, content);
console.log('App.jsx updated successfully.');
