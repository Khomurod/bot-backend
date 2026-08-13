---
name: implement
description: The standard end-to-end workflow for implementing a requested change in this repository — a feature, bug fix, adjustment, removal, or any other meaningful application change. Use it whenever the user invokes /implement, and whenever a request asks for a real change to how the application behaves. It runs understand → investigate → implement → test → self-review → verify → update documentation → report. The user may describe the outcome in business language; determining the technical approach is part of this workflow, not the user's job.
argument-hint: <the change you want, described by outcome>
---

# /implement — the standard implementation workflow

**Input:** `$ARGUMENTS` — what the user wants to be true when this is done,
often described in business or non-technical terms.

```
/implement Route Monitor is not automatically completing routes when the driver
           reaches the destination. Fix it without affecting off-route warnings.
```

The user describes the **desired result**. Deciding *how* to achieve it —
which files, which layer, which pattern — is your job. Do not push the technical
design back onto the user, and do not stop at "please tell me which approach you
want" when the desired outcome is clear.

This skill is the process. The repository's own documents are the authority on
content:

| Source | Authority over |
|---|---|
| `CLAUDE.md` | How you must work here: mandatory pre-work, safety rules, architecture and file-size rules, per-feature invariants, test commands |
| The **App Brief** (`APP_BRIEF.md`, or `docs/APP_BRIEF.md` in repos that keep it there) | What the application is, how it behaves, its business rules and preserved decisions |
| The current source code | The truth when any document disagrees with it |

Read them; do not assume this skill has already told you what they say.

Work through the eight steps below in order. Do not skip a step because the
change "looks small" — small changes are where silent regressions live. Do
scale the *depth* of each step to the real risk of the change.

---

## 1. Understand

Before editing anything:

- Read `CLAUDE.md` and perform any pre-work it makes mandatory (for example a
  codebase-memory / index server it requires you to consult first). If a
  mandated tool is unavailable, say so explicitly and continue — never claim
  you used it when you did not.
- Read the parts of the App Brief that cover the affected area, plus its
  "must not break" / preserved-decisions section.
- Check for other repository instructions that apply: nested `CLAUDE.md` files,
  `README.md`, `docs/` deep dives for the feature, CI configuration.
- Restate to yourself the **final behavior** the user wants — the observable
  outcome, not the mechanism.
- Identify the **exceptions**: what must keep working exactly as it does today.
  Requests routinely name one ("without affecting off-route warnings"); there
  are almost always more that the user did not think to mention.

Ask the user only when two readings of the request would lead to materially
different work. Otherwise decide, state your assumption in the final report,
and proceed.

## 2. Investigate

Before writing code:

- Read the actual current code in the affected path, end to end — entry point,
  service layer, data access, background jobs, and the UI or Telegram surface
  if either is involved.
- Trace the real runtime behavior and its dependencies: who calls this, what it
  writes, what reads that data afterwards, what schedules it.
- **Find the real root cause.** The user's explanation of *why* something is
  broken is a report of a symptom, not a diagnosis — verify it. Fixing the
  place the user pointed at, when the fault is upstream, produces a change that
  passes review and fails in production.
- Check related code that the change could disturb: shared helpers, other
  callers of a function you are about to modify, tests that encode the current
  behavior, permissions, and any feature invariant `CLAUDE.md` attaches to this
  area.
- Look for the existing pattern for this kind of work in this codebase and
  reuse it — module layout, naming, error handling, logging prefixes, query
  style. Match the surrounding code.
- For a cross-cutting or risky change (schema, permissions, an external
  integration, a shared service, anything touching money, messaging or safety),
  do enough impact analysis to say concretely what else could break.

## 3. Implement

Deliver the requested result completely.

- Solve the underlying problem, not only the visible symptom.
- Preserve unrelated existing functionality. Do not silently change behavior
  the request did not ask you to change.
- Respect this repository's architecture, conventions, permission model,
  business rules, integration contracts and documented invariants. An
  invariant in `CLAUDE.md` or the App Brief is a hard constraint — if the task
  seems to require breaking one, stop and raise it rather than quietly
  regressing it.
- Keep it as simple as the problem allows. No speculative abstraction, no
  unrequested refactors riding along in the same change.
- Extract shared logic rather than copying it; obey the repository's file-size
  and module-design rules.
- If implementation reveals a materially better way to reach the requested
  **outcome** than the approach you first assumed, take it — the outcome is the
  contract, not your first plan. Note the deviation in the final report.
- If part of the scope turns out to be genuinely blocked, finish everything
  else in full and say exactly what you left out and why.

## 4. Test

- Run the tests that cover what you changed, using the commands this repository
  defines (see `CLAUDE.md` and the `scripts` section of `package.json` or its
  equivalent; the CI configuration shows what a complete verification looks
  like).
- Run any tests the repository explicitly requires you to preserve for the
  feature you touched.
- Add or update tests so the new or fixed behavior is protected against future
  regression, and so the exception you were told not to break is covered too.
- Run the other applicable repository checks: build, lint, type-check, static
  analysis, schema checks, security/secret scanning — whatever this repository
  requires.
- **Never claim a test passed unless you actually ran it and it passed.**
  Report the exact command and the pass/fail counts.
- **A skipped or unavailable test is not a passing test.** Say so plainly, and
  say why it skipped (missing database, missing credentials) rather than
  folding it into a green summary.
- If a test fails because of your change, diagnose and fix it. Do not hand the
  user a failure report as the deliverable. If a test fails for reasons that
  predate your change, verify that against the base branch before attributing
  it there.

## 5. Self-review

Now review your own work as if it were another developer's pull request. Read
the complete diff (`git diff`, plus untracked files) and answer honestly:

- Did I implement **everything** requested?
- Did I misread any part of the desired behavior?
- Which edge cases did I miss — empty, first-run, concurrent, retried,
  partially-configured, already-completed, permission-denied?
- Did I change any unrelated behavior?
- Did I duplicate logic that already exists, or make something more complicated
  than the problem requires?
- Did I violate a business rule, permission rule, integration contract, design
  or data rule, or a documented project invariant?
- What is the regression risk, and what would it look like in production?
- Are the tests actually sufficient for the behavior that changed — would they
  fail if the fix were reverted?
- Is there leftover debug output, commented-out code, dead code, scratch files
  or temporary configuration?
- Is there anything in this diff that should not be in it?

**Fix what you find.** Self-review that only produces a list of caveats has not
been done. Report a finding unfixed only when fixing it is genuinely outside
this task, and then say so explicitly.

## 6. Verify again

After the self-review fixes:

- Re-run the affected tests and checks. A fix applied after the last test run
  is an untested fix.
- Read the final diff once more, start to finish.
- Confirm the implementation matches the behavior the user asked for, and that
  the named exceptions still hold.
- Do not declare completion while a known problem remains open. If something
  truly cannot be resolved inside this task, finish everything else and report
  the remainder clearly and specifically.
- Obey the repository's rules about committing, pushing and merging — including
  any warning in `CLAUDE.md` about what a push triggers here. The final diff
  review happens **before** the push, not after.

## 7. Documentation and the App Brief

Before considering the task complete:

- **Re-read the App Brief.** Decide whether your change made any part of it
  untrue.
- Update the relevant parts in **this same task**: add important new behavior,
  business rules, integrations, dependencies, exceptions or preserved
  decisions; correct or remove whatever became false.
- Do not add minor implementation detail, line numbers or function signatures
  to the brief. Add a fact only if a future agent would get it wrong without it.
- If you changed a behavior guarded by a per-feature invariant in `CLAUDE.md`,
  update that invariant too.
- Check whether the change made any other current document inaccurate —
  `README.md`, a `docs/` deep dive, generated database or API reference — and
  update or regenerate it.
- **The task is not complete while the application behaves one way and the
  documentation says another.** If a document and the verified application
  disagree, the application is the truth and the document gets corrected.

## 8. Final report

Keep it short and concrete:

- **What changed** — the behavior, and the main files or modules involved.
- **Is the requested result fully implemented** — yes, or exactly what is
  missing.
- **What was run** — the important test and check commands, with real results
  (pass/fail counts; skips called out as skips).
- **What self-review caught and corrected.**
- **Documentation updated** — which parts of the App Brief or other docs, or
  that no update was needed and why.
- **Any real remaining limitation, assumption or uncertainty.**

Do not dump low-level implementation detail unless the user asks for it. Do not
report success while any step above is unfinished.
