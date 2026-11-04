# App secrets: the deployment's settings, stored in the app

**Since November 2026.** The tokens, keys and passwords both services run with
(this app and the separate `samsara-integration` service) are stored in the
database, encrypted, and managed from **Settings → System → Secrets**. Coolify
keeps exactly two values per service: `DATABASE_URL` and
`INTEGRATION_SECRET_KEY`.

## Why

From about 20 October 2026 the bot lost incoming messages: Telegram answered
`409 Conflict` because a full copy of this app was being started somewhere
outside Coolify and Hostinger, with the production `.env` — both polling tokens
and the database URL. On 3 November 12 of 36 people's messages in the HIRING
group were never stored, which is why Safety Approvals answered "I could not
find the driver's post". The way out is new tokens and a new database password,
held where a copied `.env` cannot reach them, and changed in one place. That is
this feature. (Investigation and owner decisions: the handoff of 4 November.)

## The rules

1. **Coolify holds only `DATABASE_URL` and `INTEGRATION_SECRET_KEY`** (plus the
   two rollback switches below). Everything else is uploaded on the page. A file
   that contains `DATABASE_URL`, `INTEGRATION_SECRET_KEY`, `PORT`,
   `APP_SECRETS_VERSION` or `APP_SECRETS_OFF` has those lines left out ("stays in
   Coolify"); platform names (`COOLIFY_*`, `SERVICE_FQDN_*`, …) likewise.
2. **A value is encrypted ONLY under `INTEGRATION_SECRET_KEY`** — the shared
   envelope `lib/security/sharedIntegrationCrypto.js`, never its fallback key
   derived from `DATABASE_URL`. The external copy has the database password; it
   must not be able to open these. Without `INTEGRATION_SECRET_KEY` in Coolify
   the page stores nothing and says so. Each version records the key's
   fingerprint, and a reader with another key opens nothing from it.
3. **No value ever leaves the server.** The page and every API answer show a
   name, who reads it, and — for values of 12 characters or more — the last four
   characters. Values are not logged; errors and the audit name names only.
4. **Super administrators only, by role** (`requireSuperAdmin`, not a
   permission that could be granted to a lesser role). Every save, removal and
   restore is in the admin audit with names, never values.
5. **Every change is a new version; nothing is edited in place.** The newest
   version is the one in use. A value that did not change keeps its exact
   ciphertext, so a reader can tell whether ITS values changed.
6. **A stored value overrides the same name in Coolify.** So Coolify can be
   emptied one name at a time, after the upload, without a gap.
7. **Nothing is saved that would keep this app from starting:** the required
   names of `config/config.js` (`requiredEnv`, less `DATABASE_URL`) must be there
   — stored or still in Coolify —; `BOT_TOKEN`, `TELEGRAM_BOT_TOKEN` and
   `SAMSARA_BOT_TOKEN` must be three different tokens (one poller per token); and
   every new or changed bot token is checked with Telegram's `getMe` and must
   work. The preview shows which bot each token belongs to.
8. **After a save that touches what this app reads, it restarts itself:** the
   answer goes out, then SIGTERM runs the normal graceful shutdown (`index.js`)
   and Docker brings the container back (Coolify's `unless-stopped` policy). A
   change only the Samsara service reads does not restart this app.

## Who reads what — scopes

| Scope | Read by | Which names |
|---|---|---|
| `both` | both services | same meaning in both: `BOT_TOKEN` (the main bot; the Samsara service posts driver-group videos with it), `SAMSARA_API_KEY`, `MANAGEMENT_GROUP_ID`, `EMPLOYEE_GROUP_ID`, `GEMINI_*`, `GROQ_*` |
| `bot` | this app | everything else uploaded "for Wenze" |
| `samsara` | the Samsara service | everything else uploaded "for the Samsara service" |

An upload names its target. Shared names land in `both`; the rest in the
target's own scope. A name that means different things in the two services is
never shared: `TELEGRAM_BOT_TOKEN` (the leads bot here, a fallback for the
Samsara bot there — and not stored for the Samsara service at all, which uses
`SAMSARA_BOT_TOKEN`), `PORT`, `USE_WEBHOOK`, `PUBLIC_WEBHOOK_URL`,
`RENDER_EXTERNAL_URL`. A file **replaces** its target's own scope (a name it no
longer contains is removed) but only **adds or changes** shared values — one
service's file never removes a value the other one reads. A single value can
also be removed from the list.

## Boot

`index.js` and the database scripts (`scripts/migrate.js`, `init-db.js`,
`seed-admin.js`) call `require('./config/appSecretsBoot').bootAppSecrets('bot')`
as their **first statement**, before `config/config.js` (which reads
`process.env` the moment it loads). The read is a short child process,
`config/appSecretsFetch.js`, waited for synchronously; it uses its own `pg`
client, reads the newest version (scopes `both` then `bot`), opens each value
with `INTEGRATION_SECRET_KEY` and prints JSON. Then:

- `loaded` → the values go into `process.env`; the log names the version and
  which names overrode Coolify.
- `skipped` (no key, no table yet, nothing stored) or `failed` (wrong key,
  unreadable value, database down) → `process.env` stays exactly as Coolify set
  it, one log line says why. If a required value is then missing,
  `assertRequiredConfig()` stops the process as it always has and Docker retries.

The environment as Coolify set it is kept in memory so a save can be checked
against it (rule 7). The leads bot (Python) gets the result through
`...process.env` in its `spawn`.

## Getting back — rollback

- **On the page:** Versions → Restore saves an older version again as the
  newest (history is never rewritten) and restarts.
- **When the app will not start** (so the page is unreachable): in Coolify set
  `APP_SECRETS_VERSION=<an earlier number>` and redeploy — that version is loaded
  instead of the newest — or `APP_SECRETS_OFF=true` to use only Coolify's
  values. Remove the switch once the page is reachable again.
- There is no automatic rollback after failed starts: the explicit switches
  are predictable, and a crash loop is already bounded by Docker.

## The trap: the stored Samsara API key

The Samsara API key saved in Settings → Samsara (`samsara_settings`) was, until
now, encrypted under the key derived from `DATABASE_URL`, because neither
service had `INTEGRATION_SECRET_KEY`. Giving both services that key would make
it unreadable to both, and a new database password would make that permanent.
So on the first boot that has `INTEGRATION_SECRET_KEY`, this app re-encrypts it
(`database/samsaraSettings.js` `moveApiKeyToExplicitKey`): only when the stored
fingerprint is the `DATABASE_URL`-derived one, once, and never logging the key.
Until it has run, the Samsara service falls back to `SAMSARA_API_KEY`.

## Rollout order (owner, November 2026)

1. This PR (bot-backend) merged and deployed — nothing changes yet.
2. The Samsara service learns to read the same table (its own PR).
3. The owner creates `INTEGRATION_SECRET_KEY` (a long random value) and adds it
   to BOTH apps in Coolify; both redeploy. This app moves the Samsara key (above).
4. The owner uploads each app's current `.env` on the page and checks both work.
5. New tokens for every bot from BotFather, entered on the page (the getMe check
   shows which bot each is). The external copy stops working.
6. A new database password in Supabase; `DATABASE_URL` updated in Coolify for
   both apps.
7. Everything else deleted from Coolify.

## Code

| Module | Job |
|---|---|
| `database/migrations/0091_app_secrets.sql` | `app_secret_versions`, `app_secret_values` |
| `lib/appSecrets/envFile.js` | read a `.env` text (pure; never a value in a problem) |
| `lib/appSecrets/rules.js` | host-only names, scopes, upload plan, save checks (pure) |
| `config/appSecretsBoot.js`, `config/appSecretsFetch.js` | the boot read |
| `database/appSecrets.js` | versions and rows |
| `services/appSecrets/secretsService.js` | view, preview, save, remove, restore |
| `services/appSecrets/telegramTokenCheck.js` | `getMe`, token kept out of any error |
| `server/routes/settings/appSecretsRoutes.js` | `/api/settings/app-secrets*`, super admins only |
| `admin/src/pages/settings/secrets/*` | the page |

## Tests

`appSecretsEnvFile`, `appSecretsRules`, `appSecretsBoot`, `appSecretsService`,
`appSecretsRoutes` (Node, no database) and `appSecretsPg` (migration, a saved
version is what each service's boot read loads, restore, the Samsara key move);
admin `SecretsTab.test.jsx`.
