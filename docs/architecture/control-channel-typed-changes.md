# Answering Wenze in your own words — a change you confirm

**Read this with [`control-channel.md`](control-channel.md) before changing
`lib/control/changeCatalogue.js`, `services/control/aiChange.js`,
`services/control/confirmChange.js` or the typed-change branches of
`services/control/answerQuestion.js` and `services/control/actions.js`.**

The owner, 6 November 2026: "if every discrepancy needs a code change we will
never finish — I want to answer the bot's question in my own words and have it
change the driver's profile." Decided with the owner the same day:

1. A model may **propose a value**, but nothing is written until the owner
   answers **Yes to the exact change**, shown in words.
2. Only the owner teaches it, **through Telegram** (`control_operators`, which
   holds the owner and nobody else).
3. A general rule is made only by the owner's Yes (the next step; not built
   yet — see below).

## How an answer becomes a change

| Step | Where | What happens |
|---|---|---|
| 1 | `parseIntent`, then `aiIntent.js` | read as before: yes / no (and why) / later / details |
| 2 | `answerQuestion.js` | if that gave no plain answer — or a "no" carried words of its own, or the reply is anything but yes / later to a confirmation — the change reader runs |
| 3 | `confirmChange.changeTargets` | the chats the question was about: its subject chat, a chat its evidence names, the chats the daily board check found the driver on (`wenzeElsewhere`) — at most four, active driver chats only, with their current profile values |
| 4 | `aiChange.js` (`control_change_reading`) | proposes ONE operation from `changeCatalogue.js` on ONE of those chats, by letter, with values; or `none` |
| 5 | `changeCatalogue.validateProposal` | checked as the router's validator and again on the result: a known operation, an offered chat, values that fit, and not what the profile already says |
| 6 | `confirmChange.proposeChange` | "Did I understand you right? WENZE UNIT # 01 JOHN / MARK: unit 01 → 1" — a real question, under the owner's reply, with the change stored on its **Yes** (`offeredActions[0].change`) |
| 7 | the owner | **Yes** → applied. **No** → nothing changes and the original question stays open ("you misread me", not "close it"; no "why?"). **Later** → put aside. Anything else is read again against the ORIGINAL question ("no, it is 01"), at most twice per conversation |
| 8 | `actions.executeOffered` | the stored change is validated against the catalogue AGAIN and applied through the correction registry as the owner (`telegram:<id>`), approval tier, audited, revertible. The finding is put aside for two hours rather than marked applied: whether the change settled it is the next sweep's to say |

## The catalogue (`lib/control/changeCatalogue.js`)

| Operation | Values | Correction |
|---|---|---|
| `set_unit` | the truck number (digits, one trailing letter) | `profile.set_unit` |
| `set_driver_type` | owner / company_driver / lease | `fleet.set_driver_type` |
| `set_truck` | fleet, and the owner for an owner's truck | `profile.set_truck` (recorded `manual`, so the board copy never overwrites it) |
| `set_status` | active / inactive | `identity.set_driver_status` |

Each correction re-reads the profile under lock and refuses when it no longer
holds what the question showed, so a Yes to a stale question changes nothing.
The truck record follows through the sweep's own repairs, as for an edit in the
admin. A new number on a chat whose title says another one is confirmed with a
note to rename the chat — Wenze cannot rename a Telegram chat.

**Not in the catalogue, on purpose:** another system (the board, Datatruck,
Bitrix — Wenze only reads those), a person's name, deleting anything. Adding an
operation is a code change — and the only kind this design still needs.

## Notices you can answer

A `warning` finding had nothing for Yes to do, so it was never asked. A check
whose wording says `answerable: true` (`lib/control/questionWording.js`) is now
put to the owner with no Yes: they answer in their own words, or "no, because …"
closes it. Today: `fleet.driver_not_in_wenze` and `fleet.board_suffix_missing`
from the daily Board ↔ Wenze ↔ Datatruck check.

## "да" and "нет"

`parseIntent` reads "да" / "ha" as yes and "нет" / "yo'q" as no, with no
model, exactly like "yes" and "no" — before November 2026 only a choice
question did, and a plain "да" with AI off was not understood at all. A
confirmation must not depend on a model to read "да".

## Not built yet (step 2)

Facts and rules as data: "board 1 RUDOLPH is Wenze 01", "a bare board number on
a company driver is a lost suffix — Wenze is right", offered as "make it a rule
for everyone?" after the same answer repeats, and consulted by every check
before it asks. Until then a typed answer changes one profile, and a "no,
because …" is remembered against that one condition as before.

## Tests

`tests/controlTypedChange.test.js` (the catalogue, the reader's two checks, the
confirmation question, the reply flow, the writer, answerable notices, "да" /
"нет"), `tests/profileEditActionsPg.test.js` (applied as the owner against a real
database, the finding left for the sweep, a stale Yes refused, revert).
