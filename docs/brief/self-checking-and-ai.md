<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4a. The system checking itself, and the AI that helps

Split out of §4 when it outgrew the 500-line limit. These four areas are one
subject: **Wenze noticing when its own facts disagree, correcting what it can
prove, and using AI as a governed accelerator that nothing depends on.** They
share a rule — *never invent a fact* — and they share their machinery: findings,
tiers, an audit trail, and a deterministic path that survives every provider
being switched off.

Home-time's own cycle invariant stays in [§4 features](features.md) beside the
feature it belongs to.

### Operational consistency (Needs Attention)

- **The system checks its own facts against each other and files a *finding* when
  they disagree.** `services/operations/consistencyService.js` sweeps every 15
  minutes: it reads ONE snapshot, runs every pure check in
  `services/operations/checks/*.js` over it, and upserts into
  `operational_findings`. All the judgement is in the pure functions; the service
  only does I/O.
- **`operational_findings` generalises `duplicate_unit_reports`**, whose upsert /
  first-seen / auto-resolve shape had been doing this job for one check family
  since the Route Control work. Migration 0016 carries its rows across **with
  their open/resolved state and original `first_seen_at`**, so the fleet's
  existing detection history is not reset. The old table and its service are
  untouched and still running.
- Three lifecycle rules keep the page trustworthy, and each exists to stop a
  specific failure: a recurring condition **updates one row** (46 drivers past
  their road allowance must not file 46 new rows every sweep); a finding a human
  **dismissed with a reason stays dismissed** even while the condition holds
  (re-opening it would overrule the only person who looked); and **auto-resolve
  is scoped to the checks that actually ran to completion**, so a failed check or
  a provider outage can never be mistaken for "the problem went away".
- A **dismissal without a reason is refused by the database**, not the route.
- **The watchdog covers the systems, not just Home Time and the chat/profile pair
  (Phase 3-F).** Two more pure modules run in the same sweep over the same
  snapshot: `checks/identityLayer.js` compares the person layer with the chats
  and profiles beside it — `identity.group_without_person` (**auto**: the
  resolver itself runs from the sweep, so a driver nobody has texted since the
  layer arrived is still placed), `identity.stale_unit_assignment` (**auto**:
  the profile's truck is the record; the person's open unit is brought to it,
  only when nobody else holds it), `identity.person_on_two_active_groups` and
  `identity.unit_contested` (a human decides). `checks/systems.js` reads across
  features: `samsara.vehicle_on_two_active_groups`, `samsara.vehicle_link_disagrees`,
  `fuel.watch_on_inactive_group`, `dispatch.team_driver_on_inactive_group`
  (**approval**, proposing the driver's current chat from the person layer),
  `raise.progress_without_person` (one aggregated finding) and
  `route_control.assignment_on_inactive_group`. The two auto actions live in
  `corrections/identityActions.js`, re-derive under lock, refuse when stale, and
  revert without deleting (a created person row stays; a previous truck is
  reopened as a new row). Both ship **disabled** like every other check. Guarded
  by `tests/operationsChecksLayer.test.js` and `tests/identityActionsPg.test.js`,
  which also proves the loop places a quiet driver by itself once enabled.
- `home_time.closable_open_cycle` is the high-value one: `classifyOpenCycles`
  sorts every open cycle into evidence **class A** (the group is on the road
  since after this cycle's `home_arrived_at` — `driver_home_status.state_since`
  IS the observed return), **class B** (a later cycle exists, and a `road→home`
  insert can only happen from the road state, so that row's `road_started_at` is
  this return seen from the other side), **class C** (genuinely still home —
  correctly open) or **N**. Only A and B propose a change, and the proposal
  deliberately omits `bonus_usd`, so the repair is payout-neutral. The same
  function will drive the Stage-6 repair batch, so findings and repair agree by
  construction.
- Guarded by `tests/operationsChecks.test.js` and
  `tests/operationalFindingsPg.test.js`.

**Corrections — where the system is allowed to change fleet data.**

- Every action in `services/operations/corrections/actions.js` declares **both
  `apply` and `revert`**. That pairing is the entry requirement: a correction
  whose reversal was never written is one nobody can safely enable.
- Two rules bound what may live in the registry. **The value must already be
  recorded somewhere else** — every action copies a fact the database already
  holds, never an inference. And **nothing is destructive**: every action is an
  UPDATE of a nullable column whose previous value is captured in full. The
  `home_time.ghost_home_status` finding deliberately has **no** action, because
  retiring that row would destroy the only record of where a driver was.
- Each `apply` locks its target **and its evidence** `FOR UPDATE` and
  **re-derives the answer inside the transaction** rather than trusting the
  payload the sweep computed. A finding can be hours old, and the dangerous edit
  is not "someone closed the cycle first" — that one is easy to spot — but
  someone moving the rows the proposal was *measured from*. So
  `home_time.close_cycle` locks every cycle of the group (class-B evidence lives
  in a sibling row) plus the group's `driver_home_status`, re-runs
  `classifyOpenCycles` over them, and writes only if the class is still A or B,
  the return moment is unmoved and the duration still comes out the same.
  Anything else raises `StaleCorrectionError` and the batch skips it. Being
  second to a person is a success, not an error.
  `identity.sync_profile_status` re-confirms `groups.status_source` is still
  `'bot'`, **holding that row `FOR UPDATE`** — it is the evidence, and reading it
  unlocked would let someone take ownership in the window before the commit and
  be overruled anyway.
- **Closing a cycle also resolves `linked_request_id`**, the same ±3-day lookup
  the live `closeHomeStayOnReturn` path does, and for the same reason:
  `homeTimeEfficiencyService.classifyCycle` reads `linked_request_status`, so a
  cycle closed without it files an over-policy stay a human **approved** as
  `non_compliant`. One deliberate difference — the repair requires the match to
  be *unambiguous*. Two decided requests inside the window is a judgement about
  which one authorized the stay, and the registry's own rule says a judgement
  call is not its to make: it stands down and leaves the cycle for a person.
- One transaction does all of it: run the action, write `operational_corrections`
  with the complete before/after images, **mirror into `admin_audit_log` via
  `insertAdminAudit(entry, client)`** — the same transaction, which is what that
  function's `client` argument exists for, and which brings its recursive secret
  redactor along — and mark the finding `applied`. **Revert is the same path in
  reverse**, is itself audited, stamps the original row rather than deleting it,
  and re-opens the finding.
- **The timer applies what the admin permitted.** `runGuardedSweep` runs
  `runAutoCorrections({ apply: true })` right after a real sweep files its
  findings — inside the same guard, because corrections change the rows the next
  sweep reads. Until this was wired, the function was reachable only from the
  admin's dry-run preview and `scripts/operations-preview.js`, so a check an
  operator had switched on still corrected nothing until someone ran a command by
  hand. A dry-run sweep never corrects; a correction failure is recorded in
  `getConsistencyStatus().lastCorrections` and returned, never thrown, so the
  findings summary survives it. The Findings card shows "Auto-applied N of M".
- Three guardrails on auto-apply (`corrections/autoApply.js`): **per-check
  permission, default deny** (`operational_check_settings`, seeded with no rows
  by the schema, because "may close home-time cycles" and "may change a driver's
  status" are different decisions); **dry run** unless `apply: true`; and a **per-check cap**
  — a check wanting more than its cap changes *nothing* and files a `serious`
  finding about itself, since wanting to change hundreds of rows usually means
  the check is broken, not the fleet. **The cap is decided by a `COUNT`, never by
  the size of a fetched page**: a `LIMIT` can only ever say "at least this many",
  so at the top of the range (cap 500, 501 eligible) measuring a truncated page
  read as compliant and would have applied 500 corrections instead of refusing.
- **Three checks are switched on by migration 0027, at the owner's instruction**
  (2026-09-10): `identity.group_without_person` and
  `identity.stale_unit_assignment` (cap 150 each — the ~100 driver groups with
  no permanent identity and no recorded truck), and
  `home_time.closable_open_cycle` (cap **exactly 65**, the number measured
  against production: 38 class A + 27 class B). This session had no path to
  production but the application itself, so the seed row *is* the person's
  switch, written once with the reason in `updated_by`. It is still theirs:
  the seed is `ON CONFLICT DO NOTHING`, so switching a check off in Needs
  Attention → Automation sticks across every boot, and a fleet that no longer
  matches the measurement stops the batch (nothing applied, a serious finding)
  rather than widening it. `tests/productionRepairSeedPg.test.js`.
  **What production then showed** (first pass after deploy, on `/api/health`):
  two of the three rows already existed — a person had switched
  `home_time.closable_open_cycle` and `identity.stale_unit_assignment` on
  earlier at the schema default of 50, which 0027 rightly left alone — and the
  pass read `wanted 65, cap 50` and `wanted 100, cap 50`: both applied nothing.
  Both counts are exactly the measurements, so **migration 0028** lifts the cap
  on those two rows to exactly 65 and exactly 100 — only where the row is
  already enabled, carries the default 50, AND was last saved before the
  instruction existed (2026-09-10 19:00 UTC): the Automation tab submits the
  displayed cap on every toggle, so a 50 can be a decision, and only the time
  tells a cap saved before the measurement from one chosen after it. A cap a
  person typed, a 50 saved after the cutoff, a disabled check, or a missing row
  is not touched.
  `tests/measuredCapsMigrationPg.test.js`.
- **The result is readable from `/api/health` with no database and no admin
  session** — the `operations` block (`services/operations/healthSummary.js`,
  60-second cache): the last sweep and the last background correction pass
  (applied / stale / failed, and each capped check with `wanted` and `cap`), open findings by severity, identity
  coverage (`groupsWithoutPerson`, `openUnits`, unstamped rows), Home Time
  (`groupsWithDuplicateOpenStays`, `openStayIndex` present/absent) and each AI
  provider's listing state (named by catalogue key only — `provider_key` is
  operator-typed text and once held a pasted secret; anything not in the
  catalogue reads `custom` — with `discovered`, `refreshedAt`, and `refreshError` as
  `{ status, kind }` — the kind from `lib/ai/classify.js`'s closed vocabulary
  plus `not_configured`; the provider's own error TEXT never leaves, because a
  body can echo a key in any spelling and the endpoint is public). **Counts and timestamps only** — no driver, chat, key or finding
  title — and it can never make the endpoint unhealthy: a summary that throws
  reads `available: false` at status 200. `tests/healthOperationsBlock.test.js`.
- **An administrator can see and control what AI is allowed to decide.**
  Settings → AI → **AI Responsibilities** lists every decision Wenze uses a
  model for, in plain words: what it decides, whether it can change stored
  information (and what it writes), whether the prompt carries driver message
  text, and — the part that makes a switch judgeable — what Wenze does instead
  with AI off. The list is `lib/ai/capabilityCatalog.js` (pure); the review
  behind it is `docs/architecture/ai-decisions.md`.
- **The switch is real now.** `ai_capabilities` had existed since the AI
  governance work with NOTHING writing a row or reading one back: the admin
  table rendered nothing, and had it rendered, its checkbox would have changed
  nothing. `services/ai/capabilityRegistry.js` registers the catalogue on boot
  (descriptive columns only — it never touches the operator's `ai_enabled`), and
  `services/ai/router.js` refuses a switched-off capability before any provider
  is asked. Gating in the router rather than at sixteen call sites means a
  refused capability raises the same error as a provider outage, which is the
  path every consumer already falls back through. A capability with no row is
  ENABLED, so a newly added one is never silently off.
- **Two switches, deliberately.** "May a model be asked about this" and "may the
  answer be applied without a person" are different questions. Detect Driver
  Returned to Road runs its AI analysis under the first and its automatic state
  change under the second (`operational_check_settings`), and the
  Responsibilities card carries both switches side by side. The automatic one
  writes the SAME `operational_check_settings` row that Operations → Needs
  attention → Automation writes — one owner for the setting, two places that can
  reach it, so the two screens cannot disagree about what the software may do.
  Analysis on with automatic changes off is a sensible way to run a fleet, and
  it only works if turning one off leaves the other alone —
  `admin/src/pages/settings/ai/ResponsibilitiesCard.test.jsx` asserts exactly
  that in both directions.
- **The switch covers every routed call, and a scanner keeps it that way.**
  `services/ai/router.js` can only refuse a call that carries a capability, so
  an untagged one skips the gate and keeps reaching the provider — the
  responsibility reads "off" and the prompts continue. Four call sites were
  exactly that, including the SECOND of two calls in a file whose first call was
  tagged, which is the shape a per-file review misses.
  `tests/aiCapabilityCoverage.test.js` scans `services/`, `server/` and `lib/`
  for every `callGeminiText` / `callGeminiJson` / `callGroqWithFallback` and
  fails if one names no capability, or names one the catalogue omits.
- **An unreadable automation setting is reported as unknown, never as off.**
  Settings → AI is presented as the authoritative control for whether Wenze may
  change a record, so swallowing a failed read into "all switches off" would
  show the reassuring answer while corrections kept being applied. The switch is
  disabled, labelled unknown, and the reason is shown. A check merely ABSENT
  from a list that WAS read is genuinely off — default-deny is the engine's rule.
- **The capability cache is cleared after the write, not before.** Clearing
  first leaves a window in which a concurrent call reloads the old value and
  caches it for another 30 seconds; a failed save clears nothing at all.
- **Every operational AI call now says which decision it served.** `capability`
  reached the router from two of about twenty-four call sites, and
  `callGeminiText` dropped the field entirely, so the activity history was a
  list of unnamed calls. Every operational call site is tagged, the drop is
  fixed, and the admin's failure list leads with the responsibility rather than
  the provider — a failure is only actionable once you know which feature
  stopped.
- **A model reading a chat title can no longer deactivate a working driver.**
  `groups.active` is written from that title twice a day for most of the fleet,
  and an inactive group drops out of Live Locations, document routing, the
  dispatch roster and home-time tracking. A deactivation is now refused when the
  records show the driver working — a recent message, home-time tracking having
  seen them, an open cycle, a recent road leg, a truck assigned
  (`lib/drivers/deactivationGuard.js`). Turning a driver back ON is never
  blocked: that is the safe direction. Silence is deliberately NOT protected —
  a departed driver goes quiet, and `identity.silent_active_group` already
  raises the merely quiet ones for a person.
- The database is the backstop, not just the code:
  `operational_corrections_system_is_auto_only` refuses a system-applied
  correction at any tier but `auto`, and a reversal without an attributed actor
  is refused outright.
- **The page is `admin/src/pages/OperationsPage.jsx`** + `pages/operations/*`
  (hook, pure labels, list card, detail drawer, History and Automation tabs),
  served by `/api/operations`. Three tabs in the order the work happens: what is
  wrong, what has been done about it, and what the system may do by itself —
  automation last, deliberately, because a page that opens on its switches
  invites turning things on before reading what they would do.
  - **Findings are grouped by check.** Forty-six drivers past their road
    allowance is ONE thing to think about; forty-six flat rows is a page nobody
    opens twice.
  - **The drawer leads with evidence, not with a button.** What we think is
    wrong, *why* we think so (the exact recorded values), what would change as
    explicit `field: now → would become` rows, and only then the actions.
  - **A quiet page says why it is quiet.** The summary carries sweep state,
    because "nothing needs attention" and "the sweep stopped three days ago"
    look identical and mean opposite things. Severity tiles render at zero
    rather than vanishing, for the same reason the VideoRecoveryCard's do.
  - **A failed refresh keeps the last good data and puts a banner over it** —
    never a reassuring empty list, which is the exact failure mode
    `server/middleware/failureResponse.js` exists to remove.
  - The History tab is the **first reader `admin_audit_log` has ever had**. A
    reverted correction is shown struck through, not removed.
  - Guarded by `admin/src/pages/operations/{labels,OperationsPage}.test.jsx`.

### AI routing, governance and the terms watcher

Moved to **[§4b. The AI routing layer](ai-gateway.md)** — the provider roster,
per-responsibility switches, the reply guard, the call log and the failure
classification — and **[§4c. The AI provider terms watcher](ai-terms-watcher.md)**.
Same document, split when this one passed the 500-line limit.
