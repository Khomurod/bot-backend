# What Wenze may tell a candidate

> Read this before changing anything the recruiting AI is given, or anything
> that writes to `recruiting_knowledge`.

## Why it exists

The recruiting SMS was a template with three placeholders: a rep name, a company
name and a position label. That was the entire vocabulary Wenze had about the
company's offer. Anything a candidate asked beyond it had to wait for a
recruiter.

For AI to answer at all it needs facts, and the only safe source of facts is a
person who typed them and confirmed them.

## The shape is the safety property

There is **no path that writes an active fact in one call**. An administrator
types a sentence, Wenze restates what it believes that means, and a second
deliberate action puts it into use. A candidate quoted a wrong pay rate is a
real problem for a real person, and one careless request should not be able to
cause it.

The API says so explicitly: the propose response carries `applied: false`, so a
client cannot present it as done.

## Two properties that shape every function

**Nothing is ever overwritten.** A rate changing from 70 to 77 cents produces a
new row that supersedes the old one; the old one stays, marked, with the dates
it was true. "What were we telling candidates in August" gets asked after a
dispute, and a table that overwrites cannot answer it. `retire` and `reject`
likewise mark rather than delete — a rejected idea is still a record of what was
asked for.

**The person's own words are the record.** `statement` is exactly what was typed.
A model's reading lives separately in `understood_as`, so a later
misunderstanding can be traced to what Wenze thought at the time instead of
disappearing into a paraphrase that quietly became the record.

## Three kinds, ordered for a prompt

| Kind | Meaning |
|---|---|
| `fact` | something Wenze may tell a candidate |
| `boundary` | something Wenze must never say, or must defer |
| `correction` | a fix to a specific mistake Wenze made |

`renderForPrompt` emits them in that order deliberately: a model attends most to
what it read last, so the limits come after the material and the corrections
come after both. A correction was written about a real failure, so it is the
hardest thing to lose track of.

## It works with no AI at all

`readDeterministically` classifies the sentence — a "never", "do not", "must
not" makes it a boundary — picks a topic from a small keyword table, and
restates it plainly. The administrator sees a real restatement and confirms it
exactly as they otherwise would.

A model makes the restatement better and can spot which existing entry is being
replaced. It is never load-bearing, and **a claimed replacement is honoured only
when it names an entry that actually exists and is actually active** — a model
naming a plausible id would otherwise retire a fact nobody meant to touch,
silently, since only the new one would then be visible.

## What the model is told

The prompt says a person will confirm, forbids restating anything the sentence
does not say, and forbids adding numbers or conditions. It is given the existing
active entries so it can spot a replacement, and nothing else about the company.

## Confirming is one transaction

"The new rate is live" and "the old rate is no longer live" must be true at the
same instant. Between them a candidate could be quoted both or neither.
