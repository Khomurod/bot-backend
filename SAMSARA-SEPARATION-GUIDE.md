# How to Move the Samsara Feature to Its Own Home (Plain-English Guide)

This guide is written so **anyone** can follow it — no coding needed. Just click
the buttons in the order shown.

> ✅ **STATUS: DONE.** The Samsara feature has already been moved into its own
> repository (**github.com/Khomurod/samsara-integration**) and is deployed as
> its own Render service, and it has been fully removed from this main repo.
> Sections 4–5 below are kept as a record of how it was done. The parts that
> still matter day-to-day are **Section 2** (why it fixes the memory),
> **Section 3** (how the two services keep talking), and **Section 6** (turning
> off the old copy) + the **Section 8** checklist.

---

## 1. What we did, in one sentence

We took the **Samsara camera-alert feature** out of your main app so the main app
stops running out of memory, and we packaged it into one clean folder called
`samsara-integration` that you can copy into its own GitHub project and run on
its own free Render service.

Think of it like this:

- **Before:** One waiter (your main app) was trying to carry *three* heavy trays
  at once (the main bot, the leads bot, **and** the Samsara alerts). He kept
  dropping everything (running out of memory).
- **After:** The Samsara tray gets its **own waiter** (its own Render service).
  Now nobody is overloaded, and both waiters serve the **same customers**
  (the same database and the same Telegram bots), so nothing changes for the
  drivers or the office.

---

## 2. Was Samsara really the thing eating the memory? — Yes. Here's the proof.

Your main app runs on Render's **free plan**, which gives the whole app only
**512 MB of memory** (RAM). Inside that one small box, the main app was starting
**three programs at the same time**:

| Program | What it is | Roughly how much memory |
|---|---|---|
| Main hub | Your bot + website + schedulers | ~256 MB (its set limit) |
| **Samsara poller (child)** | **The Samsara camera-alert program, started *inside* the main app** | **~40 MB heap + extra program overhead** |
| Leads bot | The Facebook-leads Python program | its own chunk |

Three programs squeezed into one 512 MB box = it keeps hitting the ceiling and
Render **kills it** (this is called an "OOM kill" = Out Of Memory).

**How we know Samsara was the culprit (evidence found in your own code):**

- Your main app was literally **launching the Samsara program as a "child"**
  inside itself (in `index.js`, a function named `startSamsaraBot`). That child
  needs its own memory *on top of* the main app.
- Your settings file (`render.yaml`) even had notes your team wrote while
  fighting this exact problem — they had shrunk the main app's memory limit from
  300 MB down to 256 MB and added special memory-saving flags **"to avoid OOM
  kills,"** specifically calling out **"the spawned samsara (Node child)"** as
  the thing they had to make room for.

So the Samsara child process was the biggest extra weight we could remove from
the overloaded box. **Taking it out is the single most effective fix.**

**What we changed to fix it:** the main app no longer starts the Samsara program
inside itself. That memory is now free. The Samsara program will instead run in
its **own** box (its own Render service), where it has plenty of room.

> Note: your main app *also* uses Samsara for a **different, smaller thing** —
> showing a truck's live GPS location (city/state) for dispatch, fuel, and
> location features. That part is tiny and stays in the main app. It is **not**
> the camera-alert poller and was **not** the memory problem. We kept it working
> and it lost nothing.

---

## 3. Nothing gets lost — here's why the two halves still work together

You were worried about two features breaking. They won't. Here's the plain
explanation of **how the two apps keep talking** after the split:

They do **not** phone each other directly. They share two things, like two
roommates sharing one fridge and one mailbox:

1. **The same database** (`DATABASE_URL`). The Samsara program looks up "which
   drivers group belongs to truck #123?" in the **same database** your main app
   already uses. As long as the new service uses the **same database link**, it
   finds the right groups automatically.
2. **The same Telegram bots** (the tokens). The Samsara program uses the **same
   two bots** it always did, so messages still come from the same familiar bots.

Because of that, both features keep working exactly as before:

- ✅ **Safety/camera events still go to the Samsara notifications group.**
  (The Samsara bot sends them, same as always.)
- ✅ **The video with the friendly/funny caption still goes to the correct
  drivers group.** (It finds the group in the shared database, then posts the
  video using the main feedback bot — same as always.)

The only rule you must follow: **give the new service the SAME database link and
the SAME bot tokens** as the main app. That's it. (Section 5 shows you exactly
where to paste them.)

---

## 4. Button-by-button: put the folder into its own GitHub repository

> ✅ Already completed — the folder now lives at
> **github.com/Khomurod/samsara-integration** and is no longer in this repo.
> Kept below only as a record of how it was done.

You will do this **once**. Take your time; you can't break anything by going slow.

### Step A — Get the folder onto your computer

1. Go to your main project on GitHub: **github.com/khomurod/bot-backend**.
2. Click the green **`< > Code`** button.
3. Click **Download ZIP**.
4. On your computer, **unzip** the downloaded file (double-click it).
5. Open the unzipped folder. Inside, find the folder named **`samsara-integration`**.
   *This one folder is everything the Samsara feature needs.*

### Step B — Create the new, empty GitHub repository

1. Go to **github.com** and log in.
2. Top-right, click the **`+`** icon → **New repository**.
3. **Repository name:** type `samsara-poller` (any name is fine).
4. Choose **Private** (recommended, because it will hold secrets).
5. **Do NOT** check "Add a README" (leave the tickboxes empty).
6. Click the green **Create repository** button.
7. On the next page you'll see a link that ends in **"uploading an existing
   file"** — click that link. (Or click **Add file → Upload files**.)

### Step C — Upload the folder's contents

> Important: upload **what is INSIDE** `samsara-integration`, not the folder
> itself. The files (`index.js`, `package.json`, the `src` folder, etc.) must
> sit at the **top level** of the new repository.

1. Open the `samsara-integration` folder on your computer.
2. Select **all** the files and folders inside it (click one, then press
   **Ctrl+A** on Windows / **Cmd+A** on Mac).
3. **Drag them** onto the GitHub upload page (the big drop area).
4. **Do NOT upload the `.env` file** if you see one — it contains secrets. (We
   already set things up so it's skipped, but double-check it's not there.)
5. Scroll down, click the green **Commit changes** button.

Your new repository now holds the Samsara feature. 🎉

---

## 5. Button-by-button: run it on its own free Render service

1. Go to **render.com** and log in.
2. Click the blue **New +** button (top-right) → choose **Blueprint**.
   *(Blueprint means "read the settings file I already put in the repo.")*
3. If asked, click **Connect account / Configure GitHub** and give Render access
   to your new `samsara-poller` repository.
4. Pick the **`samsara-poller`** repository from the list.
5. Render reads the included `render.yaml` and shows a service named
   **`samsara-poller`**. Click **Apply** / **Create**.
6. Render will now ask you to fill in the secret values (environment variables).
   Fill each box below. **For the two marked ⭐, copy the EXACT same value your
   main app uses** — this is what keeps everything connected.

   | Box name | What to paste |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | The **Samsara** bot's token (e.g. @wenzesambot) |
   | ⭐ `BOT_TOKEN` | The **main feedback** bot's token (same as main app) |
   | `SAMSARA_API_KEY` | Your Samsara API key |
   | ⭐ `DATABASE_URL` | The **same** database link your main app uses |
   | `MANAGEMENT_GROUP_ID` | Same value as main app |
   | `EMPLOYEE_GROUP_ID` | Same value as main app |
   | `GROQ_API_KEY` | Your Groq key (for the funny caption) |
   | `GEMINI_API_KEY` | Your Gemini key (backup for the funny caption) |
   | `HARDCODED_GROUP_ID` | *(optional)* the Samsara notifications group id |
   | `UPSTASH_REDIS_REST_URL` | *(optional)* if you use Upstash Redis |
   | `UPSTASH_REDIS_REST_TOKEN` | *(optional)* if you use Upstash Redis |

   > 💡 Where do I find the main app's values? In Render, open your existing
   > **driver-feedback-bot** service → left menu **Environment** → copy the
   > values from there.

7. Click **Create / Deploy**.
8. Wait for the log to say it's live. To check: open the service, click the URL
   at the top, and add `/health` to the end (e.g. `https://…onrender.com/health`).
   If you see `{"status":"ok"...}`, it's running. ✅

---

## 6. Make the OLD copy stop running (fixes the `409 Conflict` error)

The Samsara program has been **completely removed** from the main app's code, so
the main app can no longer start it. You just need to **redeploy the main app**
so it picks up that cleaned-up code:

1. In Render, open your **driver-feedback-bot** service.
2. Click **Manual Deploy** (top-right) → **Deploy latest commit**.
3. Wait until it says **live**. The main app is now lighter, and the repeating
   `409 Conflict: terminated by other getUpdates request` errors in the
   Samsara service's log will **stop** (they were caused by the old copy and the
   new service both using the Samsara bot at the same time).

> Optional tidy-up on the **main** app → **Environment**: the variable
> `SAMSARA_BOT_TOKEN` is no longer used by the main app (only the new Samsara
> service needs it now), so you may delete it. Leaving it does no harm.
> **Do NOT** delete `SAMSARA_API_KEY`, `SAMSARA_API_KEYS`, `SAMSARA_API_BASE`,
> or `TELEGRAM_BOT_TOKEN` — the main app still needs those (live truck-location
> and the leads bot).

If you ever had a **second** Render service running Samsara from the *old* repo,
**delete that old one** so you don't run two copies:
1. Open that old service → **Settings** (bottom) → **Delete Service**.

---

## 7. One safety reminder about secrets 🔐

If a file named `.env` (with real passwords/keys inside) was ever uploaded to
GitHub in the past, treat those keys as "seen by others." The safe move is to
**rotate** (regenerate) them:
- New Telegram bot token: message **@BotFather** on Telegram → `/token`.
- New Samsara API key: Samsara dashboard → Settings → API Tokens.
- Then paste the new values into Render (both services where needed).

You don't have to do this to make things work — but it's the professional,
safe thing to do.

---

## 8. Quick "did it work?" checklist

- [ ] New repo created and files uploaded (Section 4).
- [ ] New Render `samsara-poller` service shows `/health` = ok (Section 5).
- [ ] Same `DATABASE_URL` and `BOT_TOKEN` used in both services (Section 5).
- [ ] Main app redeployed and no longer running out of memory (Section 6).
- [ ] A Samsara alert still appears in the Samsara notifications group.
- [ ] A safety video with the friendly caption still reaches the drivers group.

If all six are ticked, you're done — the feature is fully separated and every
part still works.
