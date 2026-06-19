/* =============================================================================
   data.js — Default data + storage layer
   -----------------------------------------------------------------------------
   This file owns everything related to persistence so the rest of the app never
   talks to localStorage / IndexedDB directly. Swapping the storage backend (or
   adding cloud sync later) only means changing this file.

   Exposes a single global namespace: window.FT
     FT.SCHEMA_VERSION   current data schema version
     FT.uid()            unique id generator
     FT.DEFAULT_TEMPLATES the preloaded Day 1–4 workout plan
     FT.defaultState()   a fresh, fully-seeded app state object
     FT.Store            structured JSON storage (localStorage)
     FT.Media            binary blob storage for photos/videos (IndexedDB)
   ========================================================================== */

(function () {
  'use strict';

  const FT = (window.FT = window.FT || {});

  FT.SCHEMA_VERSION = 1;
  FT.STORAGE_KEY = 'ft_state_v1';
  FT.DB_NAME = 'fitness-tracker';
  FT.DB_STORE = 'media';

  /* ---- Small helpers ------------------------------------------------------ */

  // Robust unique id (crypto.randomUUID when available, fallback otherwise).
  FT.uid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  // Local-time ISO date (YYYY-MM-DD) for "today".
  FT.todayISO = function () {
    const d = new Date();
    const off = d.getTimezoneOffset();
    const local = new Date(d.getTime() - off * 60000);
    return local.toISOString().slice(0, 10);
  };

  /* ---- Default workout templates -----------------------------------------
     reps is stored as text so it can hold ranges and time-based values
     ("8–10", "45–60 sec"). weight is a number (kg) or '' when bodyweight.    */

  FT.DEFAULT_TEMPLATES = {
    day1: {
      key: 'day1',
      name: 'Day 1 · Heavy Legs (Quad Focus) + Core',
      exercises: [
        { name: 'Smith Machine Squat',   sets: 4, reps: '8–10',        weight: 35, notes: '' },
        { name: 'Bulgarian Split Squats', sets: 3, reps: '10–12 / leg', weight: 3,  notes: '' },
        { name: 'Leg Extension',          sets: 3, reps: '12–15',       weight: '', notes: '' },
        { name: 'Shoulder Tap Plank',     sets: 3, reps: '45–60 sec',   weight: '', notes: '' },
        { name: 'Dead Bugs',              sets: 3, reps: '12 / side',   weight: '', notes: '' },
        { name: 'Reverse Crunches',       sets: 3, reps: '15',          weight: '', notes: '' },
      ],
    },
    day2: {
      key: 'day2',
      name: 'Day 2 · Glutes & Posterior Chain + Core',
      exercises: [
        { name: 'Hip Thrusts',                  sets: 4, reps: '10–12',      weight: 45,   notes: '' },
        { name: 'Romanian Deadlifts (RDLs)',    sets: 3, reps: '10–12',      weight: 45,   notes: '' },
        { name: 'Cable / Machine Abductions',   sets: 3, reps: '15–20',      weight: 3.25, notes: '' },
        { name: 'Leg Curls',                    sets: 3, reps: '12',         weight: 25,   notes: '' },
        { name: 'Weighted Russian Twists',      sets: 3, reps: '20 total',   weight: 4,    notes: 'Range 4–8kg' },
        { name: 'Mountain Climbers',            sets: 3, reps: '40 sec',     weight: '',   notes: '' },
        { name: 'Back Extensions',              sets: 3, reps: '15',         weight: '',   notes: '' },
      ],
    },
    day3: {
      key: 'day3',
      name: 'Day 3 · Legs Volume + Lower Core',
      exercises: [
        { name: 'Leg Press',            sets: 4, reps: '12–15',          weight: '', notes: '' },
        { name: 'Weighted Step-Ups',    sets: 3, reps: '10 / leg',       weight: '', notes: '' },
        { name: 'Banded Glute Bridges', sets: 3, reps: '20–25',          weight: '', notes: 'Band' },
        { name: 'Calf Raises',          sets: 4, reps: '15–20',          weight: '', notes: '' },
        { name: 'V-Ups or Toe Touches', sets: 3, reps: '12–15',          weight: '', notes: '' },
        { name: 'Side Plank',           sets: 3, reps: '30–45 sec / side', weight: '', notes: '' },
        { name: 'Bicycle Crunches',     sets: 3, reps: '20',             weight: '', notes: '' },
      ],
    },
    day4: {
      key: 'day4',
      name: 'Day 4 · Full Upper Body (Optional)',
      exercises: [
        { name: 'Lat Pulldowns',           sets: 3, reps: '10–12',    weight: '', notes: '' },
        { name: 'Incline Dumbbell Press',  sets: 3, reps: '10–12',    weight: '', notes: '' },
        { name: 'One-Arm Dumbbell Row',    sets: 3, reps: '12 / arm', weight: '', notes: '' },
        { name: 'Dumbbell Shoulder Press', sets: 3, reps: '10–12',    weight: '', notes: '' },
        { name: 'Lateral Raises',          sets: 3, reps: '15',       weight: '', notes: '' },
        { name: 'Bicep Hammer Curls',      sets: 3, reps: '12',       weight: '', notes: 'Superset w/ Tricep Pushdowns' },
        { name: 'Tricep Cable Pushdowns',  sets: 3, reps: '12',       weight: '', notes: 'Superset w/ Hammer Curls' },
      ],
    },
  };

  // Display order + labels for the planned days (Day 4 is optional / not counted
  // toward the weekly target by default).
  FT.PLAN_ORDER = ['day1', 'day2', 'day3', 'day4'];
  FT.DAY_LABELS = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3', day4: 'Day 4', other: 'Other' };

  // Suggested activity types for the "Other" form.
  FT.ACTIVITY_PRESETS = [
    'Walk', 'Running', 'Hiking', 'Cycling', 'Swimming', 'Yoga',
    'Mobility', 'Stretching', 'Home Workout', 'Bodyweight Training',
  ];

  // Measurement fields tracked in the Body section.
  FT.MEASUREMENT_FIELDS = [
    { key: 'weight', label: 'Weight', unit: 'kg' },
    { key: 'waist',  label: 'Waist',  unit: 'cm' },
    { key: 'hips',   label: 'Hips',   unit: 'cm' },
    { key: 'thighs', label: 'Thighs', unit: 'cm' },
    { key: 'calves', label: 'Calves', unit: 'cm' },
    { key: 'arms',   label: 'Arms',   unit: 'cm' },
    { key: 'bodyFat', label: 'Body Fat', unit: '%' },
  ];

  /* ---- Fresh state -------------------------------------------------------- */

  // Deep-clone the templates and assign stable ids (so they can be edited).
  function seedTemplates() {
    const out = {};
    Object.keys(FT.DEFAULT_TEMPLATES).forEach((k) => {
      const t = FT.DEFAULT_TEMPLATES[k];
      out[k] = {
        key: t.key,
        name: t.name,
        exercises: t.exercises.map((e) => Object.assign({ id: FT.uid() }, e)),
      };
    });
    return out;
  }

  FT.defaultState = function () {
    return {
      schema: FT.SCHEMA_VERSION,
      settings: {
        theme: 'auto',            // 'auto' | 'light' | 'dark'
        units: 'kg',
        weeklyTarget: 3,          // planned workouts per week (Day 4 optional)
        startDate: FT.todayISO(), // baseline for the 4-week photo reminder
        photoReminderDismissed: null,
        gdrive: { clientId: '', fileId: '', enabled: false, lastSync: null },
      },
      templates: seedTemplates(),
      workouts: [],     // gym sessions  { id, date, type, name, duration, notes, exercises[] }
      activities: [],   // other activities { id, name, date, duration, distance, calories, notes }
      measurements: [], // { id, date, weight, waist, hips, thighs, calves, arms, bodyFat, notes }
      photos: [],       // metadata { id, date, notes, kind:'photo'|'video', mediaId, thumb }
      // Per-exercise demo image/GIF, keyed by lowercased exercise name so one
      // image is reused everywhere that exercise appears.
      // { '<name>': { kind:'image'|'url', mediaId?, url?, thumb } }
      exerciseMedia: {},
    };
  };

  /* ---- Structured store (localStorage) ------------------------------------ */

  // Merge a loaded state over defaults so new fields are always present even if
  // an old backup is missing them (forward compatibility).
  function migrate(loaded) {
    const base = FT.defaultState();
    if (!loaded || typeof loaded !== 'object') return base;
    const out = Object.assign(base, loaded);
    const ls = loaded.settings || {};
    out.settings = Object.assign(base.settings, ls);
    out.settings.gdrive = Object.assign({ clientId: '', fileId: '', enabled: false, lastSync: null }, ls.gdrive || {});
    // If the user never edited templates, keep the seeded defaults.
    out.templates = loaded.templates && Object.keys(loaded.templates).length
      ? loaded.templates : base.templates;
    out.workouts = Array.isArray(loaded.workouts) ? loaded.workouts : [];
    out.activities = Array.isArray(loaded.activities) ? loaded.activities : [];
    out.measurements = Array.isArray(loaded.measurements) ? loaded.measurements : [];
    out.photos = Array.isArray(loaded.photos) ? loaded.photos : [];
    out.exerciseMedia = (loaded.exerciseMedia && typeof loaded.exerciseMedia === 'object') ? loaded.exerciseMedia : {};
    out.schema = FT.SCHEMA_VERSION;
    return out;
  }

  FT.Store = {
    load() {
      try {
        const raw = localStorage.getItem(FT.STORAGE_KEY);
        if (!raw) {
          const fresh = FT.defaultState();
          this.save(fresh);
          return fresh;
        }
        return migrate(JSON.parse(raw));
      } catch (err) {
        console.error('Store.load failed, starting fresh:', err);
        return FT.defaultState();
      }
    },

    save(state) {
      try {
        localStorage.setItem(FT.STORAGE_KEY, JSON.stringify(state));
        return true;
      } catch (err) {
        console.error('Store.save failed:', err);
        // Most likely the quota was exceeded (rare for JSON-only data).
        return false;
      }
    },

    clear() {
      localStorage.removeItem(FT.STORAGE_KEY);
    },

    // Full backup: structured state + every media blob inlined as base64.
    async export(state) {
      const media = [];
      try {
        const all = await FT.Media.all();
        for (const rec of all) {
          media.push({ id: rec.id, type: rec.blob.type, dataURL: await blobToDataURL(rec.blob) });
        }
      } catch (err) {
        console.warn('Media export skipped:', err);
      }
      return {
        app: 'fitness-tracker',
        schema: FT.SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        state,
        media,
      };
    },

    // Restore from a parsed backup object. Replaces all current data.
    async import(backup) {
      if (!backup || backup.app !== 'fitness-tracker' || !backup.state) {
        throw new Error('Not a valid Fitness Tracker backup file.');
      }
      const state = migrate(backup.state);
      this.save(state);
      // Restore media blobs.
      await FT.Media.clear();
      if (Array.isArray(backup.media)) {
        for (const m of backup.media) {
          try {
            const blob = await dataURLToBlob(m.dataURL);
            await FT.Media.put(m.id, blob);
          } catch (err) {
            console.warn('Skipped one media item during import:', err);
          }
        }
      }
      return state;
    },
  };

  /* ---- Media store (IndexedDB) -------------------------------------------- */

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB not supported'));
        return;
      }
      const req = indexedDB.open(FT.DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FT.DB_STORE)) {
          db.createObjectStore(FT.DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then((db) => db.transaction(FT.DB_STORE, mode).objectStore(FT.DB_STORE));
  }

  FT.Media = {
    async put(id, blob) {
      const store = await tx('readwrite');
      return new Promise((res, rej) => {
        const r = store.put({ id, blob });
        r.onsuccess = () => res(id);
        r.onerror = () => rej(r.error);
      });
    },
    async get(id) {
      const store = await tx('readonly');
      return new Promise((res, rej) => {
        const r = store.get(id);
        r.onsuccess = () => res(r.result ? r.result.blob : null);
        r.onerror = () => rej(r.error);
      });
    },
    async delete(id) {
      const store = await tx('readwrite');
      return new Promise((res, rej) => {
        const r = store.delete(id);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
    },
    async all() {
      const store = await tx('readonly');
      return new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
    },
    async clear() {
      try {
        const store = await tx('readwrite');
        return new Promise((res, rej) => {
          const r = store.clear();
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        });
      } catch (err) {
        console.warn('Media.clear failed:', err);
      }
    },
  };

  /* ---- base64 <-> blob conversions (used by export/import) ---------------- */

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.onerror = () => rej(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    return fetch(dataURL).then((r) => r.blob());
  }

  FT.blobToDataURL = blobToDataURL;
})();
