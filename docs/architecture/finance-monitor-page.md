# The Finance page — the one place the text is read out

> Part of [`finance-monitor.md`](finance-monitor.md), split out when the parent
> reached the 500-line cap. Read that first: it owns the capture rules, the
> reader, the weekly summary and the invariants this page is built on.

Everything else in this feature answers with **counts**: the settings screen,
the `/api/health` block, the weekly report. `server/routes/financeRoutes.js`
and `admin/src/pages/FinancePage.jsx` are the exception, and they are the
exception on purpose — a person reconciling money codes has to see the message,
and the alternative is the scrolling this whole feature exists to replace.

So the surface is narrow and guarded:

- **`authMiddleware` on every route**, and an unauthenticated call is refused
  before it reaches the database — not "401 after querying".
- **Nothing writes a business value.** The three actions re-run machinery that
  already exists, and none takes an amount, a code or a status from the
  caller. A structural test asserts the router contains no `UPDATE`, no
  `INSERT` and no `req.body` at all.
- **The Telegram link is built server-side** from the stored chat and message
  ids, never accepted from the client, and is `null` for a chat Telegram has no
  link shape for. A broken link on a payments screen is worse than none.
- **`file_id` never leaves the database**, and neither does a download URL —
  that one carries the bot token.
- A caller cannot ask for the whole table: the limit is clamped.

### The three actions

**Read it again** re-runs the *current* parser over the stored text. This is
what makes "capture first, codify second" a workflow rather than a slogan — the
text was kept verbatim precisely so a tightened parser could be run over it.
`tests/financePagePg.test.js` proves the message is byte-identical afterwards
by re-reading with a deliberately different parser.

**It goes through the capture service, not straight to the table.** The first
version updated `finance_messages.parse_status` and stopped: the message left
the unclear pile, the screen said it had worked, and the Money codes tab and
every weekly total were exactly as wrong as before, because nothing had written
`finance_moneycodes`. `services/finance/captureService.reparseCapturedMessage`
is the caller, and it records the code through **the same duplicate decision a
live capture uses** — the settings window and `decideDuplicate`, not a second
copy of that logic.

Two rules inside it:

- **`recordMoneycode` stays strictly "record it if it is not there."** A repeat
  returns null, a test pins that, and that idempotency is what makes a
  redelivery harmless.
- **A code already recorded follows the fresher reading**, through the separate
  `updateMoneycodeInterpretation`. A tightened parser can legitimately reach a
  different amount, and leaving the old one beside a corrected parse would make
  the Money codes tab disagree with the message it came from. The event's own
  facts — who posted it, when — are never touched: those describe the event, not
  the reading of it.
- **Recording is best-effort.** The re-read itself succeeded; reporting it as a
  failure would invite a retry of something already done. The result says
  whether the code landed, so the screen can be honest.

**Try again** puts a document back in the queue, **resets the attempt ladder**
— because a person asking for a retry is new information the backoff does not
have — and **pokes the reader**, exactly as capture does. After an empty drain
the queue scheduler holds no retry timer, only the 15-minute idle sweep, so
without the poke a row made due right now sits untouched for a quarter of an
hour while the screen promises it will be read within a few minutes. It is offered only for `failed` and the two `skipped_*` states —
never for `needs_review`, where running the same reader over the same bytes
reaches the same place. That one is not a button that does nothing; it is no
button at all.

**Send the weekly summary now** is a person's deliberate act, and two rules keep
it from quietly replacing the scheduled report:

- **it never touches the claim**, and the row it writes is `manual`. The
  once-a-period rule exists to stop a restart re-sending Monday's report; it is
  not there to argue with somebody who pressed a button. The partial unique
  index covers `status <> 'manual'`, so a manual send can neither collide with
  the scheduled row nor stand in for it, and Monday still goes out.
  `tests/financeWeeklyReportService.test.js` sends by hand and then runs the
  scheduled tick for the same week, and asserts both went.
- **the switches are not consulted.** Only the two things that make sending
  impossible can refuse — no chat, or no Telegram — and each says which, as a
  400 carrying the reason rather than a 500 that sends somebody to the logs.
- **a send that could not be RECORDED is still a send.** If Telegram accepts the
  message and only the row fails, calling that "could not send" would put a Try
  again in front of somebody for a summary already in the chat — and with no
  claim and no request key, they would send it twice. The result carries
  `recorded: false` and the screen says so.

Sending is the one thing here that cannot be undone, which is why it is also
the one thing that asks for confirmation first.

**Preview** is the same composition with the send removed: no chat, no row. It
is what answers "is this worth switching on" without switching it on. The screen
shows the composed body **as text, never as markup** — the body is built from
what people typed in the finance group, and the composer escapes every dynamic
part, but a page that rendered it would be trusting that escaping from the far
side of an API.

### Four tabs, one boundary below the tab bar

Each tab is lazy, and the `PageErrorBoundary` sits **below** the tab bar, keyed
on the tab. Only the active tab is mounted, so one boundary is enough — and
because the bar is outside it, one tab throwing cannot blank the others: the
point of the page is that somebody can get at the money codes, and a boundary
wrapped around the WHOLE page loses all four because one table hit a bad row.
Removing the boundary fails that test.

The Messages tab opens on **Unclear**, not on everything: the provisional
parser is tightened from exactly that pile, and a list that opens on four
thousand ordinary messages hides the twenty that matter.
