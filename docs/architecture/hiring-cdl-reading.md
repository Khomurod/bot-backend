# Reading a candidate's CDL photo into Bitrix

**Read this before touching** `lib/hiringStages/cdl{Fields,Name,Write}.js`,
`services/hiringStages/cdl{Step,Reading,Bitrix}.js`,
`database/hiringStages/cdl{Reads,FieldMap}.js`,
`server/routes/settings/hiringCdlRoutes.js`,
`admin/src/pages/settings/recruiting/CdlFieldMapCard.jsx` — and, for the
per-task provider choice it introduced, `lib/ai/providerChoice.js`,
`services/ai/capabilityProviders.js`,
`server/routes/settings/aiCapabilityProvidersRoutes.js` and
`admin/src/pages/settings/ai/CapabilityProvidersCard.jsx`.

It is part 2 of asking the bot for a lead by tag
([`hiring-stage-proposals.md`](hiring-stage-proposals.md) rule 20, and rule 21
for this).

## The owner's decisions (14 November 2026)

| | Decision |
|---|---|
| When | Only when a person TAGS the bot under a lead's post, and only when the post has photos. The model also says which photo is the CDL's front and which its back. |
| Who reads it | The owner: a capability `hiring_cdl_reading` with its own switch, and a PER-TASK provider choice in Settings → AI — which of the configured providers, in what order ("only Claude", "only the free ones", "Gemini, then Claude"). No provider chosen, or the switch off: nothing is read. |
| What | Everything printed: first, middle, last name, suffix; date of birth; street, city, state, ZIP; licence number, issuing state, class; issue and expiration dates; endorsements, restrictions; sex, height, weight, eye and hair colour. Validated by type; an invalid value dropped, never invented; an unsure answer writes nothing. |
| Where | The owner maps each item to a Bitrix contact or deal field (Settings → Safety Approvals → 6), or leaves it unmapped. One update per record; a field that already has a value is NEVER overwritten; everything else in ONE comment on the deal titled "CDL (read by <provider/model>)". Recorded in Monitoring → Logs as the person who tagged, with field NAMES only. |
| The name | The post names one driver for certain → the CDL's first and last name must be that name (one letter of tolerance in words of five letters or more); a mismatch writes nothing. The post names nobody → the CDL's name may be used to create the candidate, and the card says "name read from the CDL". |
| Never in Wenze, never in Telegram | No CDL value is stored in Wenze's database, logged, posted in Telegram or kept in error text. The driver's card shows counts ("CDL read (Claude): 9 items written to Bitrix, 3 in a comment") or the reason it was not read. |

## The rules

1. **A person's tag, a post with photos.** The step runs only in a read a
   person asked for (`services/hiringStages/requested.js`); a conversation the
   bot reads on its own never sends a photo anywhere.
2. **The owner chooses who reads it.** `ai_capabilities.provider_order`
   (migration 0107) maps a task to an ordered list of providers;
   `lib/ai/providerChoice.js` is the rule and `services/ai/router.js` honours
   it: only those providers, in that order, never rotated. A task with no list
   keeps the global order, exactly as before — except a task the catalogue
   marks `providerChoice: 'required'` (this one), which reads "no list" as
   NOBODY. The list narrows, never widens: free-only mode still refuses a paid
   provider, a cooled provider is skipped, and a picture still goes only to a
   model on the vision allow-list (`lib/ai/vision.js`). An unsure answer is
   passed to the next provider ON THE LIST (`services/ai/escalation.js`
   `alongOwnOrder`; for Claude: Sonnet, then Haiku, never Opus); still unsure,
   it comes back `uncertain`. When none of the chosen providers could be
   asked at all (switched off, no key, paid under free-only, no model that
   can see) the card says "no provider" before anything is downloaded.
3. **Only the photos leave, and only in memory.** The post's pictures (at
   most six, the post as Safety Approvals assembles it) are downloaded by
   their Telegram file ids (`services/telegram/fileDownload.js`, 10 MB each),
   shrunk (`services/aiImagePrep.js`, 1600 px keeps small print) and sent as
   numbered parts. No message text, no phone. Nothing is stored.
4. **One strict shape, every value checked** (`lib/hiringStages/cdlFields.js`).
   Real calendar days as `YYYY-MM-DD` that agree with each other (a birth date
   16–100 years ago, an issue date not in the future and at least 14 years
   after birth, an expiry after issue and within 15 years — two that disagree
   are BOTH dropped, which one is wrong is not guessed); a licence number of
   letters, digits and dashes with a digit; a state of two letters that
   exists; a ZIP of five or nine digits; a class, codes, sex, height, weight
   and colours in the shapes a CDL prints. A value that does not fit is
   dropped — never repaired. A key the shape does not have is dropped. A model
   saying `unclear` — or not sure enough after the chosen providers — writes
   NOTHING (`ai-decisions.md` rule 7).
5. **Whose card it is** (`lib/hiringStages/cdlName.js`). The post names one
   driver for certain: the CDL's first name (its first word) and every word of
   its last name must be words of that name — equal ignoring case, or, both
   five letters or more, one letter edit apart (the rule
   `lib/hiringStages/displayName.js` uses for Safety's spelling); a mismatch
   writes nothing. The post names nobody: the CDL's name may CREATE the
   candidate (`identityFromCdl` — still exactly one typed phone, and every
   rule of the creation: a contact holding the phone must carry that name).
   A deal found by phone for such a post is checked against its contact's own
   name when that is a real one. A post that may be about more than one driver
   (a team, two names, a second name-shaped line) is not read.
6. **Where it goes** (`lib/hiringStages/cdlWrite.js`). Only to an OPEN deal in
   a hiring pipeline (never pipeline 3 or 33). The owner's mapping
   (`hiring_cdl_field_map`) names a contact or deal field per item; the
   field's type and list items are read live (`crm.contact.fields`,
   `crm.deal.fields`) and the records themselves (`crm.contact.get`,
   `crm.deal.get`). An EMPTY mapped field is written — ONE `crm.contact.update`
   and ONE `crm.deal.update` at most; a FILLED one never: the same value is
   left alone, a different one goes into the comment marked "not changed".
   Everything unmapped, a field gone from Bitrix, or a value its field cannot
   take (a height in a number field, a class no list item names) goes into ONE
   `crm.timeline.comment.add` on the deal: "CDL (read by
   <provider>/<model>)", which photo was the front and the back, then each
   item.
7. **No value in Wenze, its logs or Telegram.** `hiring_stage_cdl_reads` keeps
   the status, provider, model, counts and the item NAMES written — its column
   list is pinned by `tests/hiringCdlPg.test.js`. Monitoring → Logs gets
   `change` with field names and "set (from CDL)", and the audit context says
   `valuesWithheld`: a refusal keeps none of Bitrix's words (they may quote the
   value) and a forgotten mask shows "(not shown)"
   (`lib/activityLog/entry.js`). The card gets counts or a reason. Nothing is
   logged but an error's name; no question is ever put to the owner about a
   CDL (`learning` is not passed, so `ai-learning.md` never sees one). The
   NAME is the exception the owner approved: a name read from the CDL is used
   like a typed one (the card's header, the deal's title, the creation claim).
8. **Once.** A conversation whose CDL was written is never read again; any
   other ending belongs to its tag (`database/hiringStages/cdlReads.js`
   `mayRead`) — the conversation is read again on every reply once a person
   asked, and that never re-reads the CDL. A NEW tag may try again (after the
   owner switched it on, chose a provider, or the post got a better photo).
9. **The deal comes first.** The step never throws: a failure it cannot name
   is recorded as `unreadable`, and the deal the read found or created stands.
   Bitrix refusing or not answering a CDL write ends the step (`bitrix_refused`,
   "N items written before that") — it is not retried; a new tag tries again.

## How it flows

```
requested.js (a person's tag)
  → cdlStep.createCdlStep
  → the post names nobody? nameForCreation: read the CDL → identityFromCdl → create with it
  → … find / create the deal as rule 20 says …
  → end(deal | null)
       no deal: a CDL already read → "no deal"; never read → nothing
       team / no photo / closed or not hiring → the reason
       readCdl (cdlReading.js): readiness (off / no provider) → download → runCapability('hiring_cdl_reading')
         → readCdlAnswer (cdlFields.js) → unsure / unreadable / read
       crossCheckName → differs / no name → the reason
       planCdlWrite → crm.contact.update, crm.deal.update, crm.timeline.comment.add (cdlBitrix.js, audited)
       → hiring_stage_cdl_reads row + ONE card line per tag
```

## Settings

- **Settings → AI → AI Tasks**: "Read a candidate's CDL photo" — the switch,
  and who reads it (or "No provider chosen — nothing is read").
- **Settings → AI → AI Providers → Providers for one task**: the ordered list
  (`GET /api/settings/ai/capability-providers`, `PUT
  /api/settings/ai/capabilities/:key/providers`); each provider says what
  would stop it being asked anyway.
- **Settings → Safety Approvals → 6. CDL → Bitrix fields**: "Read the fields
  from Bitrix" (on demand, read only), a target per item, Save; the latest
  reads as counts and reasons (`/api/settings/hiring-cdl*`).

## Decided while building (not specified by the owner)

The CDL's name is split as every creation splits a name (NAME = all but the
last word, LAST_NAME the last) and is not respelled by Safety's messages — the
card is the printed source. A team post is not read. A deal found by phone for
a post with no name is checked against its contact's real name. Dates must be
`YYYY-MM-DD` exactly. A value already in Bitrix but different goes into the
comment so a person can compare. Writes only to an open deal in a hiring
pipeline. The comment is not retried after a refusal (at most once). Free-only
mode wins over the owner's list. The capability is ON by default and reads
nothing until a provider is chosen.

## Tests

`tests/hiringCdlFields.test.js` (bad dates, wrong shapes, extra keys, unsure),
`tests/hiringCdlName.test.js` (match, mismatch, the CDL's name for a
creation), `tests/hiringCdlWrite.test.js` (never over a filled field, the
comment, the masked log change, the card's words),
`tests/hiringCdlBitrix.test.js` (the real client and recorder: no value logged,
a refusal's words withheld), `tests/hiringCdlReading.test.js` and
`tests/hiringCdlReadiness.test.js` (photos only, off, no provider, unsure),
`tests/hiringCdlRequested.test.js` (end to end), `tests/hiringCdlRoutes.test.js`,
`tests/aiCapabilityProviderOrder.test.js` (the order honoured, an empty list,
along the list when unsure, vision and free-only), `tests/hiringCdlPg.test.js`
(migrations 0107, 0108), and
`admin/src/pages/settings/ai/CapabilityProvidersCard.test.jsx`,
`admin/src/pages/settings/recruiting/CdlFieldMapCard.test.jsx`.
