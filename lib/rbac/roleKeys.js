/**
 * Pure helpers for custom-role system keys (blocker §11).
 *
 * A custom role needs a STABLE, UNIQUE system_key — permission scoping and
 * audit reference roles by key, and a NULL key (the old behaviour) left custom
 * roles unidentifiable. Custom keys are generated from the display name, always
 * carry a `custom_` prefix so they can never collide with or impersonate a
 * built-in/reserved key, and are de-duplicated against existing keys.
 *
 * No I/O — the caller passes the set of existing keys from inside its
 * transaction so generation and the DB write share one consistent view.
 */
'use strict';

/** Built-in role keys a custom role may never claim. */
const RESERVED_ROLE_KEYS = new Set([
  'super_admin',
  'trailer_manager',
  'trailer_employee',
  'trailer_accounting',
  'trailer_viewer',
]);

/** Prefixes reserved for the system so custom keys can't masquerade as built-ins. */
const RESERVED_PREFIXES = ['super_', 'admin_'];

const CUSTOM_PREFIX = 'custom_';

/** Lowercase slug of a display name: alphanumerics and single underscores. */
function slugify(displayName) {
  return String(displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** True when a key is reserved for the system and off-limits to custom roles. */
function isReservedRoleKey(key) {
  const k = String(key || '').toLowerCase();
  if (RESERVED_ROLE_KEYS.has(k)) return true;
  return RESERVED_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * A unique `custom_*` system key for a new role. Throws if the display name has
 * no usable characters. `existingKeys` is any iterable of keys already in use.
 */
function generateCustomRoleKey(displayName, existingKeys = []) {
  const slug = slugify(displayName);
  if (!slug) {
    throw Object.assign(new Error('Role name must contain letters or numbers.'), {
      status: 400, code: 'INVALID_ROLE_NAME',
    });
  }
  const taken = new Set(Array.from(existingKeys, (k) => String(k || '').toLowerCase()));
  const base = `${CUSTOM_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Effectively unreachable; keeps the contract total.
  throw Object.assign(new Error('Could not allocate a unique role key.'), { status: 409 });
}

module.exports = {
  RESERVED_ROLE_KEYS, CUSTOM_PREFIX, slugify, isReservedRoleKey, generateCustomRoleKey,
};
