# Trinity Agro FarmFlow

A simple internal web app for logging compost batch data through the full cycle —
Pre-Wetting (recipe + soaking), Phase I Composting, Phase II (Pasteurization &
Conditioning), Spawning, Casing Soil Preparation, Room In, Harvest, and Room Out.
Each stage is its own page; department heads enter data for their stage, and
parameters outside the configured QC range are flagged automatically, with a
standard-vs-actual comparison for the whole batch.

## Running it

Requires [Node.js](https://nodejs.org) **22 LTS** ("Jod"). Node 24 currently causes
the server to crash intermittently under load — the `better-sqlite3` native
database driver hits a garbage-collection bug specific to that Node version. If
you reinstall Node, install v22, not the newest release.

```bash
npm install
npm start
```

Then open http://localhost:4000 in a browser. On the local network, other computers
can reach it at `http://<this-machine's-IP>:4000`.

Data is stored in a single SQLite file at
`~/Library/Application Support/TrinityAgroBatchTracker/trinity-agro.db` (the
folder keeps the app's earlier name, Batch Tracker, so existing data is still
found) — **not**
inside this project folder. That's intentional: cloud-sync services (OneDrive,
Dropbox, Google Drive, etc.) corrupt or crash SQLite databases in WAL mode because
they intercept file locking in ways SQLite doesn't expect, so the live database
stays local no matter where this project folder itself lives. You can override its
location with the `TRINITY_DATA_DIR` environment variable if needed.

### Backups

The app backs itself up automatically: one snapshot when the server starts (skipped
if a backup was already taken in the last 15 minutes, so restarting repeatedly
doesn't flush your history) and one per day while it's running. Snapshots go to
`<data dir>/backups/`, and the most recent **30** are kept — set
`TRINITY_BACKUP_KEEP` to change that. They use SQLite's online-backup API, so
taking one while people are entering data is safe.

**Settings → Backups** lists every snapshot, has a *Back Up Now* button (worth
using before anything risky — bulk edits, deleting a batch, wiping training data),
and lets you download any snapshot.

These snapshots sit next to the live database, so they protect against mistakes
made *inside* the app — not against losing this Mac. Periodically download one, or
copy the `backups/` folder to a synced/external location. Copy the **backup** files,
never the live `trinity-agro.db`, which cloud sync will corrupt while it's in use.

To restore: stop the server, replace `trinity-agro.db` with a backup (deleting any
`-wal` and `-shm` files beside it), and start again.

## What's in it

- **Dashboard** — list of all batches, current stage, status.
- **Log Harvest** (`/harvest-log`) — a fast, cross-batch entry point for harvest
  picks: pick a room from a dropdown of every room currently occupied (across
  *all* in-progress batches at once — useful when pickers are harvesting
  several rooms/batches the same day), enter A/B grade kg, done. Writes to the
  same data as that batch's own Harvest page; a "Today's Entries" list below
  the form shows what's already been logged today with a delete-if-mistaken
  option. Use a batch's own Harvest page instead when you need its per-room
  history or are ready for Room Out.
- **New Batch** — batch code is `TAPL-NepaliFiscalYear-YourNumber`
  (e.g. `TAPL-2083/84-001`). The fiscal year (Shrawan–Ashadh) is computed
  automatically from the start date using the Bikram Sambat calendar; you choose
  the trailing number, which just needs to be unique within that fiscal year.
  Note: batches created before this format was added (e.g. `2026-001`) keep their
  original codes — only new batches use the new format.
- **Raw Materials** (master list) — name, landed cost per kg (NPR), standard
  Carbon %/Nitrogen % (dry basis), notes, active toggle. These are the dropdown
  choices and defaults used when building a batch's recipe. Editing or
  deactivating a material here never changes costs/percentages already recorded
  on past batches — those are snapshotted at the time each recipe line was added.
- **Running the compost unit as a separate operation** — when compost is made
  on a different site under its own management, each unit gets its own
  workspace and its own batches, joined by a delivery record:
  - A **Compost Unit** batch runs Pre-Wetting → Phase I → Phase II → Spawning →
    **Dispatch**, and a **Growing Unit** batch runs **Compost Receipt** →
    Casing → Room In → Harvest → Room Out. Neither side can open the other's
    batches; Admin and Farm Manager have both workspaces and can switch.
  - **Dispatch** records compost leaving: date, kg, and whether it's going to
    your own growing unit or being sold to another farm (buyer name and
    quantity only — no sale value, matching the rest of the app). One compost
    batch can have several deliveries; the screens currently allow one delivery
    per growing batch, which is a UI limit rather than a structural one.
  - Each delivery **freezes a compost spec sheet** at dispatch — C:N ratio,
    Phase I averages, pasteurisation temperature and hold, conditioning temp
    and ammonia, final moisture, spawn strain and rate, compost temperature at
    spawning, and any QC flags raised in production. That sheet is what the
    growing team sees on receipt, and it's the only thing that crosses between
    the two workspaces. It's a snapshot, not a live lookup, so it describes the
    compost as it left rather than as the compost batch reads months later.
  - **Cost travels with the compost**, by weight: 8,000 kg out of a 12,000 kg
    batch carries two-thirds of that batch's raw material cost. That's what
    keeps the growing unit's A-Grade Efficiency Ratio meaningful once it no
    longer has a recipe of its own.
  - Batches recorded **before** the split keep the original end-to-end pipeline
    and stay readable exactly as entered — they aren't retro-fitted into the
    new shape.
- **C:N, nitrogen and ash through the process** — there are two C:N figures,
  and they are deliberately never shown under the same name:
  - **Recipe C:N (calculated)** comes from what went in, weighted by dry matter
    (target 25–35:1). It's a starting point, not a verdict on the compost.
  - **C:N at end of Phase II (measured)** is a lab result on the finished
    compost (target 15–20:1). It can't be calculated — it shows how much carbon
    the microbes actually burned off, which no recipe predicts. Above ~20 means
    composting ran short and the compost will keep working after spawning,
    feeding weed moulds; below ~15 means over-composted and yield lost.
  
  The Phase I and Phase II pages each have a **Lab Analysis** panel for the
  measured C:N, nitrogen % and ash %. Results often come back after spawning,
  so they're a quality record rather than a go/no-go gate — ammonia clearance
  is still the real-time readiness signal.

  **Ash** is recorded per raw material (standard + per-delivery actual) and
  gives a calculated recipe ash %. Because minerals don't burn off, the rise in
  ash between checkpoints gives **dry matter loss** — `1 − (ash before ÷ ash
  after)` — per phase and in total: a direct read on how hard the compost was
  worked. The Phase I→II figure uses two lab measurements; anything starting
  from the recipe uses a calculated ash, so it's shown as indicative. Ash also
  reveals gypsum mixed into manure, which reads far higher in ash than manure
  alone.

  Targets are only seeded where there's a sound general basis for one. Ash
  (heavily recipe-dependent) and the end-of-Phase-I figures start with **no
  target**: they're recorded and shown, never flagged, until you set a standard
  in QC Settings. A value with no target shows "Recorded", not a green OK — a
  badge would imply it passed a check that doesn't exist.

  The dispatch **spec sheet** leads with the measured finished-compost figures,
  since that's what a grower needs, and shows the recipe C:N underneath under
  its own name. If the lab result isn't in when compost is dispatched, the
  growing team sees "Awaiting lab result" rather than a blank.
- **Departments** — within a single-site workspace, the pipeline is split in two: **Compost Dept** owns
  Pre-Wetting, Phase I, Phase II and Spawning; **Growing Dept** owns Casing,
  Room In, Harvest and Room Out. Everyone logged in can *view* every stage of
  every batch (full traceability — compost staff can see how their compost
  actually yielded), but only the owning department can *save* a stage. Stages
  outside your department show a 🔒 on the tab, a "View only" banner, and greyed
  controls; the block is enforced server-side on every save, so the greying is
  just so nobody clicks a button that would bounce. Admin and Farm Manager can
  edit everything. The Dashboard has a Compost/Growing filter to show only the
  batches currently sitting in your half of the pipeline.
- **Settings** — one tab grouping the configuration areas, with sub-tabs across
  the top: **QC Parameters**, **Farm Master Data**, **Users & Roles**, and
  **Farms & Training**. Which sub-tabs appear depends on the logged-in user's role.
- **Farms & training data** — a *farm* is a workspace that batches belong to.
  Two ship by default: your live farm, and a **Training / Practice** farm for
  onboarding and experimentation. Training batches never appear on the real
  farm's Dashboard, Reports, or CSV exports, and can't even be reached by
  typing their URL — the whole app is scoped to the farm picked in the header
  dropdown. While you're in a training farm the page turns amber and shows a
  "TRAINING DATA" badge so practice data is never mistaken for real. Batch
  codes carry the farm's own prefix (`TAPL-…` vs `TRAIN-…`), so the same batch
  number can be used for practice without ever colliding with production.
  Settings → Farms & Training has a **wipe** button that clears a training
  farm completely (requires typing `RESET`); it is hard-wired to refuse any
  farm not flagged as training, so it cannot touch live data. Rooms, tunnels,
  bunkers, raw materials and QC ranges are deliberately shared company-wide —
  training runs against your real room codes and real QC targets, which is the
  point. Users are granted access per farm, so a trainee can be given the
  Training farm only and never reach production data.
- **Fiscal years are a filter, not a separate ledger.** There is no "open a new
  financial year" step — every batch already carries its Nepali FY (derived
  from its start date), so Dashboard and Reports both offer an FY selector, and
  Reports adds a **Fiscal Year Comparison** table (batches, cost, harvest kg,
  avg yield %, avg A grade %, avg efficiency, QC flags — per year, newest
  first). Keeping years in one place is what makes year-over-year comparison
  possible; closing off a year the way accounting software does would prevent it.
- **Farm Master Data** (under Settings) — the fixed inventory of Growing Rooms,
  Tunnels, and Bunkers, each a short code (e.g. `GR1`, `T1`, `B1`) plus an
  optional name/notes. These codes are what the dropdowns on Phase I (bunker),
  Phase II (tunnel), Spawning/Casing (room), and Room In (room) offer — no more
  free-typing a room/tunnel/bunker and risking a typo that breaks matching.
  Deactivating an entry removes it from the dropdown for new entries but never
  touches what's already recorded on past batches; if a batch's saved value
  doesn't match any active code (older data, or before a code existed) the
  dropdown still shows it, tagged "(not in master list)", instead of silently
  blanking it out.
- **Batch Overview** (`/batches/:id`) — a hub page per batch: every stage listed
  with its status (Done / In Progress / Not started), key date, day-count, and
  a **QC Flags** count per stage; a full **standard-vs-actual** table for every
  tracked parameter on the batch; and a batch-economics summary (raw material
  cost, total harvest, A-Grade Efficiency Ratio). Click through to any stage's
  own page from here, or use the tab bar on every stage page.
- **Each stage is its own page**, reachable from the tab bar on any batch page:
  1. **Pre-Wetting** — shows the raw material recipe entered when the batch was
     created (material, dry kg, cost/kg, amount, Carbon %/Nitrogen %, batch C:N
     ratio) read-only except for removing a mistaken line — recipe entry only
     happens on the New Batch page, not here — plus the in date/out date/days
     for the soak itself.
  2. **Phase I Composting (Bunker)** — bunker no., planned turns, start/end
     date and days; a turn log capturing bunker no., temperature/moisture/pH
     before each turn, with a chart
  3. **Phase II** — Pasteurization & Conditioning tunnel readings, chart;
     fill/end date and days
  4. **Spawning** — spawning date, spawn run end date, days, no. of bags, kg/bag,
     with total fill weight calculated automatically
  5. **Casing Soil Preparation** — material mix, chalk/lime, pH, moisture,
     pasteurization, layer thickness; application/end date and days
  6. **Room In** — one row per growing room (room no., room-in date)
  7. **Harvest** — per room, a picking log (date, A grade kg, B grade kg).
     Come back to this page repeatedly as flushes happen over the cropping cycle.
  8. **Room Out** — per room: room-out date + days in room, compost fill weight,
     and auto-calculated **Yield %** (total harvest ÷ compost weight) and
     **A Grade Yield %** (A grade ÷ compost weight), a room summary (allocated
     cost, A-Grade Efficiency Ratio), and an on-demand **Performance Analysis**
     — compares this room's yield and parameters against your other completed
     batches and against QC targets, and suggests what to look at next. Uses
     Claude when `ANTHROPIC_API_KEY` is set in the environment (see below);
     otherwise falls back to a deterministic rule-based analysis — always
     works, no API key required.
  Every stage's summary form has a checkbox that advances the batch to the next
  stage and jumps you straight to that page.
- **QC Parameters** (under Settings) — the min/max range for each tracked parameter (batch C:N ratio,
  pile temperature, pH, pasteurization temp/duration, ammonia, spawn rate, casing
  pH/moisture/layer thickness, etc). The seeded defaults are typical starting
  points for button mushroom compost/casing — **adjust them to match your own
  SOP**; that's what actually drives the OK/LOW/HIGH flags and the QC Flags
  counts shown on the Dashboard and every batch page.
- **A-Grade Efficiency Ratio** — total A-grade kg harvested ÷ raw material cost,
  shown as kg of A-grade mushroom per NPR 1,000 spent. This is the app's cost
  metric — there's no revenue/sales-price tracking; it only ever compares
  output against what the compost recipe cost.
- **Reports** (`/reports`) — cross-batch comparison table (cost, compost kg,
  harvest kg, yield %, A grade %, A-Grade Efficiency Ratio, QC flag count),
  sortable by any column, with a fleet summary and a downloadable CSV of the
  whole comparison. The "Why Yield Varies Across Batches" panel finds your
  best- and worst-performing batches and, for each tracked parameter, compares
  the average yield of batches that stayed in its QC range vs. those that
  didn't — same Claude-or-rules analysis engine as the Room Out page.
- **CSV export** — per-batch export button for record-keeping, including the full
  raw material recipe, every stage's data, rooms, harvests, and computed totals.

## On a phone (supervisors)

The same app works on Android phones — there's no separate app to build or
publish. Supervisors open the live URL in Chrome and install it:

1. Open the app's URL in **Chrome** on the phone and log in.
2. Tap **⋮** (top right) → **Add to Home screen** / **Install app**.
3. A Trinity Agro icon appears on the home screen. It opens full-screen,
   straight to **Today**, and stays logged in for 30 days.

What changes on a small screen (a desktop browser looks the same as before):

- **Today** (`/today`, also in the top menu) — the supervisor's home screen.
  Lists only the batches in the current workspace that are at a stage *their
  role* can enter, each with one button to the entry form: Phase I → log a
  turn reading, Phase II → log a tunnel reading, one Harvest card for every
  occupied room (with kg picked today), and every other stage → open its page.
  In a growing unit it also lists compost the compost unit has dispatched but
  nobody has received yet, with a button to start the growing batch for it.
- **Phase I / Phase II** — on a phone the reading form comes first, then the
  reading history, then the stage summary. The form is pre-filled with
  today's date, the next turn number, the batch's bunker and the person's own
  name, and shows a "Saved" confirmation after each reading.
- **Log Harvest** — confirms each pick after saving and remembers the flush
  chosen, since several rooms are usually logged in the same flush.
- Navigation folds under a **Menu** button, stage tabs become one sideways
  strip, wide tables scroll sideways inside their card, and Export/Delete on a
  batch sit under **More** so they can't be tapped by accident.

The app is installable because of `public/manifest.json` and a service worker
(`public/sw.js`). The service worker deliberately caches **no** pages or
data, so nobody ever sees stale readings — it only keeps a small "No internet
connection" page to show when signal drops. Signal is needed to use the app.

**Dates follow the farm's clock.** "Today" (default reading/harvest dates, the
Today screen) is calculated in Nepal time (`Asia/Kathmandu`), not the cloud
server's UTC — otherwise anything logged before 5:45am would get yesterday's
date. Set `TRINITY_TZ` to override.

## AI performance analysis (optional)

The Room Out and Reports pages can generate a natural-language performance
analysis using Claude. This is **optional** — without any setup, both pages
generate a solid rule-based analysis instead (out-of-QC-range parameters with
plain-language explanations, and yield comparisons against your other
batches). To upgrade to Claude-written analysis, set an API key before
starting the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Get a key at [console.anthropic.com](https://console.anthropic.com). This is a
paid API (small cost per analysis) and requires internet access from the
machine running the server — everything else in this app works fully offline.
If the key is missing, invalid, or the request fails for any reason, the app
silently falls back to the rule-based analysis; nothing breaks either way.

## Deploying for team access off the farm network

Running it locally (`npm start`, reachable on the farm WiFi at this machine's
IP) is enough if everyone using it is on-site. For access from anywhere —
someone checking in from home, a phone on mobile data — move it to a small
cloud host. No code changes are needed; only configuration.

**Recommended: [Railway](https://railway.app)** (~$5/month). Straightforward
for a small Node + SQLite app like this one, and gives you HTTPS and a public
URL automatically. [Render](https://render.com) works the same way if you'd
rather use that.

1. **Push this repo to GitHub** (Railway deploys from a GitHub repo):
   ```bash
   git remote add origin <your-empty-github-repo-url>
   git push -u origin main
   ```
2. **Create a Railway project** from that GitHub repo (railway.app → New
   Project → Deploy from GitHub repo). When it asks about the builder, pick
   **Nixpacks** (Railway's default Node auto-detection) rather than the
   `Dockerfile` in this repo — the Dockerfile is here for self-hosting
   elsewhere (a VPS, Render's Docker option) but hasn't been build-tested on
   Railway specifically, and Nixpacks is the well-worn path for a plain Node
   app like this.
3. **Add a Volume** (Railway project → your service → Variables/Volumes tab)
   and mount it at `/data`. Without this, the database lives on the
   container's disk and is wiped on every redeploy.
4. **Set environment variables** on the service:
   - `TRINITY_DATA_DIR=/data` — points the database and backups at the volume
     you just mounted. Required; without it the app falls back to a path
     that doesn't persist on this platform.
   - `NODE_ENV=production` — enables the secure-cookie flag now that traffic
     is over HTTPS.
   - `ANTHROPIC_API_KEY=...` — optional, only if you want the AI performance
     analysis feature (see below).
   - Railway sets `PORT` itself; nothing to do there.
5. **Deploy**, then open the Railway-provided URL. It lands on the same
   first-run **Set Up the Admin Account** page as a fresh local install — no
   old data carries over automatically (a from-scratch start was the choice
   made when this was set up; see git history / ask if you want a past
   database migrated across later).
6. **Custom domain (optional)**: Railway → Settings → Domains, point your own
   domain or subdomain at it if you don't want the `*.up.railway.app` URL.

## Notes on this version

- Runs as a single Node process with one SQLite file. That's genuinely fine at
  this scale (a handful of concurrent users, modest write volume) — no need
  for a "real" database server.
