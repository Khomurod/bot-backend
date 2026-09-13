# What a health report must be able to say

Five production incidents, each of which ended with the same sentence: *the
system knew, and had no way to tell anybody.* Split out of
[`self-healing-and-learning.md`](self-healing-and-learning.md), which owns WHEN
a change of health is worth announcing; this file owns WHETHER the health being
reported is true in the first place.

Every rule here was written after a specific reading of production, and each
names the reading. None of them was found by a test — every one of them was
found by watching a number that should have moved, and did not.

## Switched off is not broken, and it took production to prove it

`needs_human_attention` covers two things that are not alike: **blocked on
configuration** and **failing past the point where recovery has had its chance**.
`runHealth.js` said from the start that the first "is NOT broken, and painting
it red is how a real outage gets lost among things that were never switched on."

One layer up, that was being lost. `healthObservations` collapsed every
actionable verdict into `ok: false`, `healthTransitions` wrote `failed`, and
`/api/health` reported production as `systems: { failed: 3, down: [the
Dispatcher Board, the weekly finance report, the finance document reader] }` —
three features nobody had switched on yet. Each was also three passes from
announcing itself to the operations chat as "not working / Needs a person;
Wenze has not been able to recover from this one", which is untrue twice over:
nothing is failing, and nothing is there to recover.

So the verdict carries `blocked`, `system_health_states.status` has a third
value (migration 0055), and the summary reports `blocked` and `waiting`
alongside `failed` and `down`. Three rules follow from it:

- **a blocked observation starts no failure count** and trips no flap window;
- **it is never announced.** Nothing broke, so there is nothing to say;
- **switching a failed component OFF is not a recovery.** The record of what
  readers were last told is cleared silently, because "working again" about
  something nobody switched back on would be a lie.

`actionable` is deliberately unchanged, so the workers block still lists a
blocked worker and still names the setting it is waiting for. The distinction
only matters where a component is reported as **working or not**.

## The nine custom integrations could not say it either

`blocked` was then hardcoded `false` for every CUSTOM integration — the nine
that are not driven by the run ledger: recruiter logins, AI providers, the
notification destination, retention's chat signals, after-hours recruiting, the
Samsara pipeline and the rest. Those are precisely the ones most likely to be
half-configured, and they were the only ones with no way to say so.

The result was one component answering two different things in the same
payload: `recruiting_after_hours` with nothing approved yet appeared in
`workers.attention` as needing a person AND was counted among `systems.ok` as a
working system. `samsara_safety_pipeline` was worse — the poller beats `blocked`
when Samsara is switched off in the admin, `classifyRun` computed that verdict
correctly, and `integration()` threw it away.

Each of those now reports `blocked`. A cooldown is deliberately NOT one: all
providers unreachable is a failure to reach, not a switch nobody flipped.

## And it could not see three of the things it watches

The same production reading that found the defect above did not clear after it
was fixed — `retention_chat_signals` still never reached `systems.waiting`. The
reason was a second, independent defect underneath it.

`gatherAllObservations(deps)` uses the dependencies it is handed, **verbatim**;
it does not merge in its own defaults. `selfHealing.defaultDeps()` was a second,
hand-written list that had drifted six keys behind
`healthObservations.defaultDeps()` — missing `capabilityGate`,
`notificationSettings`, `recruitingHours`, `recruitingKnowledge`, `retention`
and `smsMirrors`.

Nothing crashed. Each affected check threw, its own `catch` turned that into
`{ state: UNKNOWN, reason: 'could not read' }`, and the unknown filter then
dropped it — correctly, because "I could not check" must never start a failure
count. So the components simply **vanished** from this watch: never written to
`system_health_states`, never announced, never counted in `systems`.
Permanently, and completely silently. The health summary observed 40 components
while the watch persisted 37.

One of the three was **`notification_destination`** — the thing that delivers
every operational notice. Had it broken, the watch whose whole job is to
announce that would have dropped it as unreadable and said nothing at all.

Two fixes, because the bug had two halves:

- **One list, not two.** `selfHealing.defaultDeps()` now composes
  `healthObservations.defaultDeps()` and adds only its own `store` and `notify`.
  A test asserts every key the observer needs is supplied, so the lists cannot
  split again.
- **A silent drop is a counted drop.** The pass reports `unreadable`. The
  filtering stays — it is the right rule — but six missing dependencies hid
  behind it for the life of the feature, and a number would have shown it on day
  one. `unreadable` is deliberately NOT `errors`: it must not start a failure
  count, only be visible.

## The watchman could not report itself

Found by watching a deploy fail to take effect. After the commit that taught the
nine custom integrations to say `blocked`, none of them reached
`systems.waiting` — across thirty-two minutes and at least one due pass — while
`self_healing` reported healthy throughout.

`runSelfHealingPass` returns **`errors`**, plural, a list. `statusFromSummary`,
which is what the run ledger grades every worker by, reads **`error`**,
singular. So a pass whose `gatherObservations` threw returned early having saved
NOTHING, and the ledger wrote `status: 'ok'`.

That is the worst-shaped failure in the application, because this is the watch
that makes every OTHER component's failure visible. When it dies,
`system_health_states` simply freezes at whatever it last held; every component
keeps reporting the health it had at that moment; and `self_healing` —
catalogued **critical** — reads healthy the whole time. Nothing anywhere says
the picture has stopped moving.

**The rule, already settled once for the contradiction pass: the PASS decides
whether its errors amount to a failure and says so in `error`.**
`statusFromSummary` stays deliberately dumb so that "one bad component among
many is not a failed pass" keeps holding — a rule worth keeping, because a
single unreadable driver or a single deadlock is noise, and treating it as an
outage is how a health system gets switched off.

Three workers had the same shape and now follow the same rule:

| Worker | What a silent no-op cost | When it is a failure |
|---|---|---|
| `self_healing` | the whole health picture freezes, invisibly | gather threw, or no component could be recorded |
| `recruiter_logins` (critical) | every recruiter's RingCentral login expires 7 days later, on a Monday nobody was watching — the exact failure the job exists to prevent | the recruiter list could not be read, or the settings read threw |
| `ai_model_maintenance` | a retired model is never dropped, so the chain keeps pointing at models that no longer answer | no enabled provider could be verified |

A fourth thing came out of the same reading. `recruiter_logins` read its
settings with `.catch(() => null)`, which collapsed **a failed read** and **an
empty settings row** into one answer — so a database outage reported as
"RingCentral is not configured yet", the most reassuring possible description of
an outage. Those are now separate: a throw is an `error`, an absent row is
`blocked`.

And the seam that hid it: `runSelfHealingPass` called its gatherer through the
module-local binding, so a test replacing the export was silently ignored. The
one seam the failure needed could not be reached from a test. It is injected
now.

## Configured is not the same as reachable

Two features could be fully configured, report healthy, and be structurally
incapable of doing anything — and nothing could tell you which:

- **The safety pipeline.** The poller already wrote how many new events each
  poll found into its heartbeat, and nothing read it. So a fortnight with no
  incidents and a recorder that cannot write produced the same `events: 0`.
  `/api/health → operations.safety.poller` now carries what the poller SAW and
  whether its store believes it can WRITE. Seen above zero with recording not
  ready is a recorder problem named outright; both zero is a quiet fleet.
  On the poller's own side, `recordingStatus()` had been exported and tested
  since the store was repaired and had never been called — the same shape as the
  bug it was written to make visible.
- **After-hours recruiting.** Every readiness check is a SETTING. None proves a
  candidate's text can still arrive: inbound SMS depends on a RingCentral
  webhook subscription created by the Python leads engine, which sheds filters
  when a tenant refuses one and can lose the subscription outright. After that
  the feature reads "ready" and answers nobody, forever. Every inbound message
  already writes a mirror row, so the check now also asks whether one has
  **ever** arrived — free to read, and the only honest evidence the path is
  alive.
