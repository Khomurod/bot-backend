<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4c. The AI provider terms watcher

Twice a week Wenze re-reads the terms of every AI provider it uses and notices
when the deal changes. Split out of §4a when that document passed the 500-line
limit: the watcher is a self-contained feature with its own tables, its own
schedule and its own hard rule — only a deterministic trigger may pause a
provider, never a model's opinion.

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
