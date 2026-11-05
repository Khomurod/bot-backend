# The control channel's morning summary

Once a day, from 08:00 Chicago time, one message in the `needs_attention`
group (`services/control/dailyDigest.js`, pure wording in
`lib/control/digest.js`, rides the consistency sweep under
`withRunRecord('control_daily_digest')`):

- **"Most important today", first** — three of the open problems, chosen
  from the first eight by rule (`lib/control/priorities.js`, the same order as
  the questions). An AI (`daily_priorities`) may pick among them and say each
  plainly; every pick must name an item it was given, by number, so it cannot
  add a problem; and it must give exactly three (or all, when fewer are
  open) — an incomplete answer is refused. Without AI, or on a refused
  answer, it is the first three by rule under their own titles;
- **the questions still waiting** — how many, and the three that have waited
  longest by name and age. This is the escalation: a question nobody answered
  slides up the chat and is, in practice, gone; the summary brings it back.
  One per finding (a re-ask is not a second thing waiting), first questions
  only (a "why?" belongs to its question), delivered, unanswered, about a
  finding still open and not snoozed (`database/controlDigest.js`) — and
  **only questions asked in the chat the summary is going to**. A question
  keeps the chat it was asked in; after the destination changes, naming the
  old ones would show finding titles to a group that never received them. The
  destination is resolved exactly as `notify` resolves it; with none, nothing
  is read or sent;
- what Wenze changed on its own in the last day, and how many of **those**
  were undone (`revertedBySystem` — a person's undone edit is not counted
  against Wenze);
- how many problems are open (serious · warnings);
- which workers are broken, and separately which are switched off or waiting
  on a setting (`waiting`, never in `down`) — by catalogue label, never a key.
  "All systems running" is said only when both lists are empty.

**Once a day is the outbox's guarantee.** The local date is the notice's
discriminator, so the UNIQUE notice key refuses a second summary that day
whatever restarts. Before building it the pass checks that key with
`noticeSentWithin`, and a failed check counts as "already sent". Not after
20:00: a process down all day must not post the morning summary at midnight.

**Unread is never empty.** Each part reads independently; one that fails is
named in a closing "Could not read …" line instead of being reported as
"no questions" or "all systems running". The summary carries no question and
no buttons, and is off whenever the control channel is off.

Part of [`control-channel.md`](control-channel.md), split out to keep that
document under the 500-line limit.
