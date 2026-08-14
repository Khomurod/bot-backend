# Handover — SOS questionnaire anti-gaming rewrite

**Branch:** `claude/sos-questionnaire-anti-gaming-j183hm`
**State:** content rewrite complete and green on all automated checks.
**Not done:** the real-browser TEST walkthrough and screenshots (see §3).

This note exists so the next agent can finish without re-deriving the design.

---

## 1. What was done

Full rewrite of **all 350 answer options** (7 departments × 10 questions × 5
options) in **UZ / RU / EN** — 1,050 strings. Question scenarios, option keys,
pattern mappings, the 10×5 shape, scoring, primary/secondary logic, real/test
isolation, personal results, `/answers`, `/qbq`, admin, duplicate detection and
test cleanup are all **unchanged**. `CONTENT_VERSION` 1 → **2**.

**No scoring mapping was changed.** Every `*_a … *_e` key keeps the pattern it
had in v1. Nothing in the review turned up a mapping that contradicted its
wording once the wording was rewritten to the new rules.

### The design rule that replaced the old one

v1 encoded each pattern as a **keyword formula**, which is what made it
gameable. Sampled across a department, v1 read like this:

| pattern | v1 tell | occurrences in one department |
|---|---|---|
| ownership | "…**myself**, **right now**" | 9–10 of 10 options |
| builder | "…then **set up / propose** <process change>" | 3–5, and the **longest** option in 5–7 of 10 questions |
| victim | opens "**I would tell my lead**…", closes "should not **be read as** my work" | 4–7 |
| complaint | "…, **but tell my lead**: <nothing ever changes>" | 3–**8** |
| blame | "…**that is where it gets fixed**" | 6 |
| waiting | literally "I will **wait**" | most |

v2 defines the six as **loci of first action** instead (documented at the top of
`content/hr.js`, which the other six files reference):

- **victim** — my own position/exposure first: is my work about to be judged on
  inputs I did not control? Expressed as a calm, defensible act (put it on
  record, settle the boundary with my lead, build the report so the two show
  separately) — never as a feeling about myself.
- **complaint** — the recurring *condition* is the real subject; the change is
  asked of whoever holds the authority for it. The individual case still gets
  handled.
- **waiting** — confirmed information, the proper owner, the defined sequence.
  Action is triggered from outside. Often the *rigorous* choice ("one confirmed
  answer beats two versions").
- **blame** — locate where the process broke so the correction lands where it
  belongs. Diagnostic, not accusatory.
- **ownership** — this case is mine to close now, with honest information.
  Sometimes the slightly riskier, more decisive option.
- **builder** — change the mechanism, **sometimes explicitly at the cost of the
  case in front of you** ("it will not ease this driver's call, but it prevents
  the next ten"). This is the main lever that stops builder reading as
  "ownership plus extra credit".

### Anti-gaming work beyond wording

1. **Lexical de-monopolisation.** "myself / oʻzim / сам", "right now / hoziroq /
   прямо сейчас", "today", the blame closer, the complaint hinge and the victim
   opener were spread across several patterns so none functions as a key. E.g.
   complaint and blame options now also say "myself"; victim and complaint
   options now also say "right now".
2. **Length de-correlation.** Builder was the longest option in 5–7 of 10
   questions per department and victim/waiting were reliably the shortest — both
   were usable keys without reading the text. Max/min length ratio inside a
   question was tightened from ≤2.6 to **≤1.8**.
3. **Tone.** Every self-pitying / contemptuous formulation was removed ("it
   stings", "grumble", "exhausting", "unfair", "why me", "wasted"). A banned-tone
   list is now asserted.
4. **Operational safety was never traded for subtlety.** No option permits an
   HOS violation, an informally lifted safety hold, releasing or continuing on
   unsafe equipment, a dispatched trailer without a valid annual inspection, an
   invented ETA/location, an undocumented incident, a payment without the
   required document, or a hidden error. Four highest-risk questions
   (`safety_q08`, `trailer_q04`, `trailer_q07`, `trailer_q09`) have a per-option
   assertion that the control survives in **all five** options.

### New/changed guards

`tests/sosAnswerKeyLeakage.test.js` (new) — lexical monopolies, longest/shortest
distribution, minimum option body, banned tone, safety-critical per-question
whitelists, `CONTENT_VERSION >= 2`.
`tests/sosContent.test.js` — length ratio 2.6 → 1.8; ownership/builder position
spread 3 → 4 distinct positions.

---

## 2. Automated results (all run, all green)

| Check | Result |
|---|---|
| `node --test --test-concurrency=1 tests/*.test.js` (with `TEST_DATABASE_URL`, so the `*Pg` suites really ran) | **2145 pass / 0 fail / 0 skipped** |
| `npm test --prefix admin` | **163 pass / 13 files** |
| `npm run build --prefix admin` | built |
| `npm run lint:filesize` | OK, no new violations |
| `npm run build:schema:check` | up to date |

Baseline before the change was 2137 pass / 0 fail; the delta is the new test file.

**Postgres in this container:** `service postgresql start`, then
`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/sos_test_root`
(create with `TEMPLATE template0 ENCODING 'UTF8'` — `schema.sql` contains
box-drawing characters). It stops on container resume; if 144 tests fail with
`ECONNREFUSED 127.0.0.1:5432`, that is all it is.

---

## 3. What is left — pick up here

### 3a. Real-browser TEST verification + screenshots (the main gap)

Not started. Requirements from the original request:

1. Boot the app against the local Postgres, open **`/questions/test`** and
   complete **several full test questionnaires** across substantially different
   departments — at minimum HR, Dispatch, Safety, Accounting, and at least one of
   Trailer / Samsara / Updaters.
2. **Deliberately vary the profiles** — do *not* always pick the best-looking
   answer. The aggregate on `/answers/test` should end up containing a useful
   mix of victim, complaint, waiting, blame, ownership and builder primaries.
3. Screenshot representative **questionnaire** screens from several departments
   at **phone dimensions**, and the final **`/answers/test`** company-wide screen
   at **desktop/projector dimensions**, plus any extra result-state shot needed
   to show the presentation reads correctly.
4. While clicking through, judge the wording *as a respondent*. If an option
   still jumps out as the obvious "good employee" answer, fix it and retest.
5. **Never create real (non-test) submissions.** `/questions` and `/questions/test`
   are separate `is_test` universes; use only the test flow. Clean up afterwards
   with the admin clear-test operation if desired.

Chromium + Playwright are preinstalled (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`);
do **not** run `playwright install`.

### 3b. Ratchet two thresholds back down

Two guards in `tests/sosAnswerKeyLeakage.test.js` are currently set at a
defensible *floor* rather than the target, because the last few options were not
reworded before handover. Both are marked in the file. Tighten them as content
improves:

| Guard | now | target | still violating |
|---|---|---|---|
| process language spans ≥ N patterns | 2 | 3–4 | `trailer` uz/ru/en, `accounting` uz/ru/en — process words ("tartib/qoida", "порядок/правило", "procedure/rule") sit almost only in builder+complaint there |
| victim/waiting is the shortest option in ≤ N of 10 | 5 | 4 | `trailer` en (victim 5), `samsara` uz (victim 5) |
| ownership+builder are the longest in ≤ N of 10 | 7 | 6 | `accounting` uz/ru (7) |

Fix by *lengthening* the victim/waiting/blame options involved and adding
process vocabulary to complaint/blame/waiting options — not by trimming
ownership/builder further, which would start to make them identifiable as the
short ones.

Useful throwaway scripts are in the scratchpad and easy to recreate: one that
flags lexical monopolies per department/language, and one that prints the
longest/shortest-option pattern counts. The test file now covers both.

### 3c. Blind adversarial review was not completed

The intended check — hand a reviewer the questions with options shuffled and
**no** pattern keys, ask them to pick "the answer management wants", and compare
against the key — was set up but the run failed on a tooling error and was not
retried. Worth doing: dump each department with a seeded shuffle and numeric
labels, keep the key in a separate file, and have 2–3 independent reviewers
(different framings: cynical employee, psychometrics consultant, someone who has
read the QBQ book) guess with a confidence score and state the *tell*. Any
question guessed with high confidence and a nameable tell needs rewriting.

### 3d. Questions I still consider the weakest

Honest list — the remaining places where I think a determined gamer has better
than chance odds:

- **`hr_q07`, `safety_q10`, `updaters_q10`** — the scenario is itself "a process
  is broken", so the builder option is close to being the only coherent reading
  of the situation. Consider making the complaint option's ask more concrete
  (resource/decision) so it competes.
- **`accounting_q06`** (escrow questions repeat weekly) — same shape; the
  waiting option ("configured centrally, nothing to do but answer") is the
  weakest-sounding option anywhere in the set and could be strengthened.
- **`trailer_q07` / `trailer_q09`** — because every option must keep the unit
  held, the options differ mainly in *who decides*, which narrows the spread and
  makes ownership fairly visible.
- Generally: **builder remains the easiest pattern to identify** (installing a
  mechanism is definitional and cannot be hidden lexically). The mitigation is
  that ownership is equally constructive, so identifying builder does not by
  itself tell a gamer which of the two to pick — but it does let them exclude
  the other three in some questions. If more subtlety is wanted, the lever is to
  give complaint/blame/waiting options a concrete mechanism *ask* more often, so
  "mentions a mechanism" stops narrowing the field.

### 3e. Uzbek review status

Uzbek was authored first and treated as the primary language throughout (RU and
EN written as independent natural equivalents, not calques). Conventions used:
`ʻ` (U+02BB) in `oʻ/gʻ`, `ʼ` (U+02BC) for tutuq belgisi (`maʼlumot`, `masʼul`,
`taʼmir`); workplace loanwords kept as employees actually say them (`haydovchi`,
`dispetcher`, `broker`, `yuk`, `treyler`, `yard`, `shop`, `update`, `ETA`,
`apoyntment`, `settlement`, `POD`, `BOL`, `lumper`, `detention`, `TONU`, `HOS`,
`ELD`, `DOT`, `CSA`, `escrow`, `shipper`, `check-in`, `no-show`). One v1 typo was
fixed (`yiggʻan` → `yigʻgan`). **A native-speaker read-through has not
happened** — worth one pass, especially over the victim and complaint options,
which were rewritten last and fastest.
