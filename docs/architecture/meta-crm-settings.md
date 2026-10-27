# Settings → Facebook ↔ Bitrix: the Meta Conversions API for CRM credentials

The owner, 27 October 2026: enter, **test**, then save the credentials for
reporting Facebook leads' Bitrix hiring stages to Meta from the admin panel — no Coolify
environment variables. The pass that uses them is
`services/metaCrm/stageSync.js` (PR #316; see `docs/brief/recruiting.md`).

## What the page does

1. **Status.** ON/OFF; which dataset ID is in use and where it comes from
   (saved in the app / environment / not set); whether a token is set — its
   last four characters only, never the token; the last pass from the run
   ledger (`meta_crm_stage_sync`): when, events sent, failed, the last error.
2. **Enter** the dataset ID, paste the access token, optionally an Events
   Manager **test event code** (used by Test only, never saved).
3. **Test** runs four checks on the UNSAVED values, each pass / warning /
   fail / not run in plain words (`services/metaCrm/settingsTest.js`):
   - **a. Token and dataset** — two reads, nothing sent, the token in the
     `Authorization` header: `GET /me?fields=id` (Meta accepts the token), then
     `GET /dataset_quality?dataset_id=<id>` (the Dataset Quality API — the
     token can see this dataset). The verdict is
     `settingsRules.judgeTokenAndDataset`:

     | Meta's answer | Result |
     |---|---|
     | `/me` refused (190 …), timed out | **fail** |
     | dataset quality 200 | **pass** |
     | dataset quality code 24 (subcode 2044055) | **warning** — Meta says this both for an ID the token cannot see and for a dataset with no events in the last 48 h, so the two cannot be told apart, and a new dataset must still save |
     | dataset quality refused for a permission (10, 200–299, or 100 "Missing Permission") | **warning** — the token was generated without the "Dataset Quality API" option; it can still send |
     | dataset quality timed out, 5xx, rate-limited, other | **fail** |

     Anything that was not a plain yes shows Meta's code and words (token
     removed) beside the plain explanation.
   - **b. Test event** — only with a test event code, and only as an EXACT
     copy (same `event_id` `bitrix:<lead>:Qualified`, same `event_time`) of a
     Qualified event the sync sent **to the dataset being tested** in the last
     47 hours whose time is still inside Meta's seven days
     (`metaCrmEvents.latestRecentlySent`), sent with `test_event_code`. Meta
     deduplicates on `event_id` + `event_name` for about 48 hours **within one
     dataset**, so it counts once. The ledger records the dataset each event
     was accepted into (`meta_crm_events.dataset_id`, migration 0087, written
     by `markSent`); a row sent to another dataset, or before that column
     existed (NULL), is never copied — otherwise a Test of a new dataset ID
     would hand it a first, countable event (CodeRabbit, #318). With no such
     event: not run, and why. Without a code: not run, with where to get one.
   - **c. Bitrix** — connected, and pipeline 0 still has all six mapped stage
     ids (`EXECUTING`, `UC_PBR3LM`, `UC_DISPATCH`, `UC_SAFETY`, `WON`, `LOSE`);
     a missing one is named.
   - **d. Dry run** — `previewStageSync`: deals changed in seven days, how many
     are Facebook leads, the events a pass WOULD send per name (what the
     ledger already holds is left out) and up to five example rows. Reads the
     ledger; records nothing, sends nothing.
4. **Save** is disabled until a Test passed — check a passed or warned and
   nothing that ran failed — with exactly the values now in the form; any edit
   locks it again (`admin/src/pages/settings/metaCrm/testGate.js`). Saving switches the
   sync on.
5. **The switch** turns sending off without removing anything stored.
6. The pass reads the settings on every run (cached 15 s, the cache dropped on
   every write), so a save or the switch takes effect on the next pass — no
   restart, no redeploy.

## Invariants — do not undo

- **The server does not trust the browser.** `PUT /api/settings/meta-crm`
  re-runs check a on the values being saved and stores NOTHING it FAILS
  (`services/metaCrm/settingsService.js saveSettings`); a warning saves, by
  the same rule the panel uses. A disabled button is a convenience, not the
  guard. `tests/metaCrmSettingsService.test.js`.
- **Check a never reads the dataset object.** `GET /<dataset id>` answers
  "(#100) Missing Permission" to the Events Manager token even when it is
  exactly right (its only permission is `read_ads_dataset_quality` — learned
  with the owner's token, 27 October 2026); that is what made a correct token
  fail every Test before this rule.
- **A Test never sends anything Meta would count.** A test event code does
  NOT keep an event out of ads — Meta may use test events for targeting and
  measurement — and Meta refuses an event about a lead it does not know
  (subcode 2804036), so there is no harmless made-up event. The only send in
  the Test path is a duplicate of one Meta already received, carrying
  `test_event_code`; without a code, or without such an event, there is no
  send at all. A real pass never passes a code.
  `tests/metaCrmSettingsTest.test.js`, `tests/metaCrmStageSync.test.js`.
- **The token is a secret everywhere.** Encrypted at rest
  (`meta_crm_settings.token_encrypted`, `lib/security/facebookCrypto`); never
  returned by any GET (only `token_last4`); browser → server only in a
  request BODY; server → Meta in a body (sends) or the `Authorization` header
  (the two reads) — never a URL or query string; never logged; and every error text
  on its way to the panel, a log or the run ledger goes through
  `lib/security/redactSecret.js` with the token it was made with.
- **DB over env, NULL inherits.** `database/metaCrmSettings.js
  resolveMetaCrmConfig` is the one rule: a column never saved inherits
  `META_CRM_DATASET_ID` / `META_CRM_CAPI_TOKEN`, so the env-only setup from
  #316 keeps working untouched. `enabled` NULL is ON, because before this row
  the pass ran whenever both values were set. A stored token this server
  cannot decrypt counts as not stored — the env answers and the page says why.
- **A settings row that cannot be read is a failure, not "nothing saved".**
  Only a missing table (SQLSTATE `42P01`, migration 0086 not yet applied)
  falls back to the environment; any other read error is thrown, nothing is
  cached, and the pass is a failed run that sends nothing — otherwise a
  database blip would resolve to `enabled: true` with the environment's
  credentials and ignore an OFF switch saved here (CodeRabbit, #317).
  `tests/metaCrmSettingsResolve.test.js`, `tests/metaCrmStageSync.test.js`.
- **A save without a new token keeps the stored one** (and Test with the box
  empty tests the token in effect, and says so).
- **Switched off and missing values are `blocked`, never a failure**, and say
  which (`stageSync.blockedReason`). An unconfigured feature painted red is how
  a real outage gets lost (`docs/architecture/health-reporting.md`).
- **Test is rate-limited** — 10 per admin per 5 minutes
  (`server/middleware/rateLimit.js`): each one calls Meta and Bitrix.
- **Inputs:** dataset ID digits only (also a CHECK in the table); token
  non-empty with no whitespace; test code letters, digits, `_`, `-`.
- **A failed read of the page shows the failure and a retry**, never a form
  drawn from defaults.

## Where things are

| | |
|---|---|
| `database/migrations/0086_meta_crm_settings.sql` | the single row (`id = 1`), every value nullable |
| `database/metaCrmSettings.js` | resolution, the 15-second cache and its invalidation, save, the switch |
| `services/metaCrm/settingsRules.js` | pure: input rules, masking, Meta errors in plain words, check a's verdict, when a Test counts as passed |
| `services/metaCrm/settingsTest.js` | checks a–d |
| `services/metaCrm/settingsService.js` | the page's view (with the last run), Test, Save, the switch |
| `services/metaCrm/capiClient.js` | `sendEvents` (with `testEventCode`), `readTokenOwner` (`/me`), `readDatasetQuality` |
| `database/metaCrmEvents.js`, migration 0087 | the ledger, with the dataset each sent event went to; `latestRecentlySent` is what check b may duplicate |
| `server/routes/settings/metaCrmRoutes.js` | `GET /meta-crm`, `POST /meta-crm/test`, `PUT /meta-crm`, `PUT /meta-crm/enabled` under `/api/settings`, behind `admin.full_access` |
| `admin/src/pages/settings/MetaCrmTab.jsx`, `settings/metaCrm/` | the page |

## Tests

```
node --test tests/metaCrmSettingsResolve.test.js tests/metaCrmSettingsTest.test.js tests/metaCrmSettingsService.test.js tests/metaCrmSettingsRoutes.test.js tests/metaCrmStageSync.test.js
TEST_DATABASE_URL=… node --test tests/metaCrmSettingsPg.test.js tests/metaCrmEventsPg.test.js
npm test --prefix admin -- --run src/pages/settings/MetaCrmTab.test.jsx
```
