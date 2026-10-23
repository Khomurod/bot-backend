# Employee birthday cards and Company Employees

> Read this before changing `services/employeeBirthdayWishService.js`,
> `services/employees/`, `database/companyEmployees.js`, `assets/birthday/`,
> the employee columns of `employee_birthdays` (migration 0084), or the admin's
> Users → Company Employees tab.

## What the owner asked for (23 October 2026)

On an employee's birthday the bot posts **one post per employee** to the
employee group (`EMPLOYEE_GROUP_ID`):

- **a card in the company's own template** — the logo, "Happy Birthday", the
  employee's photo in the frame, their **full first name** from the staff list
  ("Testbek", never a short form) in white, their **American name** ("Sam
  Example") in grey under it, and "WENZE TEAM";
- **the owner's fixed caption, word for word**, tagging the employee:

  ```
  Dear @username,

  Wishing you all the best that life has to offer.
  Together, we grow stronger and achieve more!
  ```

**No model writes or varies the caption.** The AI birthday message
(`services/employeeBirthdayMessage.js`, capability `employee_birthday_message`)
and its "AI instructions" / "fallback template" settings were removed. The two
columns stay in `employee_birthday_settings` with their defaults and are not
read; dropping a column is not additive.

## The card

`services/employees/birthdayCard.js` draws it with `sharp`:

- `assets/birthday/card-background.jpg` is the owner's template with the photo
  frame and the two name lines cleared. It contains no person.
- The names are drawn in `assets/fonts/LiberationSerif-Bold.ttf` (SIL OFL,
  licence beside it), handed to Pango **by file**: the production image
  (`node:20-bookworm-slim`) has no system fonts, so asking for a family name
  alone would draw boxes or nothing.
- A name too wide for the panel is shrunk, never cut off.
- **No photo:** the frame shows the employee's initials. A missing photo never
  stops a birthday from being posted. A stored photo that no longer decodes is
  treated the same way, so a broken file cannot make the scheduler retry all
  day.
- The first name is title-cased from the list (kept in capitals), and only the
  first letter of each word is raised: `O'RTOQBOY` → `O'rtoqboy`.

## The tag

`services/employees/birthdayText.js`, through `services/telegramMention.js`:
`@username` when there is one, else an inline mention by numeric id
(`tg://user?id=`), else the American name (or the first name) as plain text —
never broken markup.

## Exactly once per employee per day

The scheduled pass and "Send today's wishes now" claim
`service_runs('birthday', 'employee:<day>:<id>')` before posting each card and
release it if the post fails. Two overlapping passes therefore never post the
same card twice, and a failure is retried on the scheduler's fast cadence
**without re-posting the cards that already went out**. `employee:<day>` is
written only by a pass that posted every card for the day itself (a card
another pass is still posting may yet fail and need the retry); the hourly tick
skips the day on that one read. "Congratulate selected" claims nothing — it is a deliberate
manual re-post.

## Company Employees (Users page)

The Users page's old **Dispatchers** filter read `bot_users.source`, which
nothing fills in, so it was always empty. It is now **Company Employees**: every
row of `employee_birthdays`, with the American name, the Telegram account
(username and/or user ID), the photo, and a **Card** preview drawn exactly as it
would be posted (rendered, never sent). Names, birthdays, adding and removing
employees stay on the Birthdays page. API: `/api/company-employees`,
`admin.full_access`.

**Photos** are uploaded there (JPG, PNG or WEBP, at most 10 MB), re-encoded to
an 800 × 800 JPEG cropped to keep the face, and stored in `employee_photos` — a
table of their own, so the employee list never reads the bytes. **Photos and
real names are never committed to the repository.**

## Which Telegram account is whose — a suggestion, never a decision

The owner: "try to guess them from the Telegram users we already have; the ones
you can't guess, or get wrong, I will fill in." **Suggest Telegram accounts**
(`services/employees/telegramMatch.js`) matches employees against the accounts
the bot has seen (`bot_users` + `group_members`, bots left out):

- **never on a username** — a username can be changed and re-claimed
  ([`telegram-identity.md`](telegram-identity.md)); only the display name is
  compared;
- the display name is split at `|` and `/` and job words are dropped
  ("Tess Example | Dispatch" → *tess example*);
- **strong:** every word of a two-word American name in one part;
  **weak:** a one-word American name, or the Uzbek first name, as the first word
  of a part;
- a suggestion only when exactly **one** account matches at the employee's best
  level and that account is picked by exactly **one** employee — two people
  called Quinn suggest nothing.

A match is stored as `telegram_match = 'suggested'` and shown as **Suggested —
check**. **Confirm**, or saving the row, makes it `confirmed`; a suggestion pass
never overwrites a confirmed account and never offers one to somebody else.
Suggested accounts are tagged on the birthday as they stand — the owner chose
to correct wrong ones rather than to approve each one first.

## Tests

`tests/employeeBirthdayText.test.js` (the fixed caption, the tag, the names),
`tests/employeeTelegramMatch.test.js` (strict matching, never on a username),
`tests/employeeBirthdayCard.test.js` (the real card: size, photo in the frame,
the placeholder, a long name), `tests/employeeBirthdayWishService.test.js` (one
card per employee, the per-employee claim, a failed card retried alone, an
unreadable photo), `tests/companyEmployeesRoutes.test.js`,
`tests/companyEmployeesPg.test.js` (a suggestion never overwrites a person; the
list never reads photo bytes; a photo goes with its employee — requires
`TEST_DATABASE_URL`), `admin/src/pages/users/CompanyEmployeesTab.test.jsx`.
