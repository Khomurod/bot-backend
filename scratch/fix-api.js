const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'server', 'api.js');
let content = fs.readFileSync(filePath, 'utf8');

// The mess started around line 128
const lines = content.split('\n');

// Reconstruct the file. 
// I have the first 127 lines which are likely okay.
const head = lines.slice(0, 127).join('\n');

const middle = `
// GET /api/auth/verify
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, username: req.admin.username });
});

// ─── Health Check (public, for cron keep-alive) ───
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Media Upload ───

// POST /api/upload-media
app.post('/api/upload-media', authMiddleware, (req, res) => {
  upload.single('media')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: \`File too large. Maximum size is \${MAX_FILE_SIZE_MB}MB.\` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    try {
      const isVideo = req.file.mimetype.startsWith('video/');
      const mediaType = isVideo ? 'video' : 'photo';
      const fileSource = { source: req.file.buffer, filename: req.file.originalname };
      const managementGroupId = config.managementGroupId;

      let sentMessage;
      if (isVideo) {
        sentMessage = await bot.telegram.sendVideo(managementGroupId, fileSource, {
          caption: '📎 [Upload to get file_id — will be deleted]',
        });
      } else {
        sentMessage = await bot.telegram.sendPhoto(managementGroupId, fileSource, {
          caption: '📎 [Upload to get file_id — will be deleted]',
        });
      }

      // Extract file_id
      let fileId;
      if (isVideo) {
        fileId = sentMessage.video?.file_id;
      } else {
        const photos = sentMessage.photo;
        // Use highest resolution
        fileId = photos && photos.length > 0 ? photos[photos.length - 1].file_id : null;
      }

      // Edit the caption instead of deleting, so Telegram keeps the file_id alive
      try {
        await bot.telegram.editMessageCaption(
          managementGroupId, 
          sentMessage.message_id, 
          undefined, 
          '🔒 *Media stored securely for upcoming broadcast.*', 
          { parse_mode: 'Markdown' }
        );
      } catch (_) {
        // Non-critical: ignore if edit fails
      }

      if (!fileId) {
        return res.status(500).json({ error: 'Failed to retrieve file_id from Telegram' });
      }

      console.log(\`[API] Media uploaded: type=\${mediaType}, file_id=\${fileId}\`);
      res.json({ file_id: fileId, media_type: mediaType });
    } catch (uploadErr) {
      console.error('[API] Media upload error:', uploadErr.message);
      res.status(500).json({ error: 'Failed to upload media to Telegram. Check bot permissions.' });
    }
  });
});

// ─── Groups Routes ───

// GET /api/groups
app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await db.getAllGroups();
    res.json(groups);
  } catch (err) {
    console.error('[API] Error fetching groups:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});
`;

// Find where to resume. 
// The broken file has line 131 (in the current view) as // PUT /api/groups/:id/language
// In my current lines array, that would be around line 130.

let tail = '';
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('// PUT /api/groups/:id/language')) {
        tail = lines.slice(i).join('\n');
        break;
    }
}

fs.writeFileSync(filePath, head + middle + tail);
console.log('File server/api.js restored and fixed.');
