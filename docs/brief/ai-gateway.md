<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4b. The AI routing layer, and what AI is allowed to decide

Split out of [§4a. The system checking itself](self-checking-and-ai.md) when
that document passed the 500-line limit. Same subject, one half of it: how an AI
call is routed, what each responsibility is allowed to touch, and the rule that
holds all of it together — **AI is an accelerator, never a dependency.**

The findings engine, tiered corrections and the audit trail that AI helps with
stay in §4a. The provider terms watcher is
[§4c](ai-terms-watcher.md).

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
  as "last check failed: …". **A legacy row is listed at the catalogue's URL**:
  Groq and Gemini were configured from environment keys before the catalogue
  existed, and Gemini's `base_url` was NULL because the call adapter carried its
  own default — so every daily pass asked `listModels` with no URL and failed
  the same way. `discoveryTargetFor` falls back to the catalogue entry for the
  row's own key (never for `custom`), and migration 0027 fills `catalog_key` and
  `base_url` on such rows so the admin shows them as what they are.
  Every change is an `ai_model_events` row
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
- **The terms watcher finds its own pages, follows them when they move, and
  searches when they vanish.** Nobody types a terms URL for a provider Wenze
  knows: every run starts by seeding each enabled catalogued provider with the
  catalogue's official pages (`source_origin = 'catalog'`; a kind a person added
  by hand is left alone). A fetch that lands on another address is a redirect —
  on the provider's own site the source is **moved** (`moved_from` kept, so it
  is reviewable), off the site it is only recorded. A 404/410 goes looking at
  once and any error does after three: `services/ai/policy/sourceDiscovery.js`
  tries the catalogue's URL, then scans the docs root and site root for links on
  the provider's **own domain** that look like the kind of page wanted
  (`lib/ai/policyLinks.js`, pure), verifying each by fetching it; only when more
  than one candidate verifies is the router asked to choose — with
  **`excludeProvider`** set to the provider under investigation, which must never
  be a dependency for investigating itself, and an answer naming a URL not among
  the candidates is ignored. Only after all of that fails is a person told, and
  told **once**: an operational finding (`ai.policy_source_lost`, Needs
  Attention), a policy finding and a Telegram line; found again clears it.
  Migration 0025. Watched topics now include **pricing, authentication and API
  behaviour changes**, so those diffs are material.
- **The destination can be a person, and can be tested.** `checkChatId` gains
  `allowPrivate` (opt-in; the home-time destinations still address a room, and
  the sign-flip check still runs first), and **Send a test message** on the card
  proves a candidate id before it is saved — the one-click answer to the dropped
  minus sign that started this project.
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
- **The one place AI speaks WITHOUT a deterministic answer underneath it** is
  the after-hours recruiting reply, and the protection is shaped differently
  because of it. There is no fixed sentence that answers "does the truck have an
  APU", so a better fallback was not available. Instead the model is gated on
  both ends: it may only speak from statements an administrator typed *and
  confirmed* (`recruiting_knowledge`), and `lib/recruiting/replyGuard.js`
  refuses the whole reply afterwards if it contains a figure no approved
  statement contains, or if it guarantees, promises, approves, waives, hires, or
  sets a start date. **Refused whole, never edited** — a sentence with its
  invented rate quietly removed is how a wrong claim survives review. The
  candidate then gets one fixed line that states no figures at all. The guard is
  pure and has no model in it, so the rule governing a model is not itself
  decided by one. `docs/architecture/recruiting-after-hours.md`.
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

Moved to **[§4c. The AI provider terms watcher](ai-terms-watcher.md)** — the
conditional-GET pipeline, the deterministic suspension rules and the alert
outbox. Same document, split when this one passed the 500-line limit.
