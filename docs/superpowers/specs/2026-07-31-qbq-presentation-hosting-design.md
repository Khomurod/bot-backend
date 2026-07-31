# QBQ / SOS presentation hosting, persistent editing, and remote control

Date: 2026-07-31
Status: approved

## Goal

Host the finished SOS presentation at `/qbq`, keep its double-click editing and
Save working with edits persisted in PostgreSQL, and add a phone-friendly remote
controller at `/qbq/remote` that drives an actively open presentation in real
time.

## Non-goals

- Redesigning the deck, its slides, animations, illustrations or terminology.
- Persisting zoom beyond the live session.
- Replacing any existing local presentation control. The remote is additive.

## 1. Wording corrections

Three leaf `<p>` elements in the template, plain text, corrected in place:

| Slide | Old | New |
| --- | --- | --- |
| Opening (`data-screen-label="01"`) | `…qat’i nazar: men hozir…` | `“Muammo kimning aybi bo‘lishidan qat’i nazar, men hozir vaziyatni oldinga siljitish uchun nima qila olaman?”` |
| Thinking questions (`04`) | `Muammo ularning yomonligida emas, natijasida.` | `Muammo bu savollarning paydo bo‘lishida emas, ular bizni qanday harakatga olib borishida.` |
| Jeykob (`12`) | `Ikki oydan keyin Jeykob lavozimda ko‘tarilgan edi.` | `Ikki oy o‘tib, Jeykob lavozimga ko‘tarildi.` |

Nothing else in the deck body changes.

## 2. Serving `/qbq`

`SOS Prezentatsiya (offline v2) (1).html` stays at the repository root and
remains the **source template**. It is never rewritten by the application.

`GET /qbq` reads the template, injects a small payload before `</body>`, and
sends the result. This mirrors the existing `/presentation` route
(`server/routes/healthRoutes.js`): serving one self-contained file means a
direct hit and a refresh behave identically, so `/qbq` cannot 404 on reload.
The repository filename never appears in the public URL.

### Template surgery is limited to one marked block

The offline file ships a save-to-disk script (File System Access API /
download fallback) that is meaningless when hosted. That script — and only that
script — is wrapped in sentinels:

```html
<!-- QBQ:LOCAL-SAVE-START -->
<script> … offline save-to-file … </script>
<!-- QBQ:LOCAL-SAVE-END -->
```

The hosted route replaces the span between the sentinels with the
database-backed equivalent. The offline file opened from disk still behaves
exactly as before.

**Safety rule:** if the sentinels are not found exactly once, the route logs a
warning and serves the template unchanged rather than guessing at offsets. A
test asserts both sentinels exist exactly once, that hosted output contains the
DB-backed client, and that it does not contain the offline `showSaveFilePicker`
path.

### Injected payload

1. `<script>window.__QBQ__ = {deckKey, overrides:[…]}</script>` — inlined
   server-side from PostgreSQL so applied edits never flash. The component's
   `:host([data-fonts-pending]) .stage{opacity:0}` rule already holds paint
   until fonts resolve, so a classic (render-blocking) script placed before
   `</body>` always wins the race.
2. `<script src="/qbq/assets/qbq-edit.js">`
3. `<script src="/qbq/assets/qbq-zoom.js">`
4. `<script src="/qbq/assets/qbq-remote-link.js">`

If the database read fails, `overrides` is `[]` and the page still renders.

## 3. Persistent editing

### Identity

Editable elements are addressed by a **structural path** computed from the DOM,
so no per-element ids need to be added to the template:

```
s<slideIndex>.<childIndex>[.<childIndex>…]     e.g.  s11.0.2
```

`slideIndex` is the `<section>` position among deck slides; each `childIndex`
is the element-child position walking down to the target. The client computes
the path on save and resolves it on load. The server validates only the shape:

```
/^s\d{1,3}(\.\d{1,3}){1,16}$/
```

### Storage

```sql
CREATE TABLE IF NOT EXISTS qbq_presentation_edits (
  id                  BIGSERIAL PRIMARY KEY,
  deck_key            TEXT NOT NULL DEFAULT 'sos-offline-v2',
  element_path        TEXT NOT NULL,
  slide_index         INTEGER NOT NULL,
  content             TEXT NOT NULL,
  updated_by_admin_id INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qbq_presentation_edits_key_path
  ON qbq_presentation_edits (deck_key, element_path);
```

Additive and idempotent, delivered as forward migration `0005`. The table is
completely separate from the SOS questionnaire tables (`sos_submissions`,
`sos_settings`), so presentation edits and assessment results never mix.

Writes are one atomic `INSERT … ON CONFLICT … DO UPDATE`. There is no
delete-then-insert path, so a failed save leaves the previously saved row
untouched.

### Content policy — plain text only

The client sends `innerText`. The server strips any tags and control characters
and stores **plain text**. The client re-applies it with `textContent` and real
`<br>` nodes for newlines, never `innerHTML`. No markup ever round-trips
through the database, so stored content cannot carry script, attributes, or
event handlers.

The client refuses to save an element that has element children other than
`<br>`, with an Uzbek explanation, so a styled `<span>` inside a paragraph can
never be flattened by an accidental save on the container. Double-clicking
already targets the deepest element under the cursor, so this is the rare case.

Payload limit: 4000 characters per element, rejected with a clear error above
that.

### Authorization

- `GET /api/qbq/content` — public. Reading the presentation stays public.
- `PUT /api/qbq/content` — requires the existing `authMiddleware` plus
  `requirePermission('admin.full_access')`, the same full-admin gate every other
  admin endpoint uses.

The hosted page ships **no credentials and no tokens**. When Save is pressed
without a session, an Uzbek modal collects a username and password, posts them
to the existing `POST /api/auth/login`, and keeps the returned JWT in a
JavaScript variable for that tab only. A 401 from the save endpoint reopens the
modal. Success and failure both produce an explicit Uzbek message.

## 4. Remote control and pairing

### Transport

Server-Sent Events for server→client push, plain POST for client→server
commands. Chosen over WebSockets because it needs no new dependency, works
through Render's proxy without upgrade negotiation, and reconnects natively.
No external or paid service is involved.

### Endpoints (`/api/qbq`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/content` | public | stored overrides |
| PUT | `/content` | full admin | save one element |
| POST | `/session` | none, rate-limited | presenter opens a session, gets `sessionId`, `presenterToken`, pairing `code` |
| POST | `/pair` | none, rate-limited | remote exchanges `code` for `remoteToken` + current state |
| GET | `/stream?token=` | ephemeral token | SSE for presenter or remote; role inferred from the token |
| POST | `/state` | presenter token | presenter pushes `{slide,total,zoom}` |
| POST | `/command` | remote token | remote sends `{action,seq}` |
| POST | `/disconnect` | either token | end the remote session |

### Pairing rules

- Code: 6 characters from a 31-character unambiguous alphabet (no `0 O 1 I L`),
  about 8.9e8 combinations, drawn with rejection sampling so the distribution is
  exactly uniform.
- Code TTL 5 minutes; consumed on the first successful pair.
- Per-IP limit: 10 pair attempts per 5 minutes → HTTP 429.

There is deliberately **no per-code lockout**. An earlier draft burned a code
after five wrong guesses, but the lookup is `code → session`: a wrong guess
never resolves to a session, so the counter was unreachable dead code, and any
version that guessed which session to penalize would hand an attacker a way to
knock out a real presenter's pairing from across the internet. The defenses that
do the work are entropy, the moving 5-minute target, single use, and the per-IP
limit.
- Session tokens are 32 random bytes, ephemeral, and expire with the session
  (6 hours idle). They are never logged, and neither are pairing codes or
  presentation text.
- Tokens appear in the SSE query string because `EventSource` cannot set
  headers. They are short-lived session tokens, not permanent secrets, and the
  route never logs request query strings.
- Each presenter session is independent. Creating a new session never binds to
  an existing one, and a consumed or expired code cannot control anything.

Session state (codes, tokens, current slide/zoom, connected streams) lives in
process memory. It is genuinely ephemeral by requirement — only presentation
*edits* need durable storage, and those are in PostgreSQL.

### Command integrity

The remote stamps each tap with a monotonically increasing `seq`. The server
ignores any command whose `seq` is not greater than the last one seen for that
remote and answers `{applied:false}`, so a retry can never double-advance. The
forwarded command carries a server-assigned `commandId` that the presenter also
de-duplicates. One tap always equals exactly one slide of movement, regardless
of tap speed.

Commands are applied through the component's public API — `stage.next()`,
`stage.prev()`, `stage.goTo()` — which is the same central state keyboard
arrows, the overlay buttons and the slide rail already drive. The presenter
subscribes to the component's `slidechange` event and posts state back, so
navigating locally updates the remote.

On stream connect the server immediately sends a state snapshot, so a
reconnecting or refreshed remote shows the presenter's current slide. The
remote keeps `{sessionId, remoteToken}` in `sessionStorage` purely to survive
its own refresh. A disconnected remote stops sending commands.

## 5. Zoom

`DeckStage.prototype._fit` computes `scale = min(vw/1920, vh/1080)` and writes
it to a shadow-DOM canvas whose `transform-origin` is `center center` inside a
centered flexbox with `overflow:hidden` on the host. The hosted script wraps
that prototype method and multiplies the computed scale by the current zoom
factor. Centering, 16:9 and clipping therefore come out correct with no CSS
changes and no edits to the generated component.

Re-application is triggered with a plain `window` `resize` event, so no private
method is ever called directly.

- Range 60%–160%, 10% steps; reset returns to 100% (exact fit).
- The factor lives in a module variable, so entering or leaving fullscreen
  re-runs `_fit` and preserves the chosen zoom.
- Slide layouts, font sizes and element positions are never modified — only the
  single canvas transform.
- Session-scoped; not persisted after the live session.

## 6. Files

New:

- `database/migrations/0005_qbq_presentation_edits.sql`
- `database/qbqPresentation.js`
- `services/qbq/sanitizeEditableText.js`
- `services/qbq/elementPath.js`
- `services/qbq/remoteSessions.js`
- `server/routes/qbqRoutes.js`
- `server/qbq/template.js`
- `server/qbq/public/qbq-edit.js`
- `server/qbq/public/qbq-zoom.js`
- `server/qbq/public/qbq-remote-link.js`
- `server/qbq/public/remote.html`
- tests under `tests/`

Modified:

- `SOS Prezentatsiya (offline v2) (1).html` — three wordings, two sentinels
- `server/api.js` — one mount, after the feature routers and before the SPA
  catch-all so `/admin`, `/questions`, `/answers`, `/dispatch`, `/raise`,
  `/recruiters` and every `/api/*` route keep their current behavior

Every new file stays under the 500-line limit from `CLAUDE.md`.

## 7. Testing

- **Hosting** — `/qbq` and `/qbq/remote` return 200 HTML, refresh is identical,
  assets resolve, and the existing route inventory is unchanged.
- **Editing** — full admin can save; anonymous and non-full-admin cannot;
  malformed element paths are rejected; markup and scripts are stripped; a saved
  change appears in a fresh `/qbq` render; a rejected save leaves the prior row
  intact; the hosted document still contains the double-click handler and Save
  button.
- **Remote** — two concurrent real clients (presenter SSE + remote POST) against
  a live ephemeral server: pair, prev, next, zoom in/out, reset, two-way slide
  and zoom sync, local keyboard navigation reflected on the remote, invalid code
  rejected, expired session rejected, reconnect restores state, repeated `seq`
  does not double-navigate.
- **Regression** — 28 slides present, three corrected wordings present,
  fullscreen control, animation attributes and speaker notes intact.

Browser-level confirmation of double-click → edit → Save → refresh, zoom,
fullscreen and responsive behavior is done by driving the real page, since the
repository has no browser-automation dependency and adding one is out of scope.

## 8. Known limitations

- Remote session state is per process. If the Render service restarts or is
  scaled to more than one instance, live remotes must re-pair. Saved edits are
  unaffected — they are in PostgreSQL.
- Editing a container element that holds styled children is refused rather than
  flattened; the presenter edits the styled child directly instead.
