# Pulse · Fitness Tracker

A simple, polished, **mobile-first** gym & fitness tracker that runs **entirely in your browser**. Built with plain **HTML, CSS and JavaScript** — no frameworks, no build step, no backend, no paid services. Optimised for iPhone, works great on Android, tablets and desktop.

All of your data stays **on your device**. You own it. Move it between devices with the built-in **Export / Import backup**.

---

## ✨ Features

- **Dashboard** — current week number, days completed, total workouts, progress %, smart reminders, and quick actions.
- **Weekly logic (Mon → Sun)** — the day cycle resets every Monday. Each week is independent; the app never auto-continues last week's day.
- **Workout templates** — Day 1–4 preloaded and fully **editable** (permanent).
- **Workout session flow** — pick date → choose day (or *Other*) → load → track → save.
- **Exercise tracking** — edit name, sets, reps, weight and notes per exercise.
- **Exercise images / GIFs** — every exercise shows a colour-coded movement icon by default (legs, glutes, core, push, pull, arms, calves, cardio). Tap the thumbnail to attach **your own photo or GIF** (uploaded locally, or via a link) so you can recognise the movement at a glance. The image is keyed by exercise name and **reused everywhere** that exercise appears, and is included in backups.
- **Progression** — starting / previous / current / personal best / total change, with lightweight charts.
- **Other activities** — walk, run, hike, yoga, swim… counted as activity but **excluded** from the day cycle.
- **History** — filter by week / month / type / exercise.
- **Progress photos & videos** — 4-week reminder, first-vs-latest comparison, swipeable viewer.
- **Body measurements** — weight, waist, hips, thighs, calves, arms, body-fat %, with charts.
- **Personal records** — automatically detects your heaviest lift per exercise.
- **Light / Dark / Auto** themes, large tap targets, smooth animations, safe-area aware (notch / home bar).
- **Installable PWA** with offline support (service worker).

---

## 🚀 Run it

It's a static site — just serve the folder.

**Locally (any one of these):**
```bash
# Python 3
python3 -m http.server 8000

# Node
npx serve .
```
Then open `http://localhost:8000`.

> Open via `http://` (not `file://`) so IndexedDB, the service worker and media storage all work normally.

**On iPhone:** open the URL in Safari → Share → **Add to Home Screen** for a full-screen, app-like experience (and more durable storage).

---

## ☁️ Deploy for free

Drop these files at the root of any static host:

- **GitHub Pages** — push to a repo, enable Pages on the branch/root.
- **Netlify** — drag-and-drop the folder, or connect the repo (no build command, publish dir = `/`).
- **Cloudflare Pages** — connect the repo (build command: none, output dir = `/`).

No environment variables, no server, no database.

---

## 🏗️ Architecture

```
fitness-tracker/
├── index.html              # App shell: views, tab bar, modal/toast roots, iOS meta
├── style.css               # Design system (CSS variables), light/dark, mobile-first
├── data.js                 # Default templates + storage layer (localStorage + IndexedDB)
├── app.js                  # State, router, view renderers, modals, stats, SVG charts
├── sw.js                   # Service worker (offline app shell)
├── manifest.webmanifest    # PWA metadata
├── assets/
│   └── icon.svg            # App icon
└── README.md
```

- **No framework.** Everything lives in a single `window.FT` namespace.
- **Rendering**: views are HTML strings injected into `#view`.
- **Interactions**: one delegated event handler dispatches on `data-action` attributes — lightweight and easy to extend.
- **Persistence is fully abstracted** behind `FT.Store` (structured JSON) and `FT.Media` (binary blobs), so the storage backend can be swapped or a sync layer added without touching the UI.

---

## 💾 How data is stored

| Data | Where | Why |
|------|-------|-----|
| Workouts, activities, measurements, templates, settings, photo **metadata** | **localStorage** (`ft_state_v1`, one JSON doc) | Small, fast, synchronous |
| Photos & videos (binary) | **IndexedDB** (`fitness-tracker` → `media`) | Large quota, handles video |
| Thumbnails | small data URLs inside the JSON | Instant galleries without reading blobs |

- **Export Backup** → one JSON file containing all structured data **plus** media inlined as base64.
- **Import Backup** → restores both structured data and media. Importing **replaces** current data (you're warned first).

---

## 🗓️ Weekly reset logic

- A week is **Monday 00:00 → Sunday 23:59**, derived from any date.
- "Days completed this week" counts **only gym workouts whose date falls inside the current week**.
- The suggested **next day** is the first planned day (Day 1 → 4) *not done this week*. It never reads previous weeks, so **every Monday it restarts from Day 1**.
- **Other** activities count as activity but never affect the day cycle.

---

## 📸 How photo/video storage works

1. Pick a photo/video via the native input (camera or library on iPhone).
2. The file is stored as a **Blob in IndexedDB**.
3. A small **thumbnail** (canvas-generated JPEG) is saved in the metadata for fast grids and the **First vs Latest** comparison.
4. Viewing creates a temporary object URL on demand and revokes it after — keeps memory low.
5. A reminder appears when it's been **≥ 4 weeks** since your last check-in.

---

## ⚠️ Limitations

- **Local-only.** Clearing browser data or uninstalling removes everything → **export backups regularly**.
- **iOS Safari** may evict storage for sites *not* added to the Home Screen after ~7 days of inactivity → add to Home Screen + back up.
- Storage **quotas** vary by browser; backups containing many videos can be large.
- **In-app reminders only** — no OS push notifications.
- Charts are **custom SVG** (zero dependencies, fully offline). Chart.js can be swapped in later if desired.

---

## 🔮 Future-proofing

The architecture leaves room for, without implementing now:

- **Nutrition** & **step counting** → add a new collection in `data.js` + a view + (optionally) a tab.
- **Apple Health / wearables** → import into the same `FT.Store` shape.
- **Cloud sync** → the export/import format is the natural sync payload; add a sync adapter behind `FT.Store`.

---

## 🔒 Privacy

There is no backend and no analytics. Nothing leaves your device unless **you** export a backup file and choose to move it.
