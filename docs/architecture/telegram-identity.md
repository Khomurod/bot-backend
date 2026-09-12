# Which Telegram account belongs to which driver

**Read this before changing `lib/identity/telegramResolution.js`,
`services/operations/checks/telegramIdentity.js`,
`services/operations/corrections/telegramActions.js`, or
`driver_person_telegram_identities`.**

## Why the table exists

`driver_profiles.telegram_user_id` answers *"which account do we text for this
CHAT"*. It is filled in by hand, one driver at a time, and when a chat is
recreated the answer is lost with it — the same shape as every other problem the
person layer was built to fix.

`driver_person_telegram_identities` answers *"which account is this HUMAN"*,
with a start and an end. A driver who changes chats keeps their Telegram
identity; a driver who leaves has theirs **closed**, not overwritten.

## The one constraint that matters

`uniq_person_telegram_open_account` — **one open row per Telegram account.**

One human is behind one account at a time. Without it two people could both be
"the" owner and every lookup through that account would pick arbitrarily.

The constraint is on the **account**, deliberately not on the person: somebody
may carry a second phone. And nothing stops many *closed* rows for one account —
an account that moved from one person to another leaves a trail, and the trail
is the point.

## Picking the driver out of the room

A driver group contains the driver and, very often, a dispatcher, a manager, the
owner, and somebody added once who never left. So the rule
(`lib/identity/telegramResolution.js`) is deliberately mean: it links only when
a **single-driver chat** narrows to **exactly one plausible candidate** whose
Telegram name **agrees** with the driver's.

**Who is excluded before any matching happens:**

| excluded | why |
|---|---|
| bots | obviously |
| an account already linked | one human per account is the schema's anchor; offering a taken account proposes a correction the database then refuses |
| `bot_users.source` = dispatcher or admin | a dispatcher is in every driver's chat and would otherwise be "the one candidate" in dozens of them |
| present in **3 or more** driver chats | the signal that catches an unlabelled manager. A driver is in one |

**NEVER ON A USERNAME.** A username is reassignable — its owner can change it
and a stranger can claim the old one the next day. `username_at_link` is a
snapshot so a human reading the row recognises the account; nothing matches on
it, and a test asserts that a member whose only resemblance is the username does
not link.

**A team chat is never resolved automatically.** Two drivers and two candidates
gives no way to tell which account is which without reading messages, and
reading messages to decide identity is not something this does.

### Why the LOOSE name matcher is right here

`lib/identity/boardResolution.js` uses a strict one and this uses
`driverNamesMatch`, which treats a shared surname as a match. That is not an
inconsistency:

- there, the candidates were **the whole fleet**, and a shared surname is a real
  risk — two brothers become one person;
- here, the field is **one person in this driver's own chat**, and the question
  is only whether the account looks like them at all. A Telegram display name is
  a nickname as often as a legal name, so demanding an exact match would refuse
  almost every true link.

## The findings

| Check | Tier | Proposes |
|---|---|---|
| `identity.telegram_link` | `auto` | the link |
| `identity.telegram_member_unnamed` | `approval` | the link — common, often right, so a person confirms |
| `identity.telegram_members_ambiguous` | `warning` | **nothing** |

**Nothing in the message path decides this.** The bot records who it has seen
and moves on; the sweep looks at the whole room at once, fifteen minutes later.
A decision made per message would see one person at a time and conclude "the
only candidate" about whoever texted first.

**No account id appears in a finding title or its evidence** — titles are
published to notices, and a notice lands in a group chat's permanent history.
The id travels in `proposedChange` only.

## Applying it

`identity.link_telegram` **re-reads the room under lock** and refuses unless the
answer is still `link` and still the **same account**. Somebody joining the chat
between the sweep and the apply turns "the only candidate" into a question, and
that is exactly the case worth refusing.

**It never overwrites an administrator's choice.** It fills
`driver_profiles.telegram_user_id` only when that column is NULL — the rule
`database/driverProfiles.js` already follows on the profile-save path — and the
revert clears it **only if this correction set it**.

The insert can lose to the unique index if the account was taken in between.
That is the guarantee working, and it is reported as a stale correction rather
than retried.

## Reading it back

`database/driverPeople/lookups.js findPersonByTelegramUserId` consults this
table **first** and falls back to the profile column, so an account linked at
the person level resolves even when no profile carries it. A missing table (a
deploy that has not applied 0049) falls through silently.

`/api/health` → `operations.identity.accounts` carries `linked`, `people` and
`closed`. **The key is not named for the platform**: a test bans the string
"telegram" from that payload outright, which is blunt and is exactly why it
works — an account id cannot slip past a rule with no exceptions.

The person panel shows the accounts with their ids, because an administrator is
already authenticated there and the id is what they check against Telegram.

## Tests

`telegramResolution`, `telegramIdentityChecks`, `telegramIdentityPg` (requires
`TEST_DATABASE_URL` — the backfill, the unique index, the re-derivation, and the
never-overwrite rule).
