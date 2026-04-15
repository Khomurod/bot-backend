/**
 * db.js
 * Persistent storage for the Samsara API pagination cursor.
 * Prefers Upstash Redis when configured, then better-sqlite3, then JSON file storage.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'cursor.db');
const JSON_FILE = path.join(DATA_DIR, 'cursor.json');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = 'samsara_bot_cursor';

// Ensure data directory exists
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
} catch (err) {
    console.error('[DB] Failed to create data directory:', err.message);
}

let db = null;
let redis = null;
let useRedis = false;
let useJsonFallback = false;

if (REDIS_URL && REDIS_TOKEN) {
    try {
        const { Redis } = require('@upstash/redis');
        redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
        useRedis = true;
        console.log('[DB] Using Upstash Redis for persistent cursor storage.');
    } catch (err) {
        console.warn('[DB] Failed to initialize Upstash Redis cursor storage:', err.message);
    }
}

if (!useRedis) {
    try {
        const Database = require('better-sqlite3');
        db = new Database(DB_FILE);
        db.pragma('journal_mode = WAL'); // Better concurrency, less disk I/O
        console.log(`[DB] Connected to SQLite cursor database at ${DB_FILE}`);

        // Create table if it doesn't exist
        db.exec(`
            CREATE TABLE IF NOT EXISTS sync_state (
                id INTEGER PRIMARY KEY,
                next_cursor TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Ensure the single row exists
        const rowCount = db.prepare('SELECT COUNT(*) as count FROM sync_state WHERE id = 1').get().count;
        if (rowCount === 0) {
            db.prepare('INSERT INTO sync_state (id, next_cursor) VALUES (1, NULL)').run();
        }
    } catch (err) {
        console.warn('[DB] SQLite initialization failed (normal if better-sqlite3 is not installed).');
        console.warn(`[DB] Falling back to JSON storage at ${JSON_FILE}`);
        useJsonFallback = true;
    }
}

let cachedCursor = null;

module.exports = {
    async init() {
        if (useRedis && redis) {
            try {
                const cursor = await redis.get(REDIS_KEY);
                cachedCursor = cursor ? String(cursor) : null;
                console.log(`[DB] Loaded cursor from Redis: ${cachedCursor || '(empty)'}`);
                return cachedCursor;
            } catch (err) {
                console.error('[DB] Redis init failed:', err.message);
                return cachedCursor;
            }
        }

        return this.getCursor();
    },

    /**
     * Get the last saved cursor.
     * @returns {string|null} The cursor string, or null if none saved.
     */
    getCursor() {
        if (cachedCursor) return cachedCursor;

        if (useRedis) {
            return null;
        }

        if (useJsonFallback) {
            try {
                if (fs.existsSync(JSON_FILE)) {
                    const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
                    cachedCursor = data.next_cursor || null;
                    return cachedCursor;
                }
            } catch (e) {
                console.error('[DB] JSON Read Error:', e.message);
            }
            return null;
        }

        if (!db) return null;
        try {
            const row = db.prepare('SELECT next_cursor FROM sync_state WHERE id = 1').get();
            cachedCursor = row ? row.next_cursor : null;
            return cachedCursor;
        } catch (err) {
            console.error('[DB] Error reading cursor:', err.message);
            return null;
        }
    },

    /**
     * Save the newly fetched cursor.
     * @param {string} cursor - The cursor from Samsara API (pagination.endCursor).
     */
    async saveCursor(cursor) {
        if (!cursor) return;
        if (cursor === cachedCursor) return; // No change

        cachedCursor = cursor;

        if (useRedis && redis) {
            try {
                await redis.set(REDIS_KEY, cursor);
            } catch (err) {
                console.error(`[DB] Redis save error (${cursor}):`, err.message);
            }
            return;
        }

        if (useJsonFallback) {
            try {
                fs.writeFileSync(JSON_FILE, JSON.stringify({ next_cursor: cursor, updated_at: new Date().toISOString() }));
                // console.log(`[DB] Saved new cursor to JSON: ${cursor}`);
            } catch (e) {
                console.error('[DB] JSON Write Error:', e.message);
            }
            return;
        }

        if (!db) return;
        try {
            db.prepare(`
                UPDATE sync_state 
                SET next_cursor = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE id = 1
            `).run(cursor);
            // console.log(`[DB] Saved new cursor: ${cursor}`);
        } catch (err) {
            console.error(`[DB] Error saving cursor (${cursor}):`, err.message);
        }
    },

    /**
     * Clear the in-memory cursor cache so the next read comes from storage.
     * Useful after persistence errors or for explicit diagnostics.
     */
    resetCursorCache() {
        cachedCursor = null;
    }
};
