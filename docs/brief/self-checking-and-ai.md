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
  permission, default deny** (`operational_check_settings`, seeded with no rows,
  because "may close home-time cycles" and "may change a driver's status" are
  different decisions); **dry run** unless `apply: true`; and a **per-check cap**
  — a check wanting more than its cap changes *nothing* and files a `serious`
  finding about itself, since wanting to change hundreds of rows usually means
  the check is broken, not the fleet. **The cap is decided by a `COUNT`, never by
  the size of a fetched page**: a `LIMIT` can only ever say "at least this many",
  so at the top of the range (cap 500, 501 eligible) measuring a truncated page
  read as compliant and would have applied 500 corrections instead of refusing.
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
### AI routing and governance (Admin → Settings → AI)

- **AI is an accelerator, never a dependency.** Twelve consumers already degrade
  to deterministic logic. The master switch being OFF is a supported, tested
  mode — the whole suite passes with every provider disabled — which is the
  enforceable form of that rule.
- **`services/ai/` is ~500 lines and adds ZERO runtime dependencies.** Every
  mechanism either already existed in `groqClient` (model chains, retry-after
  parsing, capped waits, abort timeouts) or is a timestamp comparison. ModelMix
  and ai-fallback were read for their proven shapes; neither is installed.
- **`lib/ai/classify.js` fixes a live defect.** `groqClient.isAuthOrConfigError`
  treats 401/403 as fatal and **aborts the whole chain** — defensible with one
  provider, plainly wrong with several, where it turns one expired credential
  into a total AI outage. Four classes, and the order they are tested in is the
  argument: quota language is checked BEFORE the transient status set, because a
  spent free tier arrives as a 429 and 429 is in that set. A 400/404/422 is OUR
  request being wrong, so it moves on **without cooling anyone** — one stale
  model name must not disable a working provider.
- **`lib/ai/cooldown.js` is the circuit breaker, and it is a timestamp.** A
  rejected credential cools *indefinitely* — a sentinel, not a long timer, since
  no elapsed time makes an expired key work — and clears the moment an
  administrator saves a new one.
- **Two adapters cover everything.** `openai_chat` serves Groq, Cerebras,
  Mistral, OpenRouter and Together, so adding one is a `base_url` and a key in a
  row. Gemini keeps its own adapter and **gains the timeout it has never had**:
  the existing client passes no signal, so a hung connection hangs the caller
  forever, reachable from interactive paths.
- **Adding a known provider is: pick it, paste the key, Connect.**
  `lib/ai/providerCatalog.js` (pure) holds what is public about eight providers
  — Groq, Gemini, OpenRouter, Cerebras, Mistral, Together, DeepSeek, NVIDIA —
  adapter, endpoint, models path, env-var name, key prefix, free-tier note and
  the official terms/privacy/pricing/deprecation pages. `POST
  /api/settings/ai/providers/connect` (`services/ai/discovery/connectProvider.js`)
  reads the provider's own `/models` listing (`modelDiscovery.js`; OpenAI shape
  and Gemini's paged shape), keeps what can chat (`lib/ai/modelSelection.js`
  refuses embeddings, speech, moderation and image models by name and, for
  Gemini, by `supportedGenerationMethods`), chooses a chain — strongest family
  first, always ending in a small fast model — honours free-only mode, proves the
  key with ONE 8-token call, saves the provider **enabled** at the next priority,
  records the listing in `ai_providers.discovered_models`, writes a `selected`
  row to `ai_model_events`, and seeds the terms watcher with the catalogue's
  official pages (`source_origin = 'catalog'`). Then it says what happened in
  words: *"OpenRouter connected successfully. 14 compatible models found. 6 free
  models currently available. Wenze selected 3 preferred models for fallback."*
  A failure names the step — `invalid_key` (with a hint when the key clearly
  belongs to another provider), `no_free_models`, `no_compatible_models`,
  `no_models_endpoint`, `models_refused` — never "could not tell what went
  wrong". **Base URL and the model list moved under Advanced settings** on the
  provider card; only the **Custom OpenAI-compatible** entry asks for a Base URL,
  and even it discovers its models. Free status is reported only where it is a
  published fact (OpenRouter pricing, Groq/Cerebras/NVIDIA free tiers, Gemini
  Flash); elsewhere it is `unknown`, said plainly. Migration 0023.
- **The chain is kept current, not remembered.** "Refresh models" on the card
  (and, from Phase 3-C, a scheduled job) re-reads the listing through
  `services/ai/discovery/refreshModels.js` and `reconcileChain`: a configured
  model the provider no longer lists is **retired** from the active chain and
  recorded; the operator's order survives for what still exists; Wenze's picks
  fill the chain back up. **An empty or failed listing changes nothing** — one bad
  fetch must never strip a working chain — and the failure is shown on the card
  as "last check failed: …". Every change is an `ai_model_events` row
  (`added` / `retired` / `replaced` / `restored` / `refused` / `selected`, with
  its initiator), rendered on the tab as "Model changes".
- **A retired model is noticed by Wenze, not by the next failing call.**
  `services/ai/discovery/modelMaintenance.js` re-reads every enabled provider's
  listing **daily at 06:00 UTC**, and `lib/ai/classify.js` now has a `MODEL`
  kind — "decommissioned", `model_not_found`, "is not found for API version" on a
  400/404/422 — which the router treats as *skip this model, keep the provider*
  (never a cooldown) and reports through `setModelRefusalListener`; the job
  verifies that provider against its listing after a 5-minute debounce, so a
  burst of 404s is one look. **The router changes no chain**: a 404 is a claim,
  the listing is the evidence. A retirement is filed as a policy finding
  (`discontinuation`, `info` when a replacement exists, `serious` when the chain
  is empty) and rides the same Telegram outbox, in words — *"Groq retired one of
  Wenze's models (X). Wenze automatically switched to Y. No Wenze features were
  interrupted."* A failed or empty listing retires nothing. **The notice is
  driven by the event, not the refresh** (migration 0024,
  `ai_model_events.notified_at`): a `retired` row nobody has been told about is
  the job's work list, stamped only after the finding and the alert are written,
  so a write that fails is retried next pass rather than lost. **A caller's
  `preferModels` are covered too**: the router drops a preferred model the
  provider's own listing no longer has (`discoveredModelIds`; an empty listing
  changes nothing), and a refusal carries the model name so the verification can
  retire it with a `capability_preference` event. Only a replacement actually in
  the chain is ever claimed as one.
- **`enabled` and `cooled_until` are never written by the same code.** `enabled`
  is a person's decision; the cooldown is the system's temporary opinion. The
  router writes only the latter.
- **`/test` proves the CANDIDATE key from the request body**, not the stored
  one, so a typo never becomes a silently dead provider. A rejected key answers
  200 with `ok:false` and a failure *class* — "the key is wrong" and "the free
  tier is spent" look identical in a raw error string.
- **AMBIGUITY MEANS NO CHANGE.** `status_source = 'ai'` is on 168 of 209 groups:
  a model reads a Telegram chat TITLE and the answer is written to
  `driver_profiles.status` and `groups.active`. The system prompt used to say
  *"If unsure, set active to false"*, and `row.active === true` collapsed
  "false", "unsure" and an omitted field into one answer — so an unreadable
  title could mark a working driver terminated. The classifier now has a third
  answer (`null`), and the two writers coerced it in **opposite** directions:
  `!!null` was `false` and `active === false ? 'inactive' : 'active'` made null
  mean *active*, so one ambiguous answer could terminate one driver and
  reinstate another in the same run. Both now leave the status alone and count
  it. The deterministic fallback follows the same rule: a status marker in a
  title IS evidence somebody left; its absence is not evidence they are still
  here.
- **A gap in a model's answer is recorded as a gap.** The annotator filled
  messages the model never mentioned with `intent: 'no_signal'`, `role:
  'unknown'`, confidence 0 — indistinguishable downstream from an annotation it
  actually produced. `intent` and `role_guess` are nullable and now stay NULL,
  which is also better arithmetic: the role-consensus query's `MODE() WITHIN
  GROUP` ignores NULLs, so an unanswered message no longer casts an 'unknown'
  vote against real ones, and `AVG(role_confidence)` no longer averages in zeros
  for messages nothing ever judged. An **explicit** `no_signal` is a real answer
  and is kept. Both sides of the anomaly comparison exclude unannotated
  messages: `computeSenderStats` mapped a NULL to `no_signal` while the baseline
  query's SQL grouping stored the same NULL under the key `"null"`, so identical
  behaviour scored a maximal Jensen-Shannon divergence and produced **false
  anomaly cards** — a change made to stop fabricating, fabricating somewhere
  else. A current window with nothing annotated is skipped rather than compared,
  since an empty distribution scores 0.5 against a real one and would turn "the
  annotator was down" into a card about the driver.
- Schema hard lines: a cooldown without a reason is refused, and
  `ai_capabilities.may_auto_apply` is `CHECK`ed to FALSE — AI may rank and
  explain a finding, never author or apply a correction. The call log holds **no
  prompts, no completions, no PII**.
- **Every AI call in the application goes through the router** (Stage 5c).
  `callGroqWithFallback`, `callGeminiText`, `callGeminiJson` and
  `callGeminiGenerateContent` kept their signatures and their
  `attemptErrors[]` / `allRateLimited` failure shape, so none of the ~22 call
  sites changed — but the transport, the key and the model chain moved under
  them. Two consequences worth stating:
  - **What a caller names is a PREFERENCE about MODELS, and nothing about
    providers.** A caller asking for a fast model on an interactive path made a
    latency decision on purpose, so its models lead *its own provider's* chain;
    every other provider uses the chain configured in the admin. A caller that
    names nothing gets the admin's chain — passing the clients' env defaults
    instead would put four hardcoded model names in front of the Settings → AI
    list on every call, and that list would never be reached.
    **The caller does not reorder the roster.** An earlier version let the
    preferred provider jump the queue, and since every legacy call site prefers
    Groq, that made the `priority` column decorative and `round_robin` inert:
    Groq's free allowance would have been burned first on every call regardless
    of what an operator configured. Provider order is the admin's decision.
  - **An OpenAI-shaped `messages` prompt is flattened for Gemini**, because two
    call sites pass `''` as the prompt text and put the whole document in
    `messages`. Without that, a Gemini provider received an EMPTY prompt — and a
    model asked nothing still returns well-formed JSON, which both of those sites
    validate for shape rather than truth. A guessed pickup address arriving as an
    extracted fact is worse than any failure.
  - **A Gemini-shaped request is only offered to a Gemini provider.** The
    home-time screenshot import sends images; an OpenAI-compatible provider
    would accept the text half and answer confidently about a screenshot it
    never saw. The roster is filtered, never the request quietly reshaped.
- **Both clients are now façades that own no transport.** The direct fetch
  loops, their per-model retry and their backoff sleeps were **deleted**, not
  left beside the router: two live paths to one API is how the two stop
  agreeing, and the one no longer exercised is the one that rots. What stays is
  the vocabulary their call sites use — the env model chains, the rate-limit and
  auth predicates, Gemini's JSON helpers.
- **No consumer asks the ENVIRONMENT whether AI exists any more.** Nine gates
  in seven files read `GROQ_API_KEY` / `GEMINI_API_KEY` as module-level
  constants — correct while the environment was the only place a key could live,
  and wrong in both directions once it was not: an operator who moved a key into
  Admin → Settings → AI and cleared the env var lost those features **silently**,
  and one who turned the master switch off still read "configured" and got a
  provider error instead of a clean "AI is not configured". A destructured
  constant cannot be made dynamic — a getter on `module.exports` is snapshotted
  by the import — so each gate moved to `registry.isAiAvailable()`, answered from
  the 30-second roster cache. `tests/consumerAiGates.test.js` strips comments and
  greps those seven files, because a new gate would pass every other test: the
  env var is set in production.
- **The hand-coded "try Groq, then Gemini" second legs are gone**, in five files.
  They were cross-provider fallback the router now owns, and each carried an
  `isAuthOrConfigError` abort that ended the chain on a dead key rather than
  moving to the next provider. `annotateChatLogs` stops on `err.aiUnavailable` —
  the router saying every provider was unusable — instead of sniffing an auth
  message out of a joined error string. The background annotator now starts
  unconditionally and asks per tick, so enabling AI in the admin no longer needs
  a restart.
- **"Answered, but unusable" is a `validateResult`, not a second leg.** Those
  legs also fired on a case transport failure does not cover: a provider
  returning HTTP 200 with an empty or truncated body. The router records that as
  a SUCCESS and stops looking, so the consumer's parser rejects the text and the
  feature drops to its canned fallback with another provider left unasked.
  `groupStatusAiClassifier`, `datatruckBanterMessage` and `employeeBirthdayMessage`
  each hand the router a validator that IS their parser — one function, so the
  floor the router enforces cannot drift from the floor the output must clear.
  `groqClient` forwards it as `validate`, and the router treats a failed verdict
  exactly like a provider failure and continues down the chain.
- **Migration 0021 seeds the roster, and it is the riskiest three lines in
  Stage 5.** 0019 seeded nothing, which was right while the router had no
  consumers; once the clients became wrappers, an empty `ai_providers` stopped
  meaning "unchanged" and started meaning "every AI call fails" — safely, into
  the deterministic fallbacks, and completely. So 0021 writes down the two
  providers already in use with **NULL keys** (still inheriting `GROQ_API_KEY` /
  `GEMINI_API_KEY`) and `ON CONFLICT DO NOTHING`, so an operator's stored key,
  disable or priority survives a redeploy.
- Guarded by `tests/ai{Classify,Cooldown,Router,SettingsRoutes,GovernancePg,OffDegradation}.test.js`
  plus `tests/{groqClient,geminiClientRouting}.test.js`. `aiOffDegradation`
  is the enforceable form of "deterministic logic must not depend on AI": with
  the roster empty AND with the master switch off, no provider is contacted at
  all and the deterministic paths still answer.

### AI provider terms watcher (Admin → Settings → AI)

- **Why**: Wenze sends operational data to free AI tiers, and the terms of those
  tiers are a deal that can change without anyone noticing. Nobody reads six
  providers' terms twice a week, so the first sign would be a feature failing or
  a policy already broken for months.
- **It must not become an AI workload**, and the pipeline order is the cost
  model: conditional GET → **304 ends it, free** → normalise → hash → unchanged
  ends it → line diff → immaterial ends it → **only then** one model call, on
  the changed passages **alone**, never the document.
- **Normalisation** (`lib/ai/policyText.js`) strips only what cannot carry
  meaning — a copyright year, a "Last updated" line, a build hash, a CSRF token,
  nav and cookie chrome. Any of that surviving into the hash means the watcher
  alerts on every check, and an alert that fires every time is one nobody reads.
- **Materiality** (`lib/ai/policyDiff.js`) asks *where* as well as *how much*.
  One sentence under "we may use your submissions to train our models" outranks
  four paragraphs of reworded support boilerplate; a size-only rule gets that
  backwards, and a test pins that the important case is *under* the size
  threshold.
- **The first sight of a page is a baseline, never an alert** — otherwise
  switching the watcher on fires once per provider on day one.
- **Only an enumerated deterministic rule may suspend a provider**
  (`lib/ai/policySuspension.js`). Four triggers, each requiring BOTH a topic
  match AND the provider's own trigger phrasing. `evaluateSuspension` has no
  parameter through which a model verdict could arrive, a test asserts its exact
  parameter list, and the schema refuses to record a suspension without naming
  its rule. A suspension is a **cooldown with a reason**, announced with the
  quoted passage and the source URL, reversible in one click — never
  `enabled = false`.
- **AI failure never costs the finding**: with every provider down or cooled the
  finding is still written from the deterministic evidence, marked
  `ai_assisted = false`. A watcher that goes silent when the AI layer is
  unhealthy is worst exactly when it is needed.
- **Alerts go through a durable outbox** with the shape
  `home_time_internal_alert_outbox` earned the hard way: attempts incremented at
  CLAIM time, bounded budget, and exhaustion **counted** and surfaced. The
  Telegram destination is validated on save by `services/telegramChatIdCheck.js`,
  so this cannot repeat the `5052301861` failure that started the project.
- Ships **disabled**, with automatic suspension a separate switch also off.
- Guarded by `tests/aiPolicy{Diff,Suspension,Watcher,Pg}.test.js`.
