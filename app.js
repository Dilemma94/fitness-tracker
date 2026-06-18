/* =============================================================================
   app.js — Pulse Fitness Tracker (application logic)
   -----------------------------------------------------------------------------
   No framework. The app keeps one in-memory `state` (mirrored to FT.Store),
   renders views as HTML strings into #view, and routes every interaction
   through ONE delegated click/submit handler via [data-action] attributes.

   Sections:
     1. State + utilities (escape, dates, weeks, formatting, toast)
     2. Stats / derived data (week progress, PRs, progression, measurements)
     3. SVG chart + progress ring helpers
     4. Icon set
     5. View renderers (home, workouts, progress, history, settings)
     6. Modals & flows (start workout, activity, measurement, photos, templates…)
     7. Event handling (actions, forms)
     8. Theme + init
   ========================================================================== */

(function () {
  'use strict';
  const FT = (window.FT = window.FT || {});

  /* =========================================================================
     1. STATE + UTILITIES
     ========================================================================= */

  const App = {
    state: FT.Store.load(),
    view: 'home',
    progressTab: 'strength',
    selectedExercise: null,
    selectedMeasure: 'weight',
    session: null,        // active start-workout flow state
    historyFilter: { range: 'all', type: 'all', exercise: '' },
  };
  FT.App = App;

  const $ = (sel, root = document) => root.querySelector(sel);
  const viewEl = $('#view');
  const modalRoot = $('#modal-root');

  function save() { FT.Store.save(App.state); }

  // Escape user-provided text before injecting into innerHTML.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const uid = FT.uid;

  /* ---- Dates & weeks (Monday → Sunday) ----------------------------------- */
  function parseDate(iso) {
    if (iso instanceof Date) return iso;
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function todayISO() { return FT.todayISO(); }
  function startOfWeek(d) {
    const date = new Date(d); date.setHours(0, 0, 0, 0);
    const day = date.getDay();              // 0 Sun … 6 Sat
    const diff = day === 0 ? -6 : 1 - day;  // shift back to Monday
    date.setDate(date.getDate() + diff);
    return date;
  }
  function endOfWeek(d) {
    const s = startOfWeek(d); const e = new Date(s);
    e.setDate(s.getDate() + 6); e.setHours(23, 59, 59, 999);
    return e;
  }
  function inRange(date, a, b) { const t = parseDate(date).getTime(); return t >= a.getTime() && t <= b.getTime(); }
  // ISO-8601 week number (1–53).
  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }
  function weeksBetween(aIso, bIso) {
    return Math.floor((parseDate(bIso) - parseDate(aIso)) / (7 * 86400000));
  }

  /* ---- Formatting -------------------------------------------------------- */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtDate(iso) { const d = parseDate(iso); return `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
  function fmtDateLong(iso) { const d = parseDate(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  function fmtMonthYear(iso) { const d = parseDate(iso); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  function relWeeks(iso) {
    const w = weeksBetween(iso, todayISO());
    if (w <= 0) return 'this week';
    if (w === 1) return '1 week ago';
    return `${w} weeks ago`;
  }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function kg(v) { const n = parseFloat(v); return isNaN(n) || n === 0 ? '—' : (Math.round(n * 100) / 100) + 'kg'; }

  /* ---- Toast ------------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg, type = 'ok') {
    const root = $('#toast-root');
    const icon = type === 'err'
      ? '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
    root.innerHTML = `<div class="toast ${type}">${icon}<span>${esc(msg)}</span></div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (root.innerHTML = ''), 2400);
  }

  /* =========================================================================
     2. STATS / DERIVED DATA
     ========================================================================= */

  // Weekly progress — counts ONLY gym workouts in the *current* Mon–Sun window.
  function weekStats(ref = new Date()) {
    const s = startOfWeek(ref), e = endOfWeek(ref);
    const gymThisWeek = App.state.workouts.filter(w => w.type !== 'other' && inRange(w.date, s, e));
    const daysDone = new Set(gymThisWeek.map(w => w.type));
    const target = App.state.settings.weeklyTarget || 3;
    const completed = gymThisWeek.length;
    // Next suggested day = first planned day not done THIS week (never carries over).
    const nextDay = FT.PLAN_ORDER.find(d => !daysDone.has(d)) || null;
    const percent = Math.min(100, Math.round((completed / target) * 100));
    return {
      start: s, end: e, completed, target, daysDone, nextDay, percent,
      weekNumber: isoWeek(new Date(ref)),
      totalAllTime: App.state.workouts.length,
      activitiesThisWeek: App.state.activities.filter(a => inRange(a.date, s, e)).length,
    };
  }

  // Personal records: highest logged weight per exercise (across all workouts).
  function personalRecords() {
    const map = {};
    App.state.workouts.forEach(w => (w.exercises || []).forEach(ex => {
      const wt = num(ex.weight);
      if (wt <= 0) return;
      const key = (ex.name || '').trim().toLowerCase();
      if (!key) return;
      if (!map[key] || wt > map[key].weight) map[key] = { name: ex.name, weight: wt, date: w.date };
    }));
    return Object.values(map).sort((a, b) => b.weight - a.weight);
  }

  // All exercise names that have been logged (for selectors).
  function loggedExerciseNames() {
    const set = new Set();
    App.state.workouts.forEach(w => (w.exercises || []).forEach(ex => {
      const n = (ex.name || '').trim();
      if (n) set.add(n);
    }));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // History of one exercise across workouts (sorted by date ascending).
  function exerciseHistory(name) {
    const key = name.trim().toLowerCase();
    const rows = [];
    App.state.workouts.forEach(w => (w.exercises || []).forEach(ex => {
      if ((ex.name || '').trim().toLowerCase() !== key) return;
      rows.push({ date: w.date, weight: num(ex.weight), reps: ex.reps, sets: ex.sets });
    }));
    rows.sort((a, b) => parseDate(a.date) - parseDate(b.date));
    return rows;
  }

  function progressionStats(name) {
    const rows = exerciseHistory(name).filter(r => r.weight > 0);
    if (!rows.length) return null;
    const start = rows[0].weight;
    const current = rows[rows.length - 1].weight;
    const previous = rows.length > 1 ? rows[rows.length - 2].weight : start;
    const best = Math.max(...rows.map(r => r.weight));
    return { start, current, previous, best, increase: Math.round((current - start) * 100) / 100, rows };
  }

  // Measurement helpers
  function sortedMeasurements() {
    return [...App.state.measurements].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  }
  function measureStat(field) {
    const rows = sortedMeasurements().filter(m => m[field] !== '' && m[field] != null && !isNaN(parseFloat(m[field])));
    if (!rows.length) return null;
    const first = num(rows[0][field]);
    const latest = num(rows[rows.length - 1][field]);
    return { first, latest, diff: Math.round((latest - first) * 100) / 100, rows };
  }

  // 4-week progress photo reminder.
  function photoReminderDue() {
    const photos = App.state.photos;
    const baseline = photos.length
      ? photos.reduce((m, p) => (parseDate(p.date) > parseDate(m) ? p.date : m), photos[0].date)
      : App.state.settings.startDate;
    const due = weeksBetween(baseline, todayISO()) >= 4;
    const dismissed = App.state.settings.photoReminderDismissed;
    // Re-show if dismissal is older than the latest baseline.
    const stillDismissed = dismissed && weeksBetween(dismissed, todayISO()) < 1;
    return due && !stillDismissed;
  }

  /* =========================================================================
     3. CHARTS (lightweight, dependency-free SVG)
     ========================================================================= */

  // Simple responsive line chart. data = [{label, value}], ascending.
  function lineChart(data, opts = {}) {
    if (!data || data.length === 0) return `<div class="chart-empty">No data yet</div>`;
    const W = 320, H = 150, pad = { l: 6, r: 6, t: 14, b: 20 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const vals = data.map(d => d.value);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const pad2 = (max - min) * 0.12; min -= pad2; max += pad2;
    const n = data.length;
    const x = i => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = v => pad.t + ih - ((v - min) / (max - min)) * ih;

    const pts = data.map((d, i) => [x(i), y(d.value)]);
    const linePath = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const areaPath = `${linePath} L ${pts[pts.length - 1][0].toFixed(1)} ${(pad.t + ih).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(pad.t + ih).toFixed(1)} Z`;

    // horizontal grid lines
    let grid = '';
    for (let g = 0; g <= 2; g++) {
      const gy = pad.t + (g / 2) * ih;
      grid += `<line class="grid-line" x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(1)}"/>`;
    }
    // value labels at min/max
    const valTop = `<text class="axis-label" x="${pad.l}" y="${pad.t - 4}">${Math.round(max * 10) / 10}</text>`;
    const valBot = `<text class="axis-label" x="${pad.l}" y="${pad.t + ih + 13}">${Math.round(min * 10) / 10}</text>`;
    // x labels: first + last
    const firstL = `<text class="axis-label" x="${pad.l}" y="${H - 4}">${esc(data[0].label)}</text>`;
    const lastL = n > 1 ? `<text class="axis-label" text-anchor="end" x="${W - pad.r}" y="${H - 4}">${esc(data[n - 1].label)}</text>` : '';
    const dots = pts.map(p => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5"/>`).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
      ${grid}<path class="area" d="${areaPath}"/><path class="line" d="${linePath}"/>${dots}
      ${valTop}${valBot}${firstL}${lastL}</svg>`;
  }

  // SVG progress ring for the dashboard.
  function progressRing(percent, label, sub) {
    const r = 38, c = 2 * Math.PI * r, off = c * (1 - Math.min(percent, 100) / 100);
    return `<div class="ring-wrap" style="position:relative;width:96px;height:96px;">
      <svg class="ring" width="96" height="96" viewBox="0 0 96 96">
        <circle class="track" cx="48" cy="48" r="${r}" stroke-width="9"/>
        <circle class="bar" cx="48" cy="48" r="${r}" stroke-width="9" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
      </svg>
      <div class="ring-center" style="position:absolute;inset:0;">
        <div><div class="ring-label">${esc(label)}</div><div class="ring-sub">${esc(sub)}</div></div>
      </div></div>`;
  }

  /* =========================================================================
     4. ICONS
     ========================================================================= */
  const I = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M5 4v3.5h3.5"/></svg>',
    activity: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg>',
    dumbbell: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5 17.5 17.5"/><path d="M4 8.5 8.5 4M15.5 20 20 15.5M3 11 5 13M11 3l2 2M19 11l2 2M11 19l2 2"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16"/><path d="M8 16l3.5-4 3 2.5L20 8"/></svg>',
    ruler: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/></svg>',
    medal: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="5"/><path d="M9 9 7 3M15 9l2-6M12 12v4M10.5 14h3"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 20V9m0 0L8 13m4-4l4 4M5 5h14"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-1.5.5-2.5 1-3 .2 1 .8 1.5 1.5 1.5C9 9 9 6 12 3z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>',
  };

  /* ---- Exercise demo images ----------------------------------------------
     Each exercise shows a glanceable visual. By default it's a colour-coded
     movement glyph derived from the name; the user can attach their own
     image/GIF (stored in IndexedDB) or link, reused everywhere by name.      */

  // Movement categories → gradient colours + a simple white glyph.
  const EXCAT = {
    legs:    { c1: '#6457f6', c2: '#8b7bff', g: '<circle cx="12" cy="5" r="2"/><path d="M8.5 8.6h7M12 7.2v3.3M12 10.5l-2.7 3.6v2.4M12 10.5l2.7 3.6v2.4"/>' },
    glutes:  { c1: '#a25cff', c2: '#c489ff', g: '<circle cx="6.6" cy="6" r="1.9"/><path d="M8 7.1 13.6 10.2M13.6 10.2v6.4M10 16.6h7M13.6 10.2l3.4-1.1"/>' },
    core:    { c1: '#12b5a6', c2: '#3ad6c6', g: '<rect x="7" y="4.5" width="10" height="15" rx="3.2"/><path d="M7.4 9h9.2M7.4 12.4h9.2M12 5v13.5"/>' },
    push:    { c1: '#ff8a3d', c2: '#ffb06a', g: '<path d="M12 21v-7M9 16.3l3-3 3 3M6.3 7.6h11.4M6.3 5.4v4.4M9 5.4v4.4M15 5.4v4.4M17.7 5.4v4.4"/>' },
    pull:    { c1: '#3b9eff', c2: '#6bb6ff', g: '<path d="M6.3 6.4h11.4M6.3 4.2v4.4M9 4.2v4.4M15 4.2v4.4M17.7 4.2v4.4M12 9v6.2M9 12.4l3 3 3-3"/>' },
    arms:    { c1: '#ff5c93', c2: '#ff86b0', g: '<path d="M7 4.5v6.2a4 4 0 0 0 4 4h1.6M13 14.7l4.6 4M15.4 13.7l3 1.2"/>' },
    calf:    { c1: '#f5a623', c2: '#ffc863', g: '<path d="M12 20.5V8M8.8 11.5l3.2-3.2 3.2 3.2M8 20.5h8"/>' },
    cardio:  { c1: '#28c76f', c2: '#5fe09a', g: '<path d="M3 12h4l2 5 3-10 2 5h7"/>' },
    generic: { c1: '#8a8a96', c2: '#aeaeb8', g: '<path d="M6.5 6.5 17.5 17.5M4 8.5 8.5 4M15.5 20 20 15.5M3 11 5 13M11 3l2 2M19 11l2 2M11 19l2 2"/>' },
  };

  const exKey = (name) => (name || '').trim().toLowerCase();

  // Guess a movement category from the exercise name (ordered to resolve
  // keyword conflicts like "leg curl" vs "bicep curl").
  function exerciseCategory(name) {
    const n = exKey(name);
    const has = (...k) => k.some((s) => n.includes(s));
    if (!n) return 'generic';
    if (has('calf', 'calve')) return 'calf';
    if (has('plank', 'crunch', 'dead bug', 'deadbug', 'russian', 'bicycle', 'v-up', 'vup', 'v up', 'toe touch', 'mountain climber', 'sit-up', 'sit up', 'situp', 'hollow', 'side bend', 'woodchop', 'oblique')) return 'core';
    if (has('pulldown', 'pull-down', 'pull down', 'row', 'pull-up', 'pull up', 'pullup', 'chin-up', 'chin up', 'chinup')) return 'pull';
    if (has('hammer', 'bicep', 'tricep', 'pushdown', 'push-down', 'skull', 'kickback', 'preacher', 'concentration')) return 'arms';
    if (has('thrust', 'bridge', 'deadlift', 'rdl', 'romanian', 'abduction', 'adduction', 'back extension', 'good morning', 'leg curl', 'hamstring', 'glute')) return 'glutes';
    if (has('squat', 'leg press', 'leg extension', 'lunge', 'step-up', 'step up', 'wall sit', 'hack')) return 'legs';
    if (has('press', 'push-up', 'push up', 'pushup', 'bench', 'fly', 'flye', 'dip', 'raise', 'overhead', 'arnold', 'shoulder')) return 'push';
    if (has('walk', 'run', 'jog', 'hike', 'cycl', 'bike', 'swim', 'yoga', 'mobility', 'stretch', 'cardio', 'elliptic')) return 'cardio';
    if (has('curl')) return 'arms';
    return 'generic';
  }

  // Small tappable thumbnail for an exercise (custom image or category glyph).
  function exThumb(name) {
    const m = App.state.exerciseMedia[exKey(name)];
    if (m && (m.thumb || m.url)) {
      return `<button class="ex-thumb has-img" data-action="exercise-media" data-name="${esc(name)}" aria-label="Image for ${esc(name)}"><img src="${esc(m.thumb || m.url)}" alt="" loading="lazy"/></button>`;
    }
    const c = EXCAT[exerciseCategory(name)] || EXCAT.generic;
    return `<button class="ex-thumb cat" style="--c1:${c.c1};--c2:${c.c2}" data-action="exercise-media" data-name="${esc(name)}" aria-label="Add image for ${esc(name)}"><svg viewBox="0 0 24 24">${c.g}</svg></button>`;
  }

  /* =========================================================================
     5. VIEWS
     ========================================================================= */

  function header(eyebrow, title, sub, action) {
    return `<div class="page-head"><div class="titles">
      ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
      <h1 class="page-title">${esc(title)}</h1>
      ${sub ? `<div class="page-sub">${esc(sub)}</div>` : ''}
      </div>${action || ''}</div>`;
  }

  /* ---- HOME / DASHBOARD --------------------------------------------------- */
  function renderHome() {
    const ws = weekStats();
    const reminders = [];

    if (photoReminderDue()) {
      reminders.push(`<div class="banner info" data-reminder="photo">
        <div class="b-ic">${I.camera}</div>
        <div class="b-main"><div class="b-title">Time to take progress photos</div>
        <div class="b-text">It's been 4+ weeks since your last check-in.</div></div>
        <button class="b-close" data-action="dismiss-photo-reminder" aria-label="Dismiss">${I.close}</button></div>`);
    }
    if (ws.completed < ws.target) {
      reminders.push(`<div class="banner">
        <div class="b-ic">${I.flame}</div>
        <div class="b-main"><div class="b-title">Keep your streak going</div>
        <div class="b-text">You've completed ${ws.completed} of your ${ws.target} planned workouts this week.</div></div></div>`);
    }

    const nextLabel = ws.nextDay ? FT.DAY_LABELS[ws.nextDay] : 'All done 🎉';
    const nextName = ws.nextDay ? App.state.templates[ws.nextDay].name.split('·')[1]?.trim() || '' : 'Great week!';

    // Recent entries (mix of workouts + activities)
    const recent = mergedEntries().slice(0, 4);

    viewEl.innerHTML = `
      ${header('Pulse', greeting(), `Week ${ws.weekNumber} · ${fmtDate(ws.start)} – ${fmtDate(ws.end)}`,
        `<button class="head-btn" data-action="nav" data-view="settings" aria-label="Settings">${I.moon}</button>`)}

      ${reminders.join('')}

      <div class="week-card">
        ${progressRing(ws.percent, ws.percent + '%', 'complete')}
        <div class="week-info">
          <div class="wk-eyebrow">Week Progress</div>
          <div class="wk-big">${ws.completed} / ${ws.target} Workouts</div>
          <div class="wk-meta">
            <span><b>${ws.totalAllTime}</b> total</span>
            <span><b>${ws.activitiesThisWeek}</b> activities</span>
          </div>
        </div>
      </div>

      <button class="day-opt suggested" data-action="start-workout" style="margin-bottom:16px;">
        <div class="d-tag">${ws.nextDay ? esc(FT.DAY_LABELS[ws.nextDay].replace(' ', '\n')) : 'GO'}</div>
        <div class="d-main"><div class="d-name">Start ${esc(nextLabel)}</div>
        <div class="d-sub">${esc(nextName || 'Begin a session')}</div></div>
        <span class="d-badge">${ws.nextDay ? 'Suggested' : ''}</span>
      </button>

      <div class="section-label">Quick Actions</div>
      <div class="qa-grid">
        <button class="qa violet" data-action="start-workout">
          <div class="qa-ic">${I.play}</div><div class="qa-label">Start Workout</div></button>
        <button class="qa green" data-action="add-activity">
          <div class="qa-ic">${I.activity}</div><div class="qa-label">Add Activity</div></button>
        <button class="qa orange" data-action="nav" data-view="progress" data-tab="photos">
          <div class="qa-ic">${I.camera}</div><div class="qa-label">Progress Photos</div></button>
        <button class="qa" data-action="nav" data-view="history">
          <div class="qa-ic">${I.history}</div><div class="qa-label">View History</div></button>
      </div>

      <div class="section-label">Recent</div>
      ${recent.length ? `<div class="stack">${recent.map(entryRow).join('')}</div>`
        : emptyState(I.dumbbell, 'No sessions yet', 'Start your first workout to see it here.')}
    `;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  /* ---- WORKOUTS (templates) ---------------------------------------------- */
  function renderWorkouts() {
    const t = App.state.templates;
    const cards = FT.PLAN_ORDER.map(key => {
      const tpl = t[key];
      const list = tpl.exercises.map((ex) => `
        <div class="ex-item">${exThumb(ex.name)}
          <div class="ex-main"><div class="ex-name">${esc(ex.name)}</div>
            <div class="ex-meta"><span class="pill">${esc(ex.sets)} × ${esc(ex.reps)}</span>${ex.weight !== '' ? esc(kg(ex.weight)) : 'Bodyweight'}</div>
          </div></div>`).join('');
      return `<div class="card">
        <div class="card-head"><div class="card-title">${esc(tpl.name)}</div>
          <button class="btn ghost sm" data-action="edit-template" data-key="${key}">${I.edit}<span>Edit</span></button></div>
        ${list}
        <button class="btn primary full mt-12" data-action="start-workout" data-key="${key}">${I.play}<span>Start ${FT.DAY_LABELS[key]}</span></button>
      </div>`;
    }).join('');

    viewEl.innerHTML = `
      ${header('Plan', 'Workouts', 'Your weekly training split — tap Edit to customise permanently.')}
      <div class="btn-grid" style="margin-bottom:16px;">
        <button class="btn primary" data-action="start-workout">${I.play}<span>Start Workout</span></button>
        <button class="btn" data-action="add-activity">${I.activity}<span>Other Activity</span></button>
      </div>
      ${cards}`;
  }

  /* ---- PROGRESS (strength · records · body · photos) --------------------- */
  function renderProgress() {
    const tab = App.progressTab;
    const seg = `<div class="segmented" style="margin-bottom:16px;">
      ${['strength', 'records', 'body', 'photos'].map(t =>
        `<button data-action="progress-tab" data-tab="${t}" class="${tab === t ? 'active' : ''}">${({ strength: 'Strength', records: 'Records', body: 'Body', photos: 'Photos' })[t]}</button>`).join('')}
    </div>`;

    let body = '';
    if (tab === 'strength') body = progressStrength();
    else if (tab === 'records') body = progressRecords();
    else if (tab === 'body') body = progressBody();
    else body = progressPhotos();

    viewEl.innerHTML = `${header('Track', 'Progress')}${seg}${body}`;
  }

  function progressStrength() {
    const names = loggedExerciseNames();
    if (!names.length) return emptyState(I.chart, 'No exercise data yet', 'Log a workout with weights to see progression charts.');
    if (!App.selectedExercise || !names.includes(App.selectedExercise)) App.selectedExercise = names[0];
    const ps = progressionStats(App.selectedExercise);
    const options = names.map(n => `<option value="${esc(n)}" ${n === App.selectedExercise ? 'selected' : ''}>${esc(n)}</option>`).join('');

    let detail = '<div class="chart-empty">No weighted sets logged for this exercise.</div>';
    if (ps) {
      const chartData = ps.rows.map(r => ({ label: `${parseDate(r.date).getDate()}/${parseDate(r.date).getMonth() + 1}`, value: r.weight }));
      detail = `
        <div class="prog-strip">
          <div class="ps"><div class="v">${kg(ps.start)}</div><div class="k">Starting</div></div>
          <div class="ps"><div class="v">${kg(ps.previous)}</div><div class="k">Previous</div></div>
          <div class="ps"><div class="v">${kg(ps.current)}</div><div class="k">Current</div></div>
          <div class="ps ${ps.increase > 0 ? 'up' : ''}"><div class="v">${ps.increase >= 0 ? '+' : ''}${ps.increase}kg</div><div class="k">Change</div></div>
        </div>
        <div class="flex between items-center small muted" style="margin-bottom:6px;">
          <span>Personal best: <b style="color:var(--accent)">${kg(ps.best)}</b></span>
          <span>${ps.rows.length} session${ps.rows.length === 1 ? '' : 's'}</span>
        </div>
        ${lineChart(chartData)}`;
    }
    return `<div class="field"><label>Exercise</label><select class="input" data-action="select-exercise">${options}</select></div>
      <div class="card">
        <div class="flex items-center gap-8" style="margin-bottom:12px;">${exThumb(App.selectedExercise)}
          <div class="grow nowrap"><div class="ex-name">${esc(App.selectedExercise)}</div>
          <div class="small muted">Tap image to add a demo photo / GIF</div></div></div>
        ${detail}</div>`;
  }

  function progressRecords() {
    const prs = personalRecords();
    if (!prs.length) return emptyState(I.medal, 'No records yet', 'Your heaviest lift for each exercise will appear here automatically.');
    return `<div class="card">${prs.map(pr => `
      <div class="pr-item"><div class="pr-medal">${I.medal}</div>
        <div class="pr-main"><div class="pr-name">${esc(pr.name)}</div>
          <div class="pr-date">${fmtMonthYear(pr.date)}</div></div>
        <div class="pr-weight">${kg(pr.weight)}</div></div>`).join('')}</div>`;
  }

  function progressBody() {
    const fields = FT.MEASUREMENT_FIELDS;
    const haveAny = App.state.measurements.length > 0;
    const grid = fields.map(f => {
      const st = measureStat(f.key);
      if (!st) return `<div class="stat"><div class="num">—</div><div class="lbl">${esc(f.label)}</div></div>`;
      const dirClass = (f.key === 'weight' || f.key === 'bodyFat' || f.key === 'waist') ? (st.diff < 0 ? 'green' : '') : (st.diff > 0 ? 'green' : '');
      return `<div class="stat"><div class="num ${dirClass}">${st.latest}<span style="font-size:12px;color:var(--text-3)"> ${f.unit}</span></div>
        <div class="lbl">${esc(f.label)} · ${st.diff >= 0 ? '+' : ''}${st.diff}</div></div>`;
    }).join('');

    const measureOptions = fields.map(f => `<option value="${f.key}" ${f.key === App.selectedMeasure ? 'selected' : ''}>${f.label}</option>`).join('');
    const mstat = measureStat(App.selectedMeasure);
    const chart = mstat
      ? lineChart(mstat.rows.map(r => ({ label: `${parseDate(r.date).getDate()}/${parseDate(r.date).getMonth() + 1}`, value: num(r[App.selectedMeasure]) })))
      : '<div class="chart-empty">No data for this measurement yet.</div>';

    return `
      <button class="btn primary full" data-action="add-measurement" style="margin-bottom:16px;">${I.plus}<span>Log Measurement</span></button>
      ${haveAny ? `
        <div class="section-label" style="margin-top:6px;">Latest · change from first</div>
        <div class="stat-row" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px;">${grid}</div>
        <div class="card" style="margin-top:8px;">
          <div class="field mb-0"><label>Chart</label><select class="input" data-action="select-measure">${measureOptions}</select></div>
          <div class="mt-12">${chart}</div>
        </div>`
      : emptyState(I.ruler, 'No measurements yet', 'Record your weight and body measurements to track changes over time.')}`;
  }

  function progressPhotos() {
    const photos = [...App.state.photos].sort((a, b) => parseDate(a.date) - parseDate(b.date));
    let compare = '';
    if (photos.length >= 2) {
      const first = photos[0], last = photos[photos.length - 1];
      const gap = weeksBetween(first.date, last.date);
      compare = `<div class="card">
        <div class="compare">
          <div class="cmp"><img class="cmp-img" src="${first.thumb || ''}" alt="First check-in"/>
            <div class="cmp-lbl">First Check-In</div><div class="cmp-date">${fmtDateLong(first.date)}</div></div>
          <div class="cmp"><img class="cmp-img" src="${last.thumb || ''}" alt="Latest check-in"/>
            <div class="cmp-lbl">Latest Check-In</div><div class="cmp-date">${fmtDateLong(last.date)}</div></div>
        </div>
        <div class="cmp-gap">Time difference: <b>${gap} week${gap === 1 ? '' : 's'}</b></div>
      </div>`;
    }
    const grid = photos.length
      ? `<div class="photo-grid">${photos.map((p, i) => `
          <button class="photo-cell" data-action="view-photo" data-index="${i}">
            <img src="${p.thumb || ''}" alt="${esc(p.notes || 'progress')}"/>
            ${p.kind === 'video' ? `<span class="pv-play">${I.play}</span>` : ''}
            <span class="pv-date">${fmtDate(p.date)}</span></button>`).join('')}</div>`
      : emptyState(I.camera, 'No photos yet', 'Add a progress photo or video every 4 weeks to build your timeline.');

    return `<button class="btn primary full" data-action="add-photo" style="margin-bottom:16px;">${I.camera}<span>Add Photo / Video</span></button>
      ${compare}${grid}`;
  }

  /* ---- HISTORY ----------------------------------------------------------- */
  // Unify workouts + activities into a single sortable list.
  function mergedEntries() {
    const w = App.state.workouts.map(x => ({ kind: 'workout', id: x.id, date: x.date, type: x.type, name: x.name || FT.DAY_LABELS[x.type] || 'Workout', duration: x.duration, exercises: x.exercises || [], ref: x }));
    const a = App.state.activities.map(x => ({ kind: 'activity', id: x.id, date: x.date, type: 'other', name: x.name || 'Activity', duration: x.duration, distance: x.distance, calories: x.calories, ref: x }));
    return [...w, ...a].sort((p, q) => parseDate(q.date) - parseDate(p.date) || (q.ref.createdAt || 0) - (p.ref.createdAt || 0));
  }

  function entryRow(e) {
    let sub;
    if (e.kind === 'workout') {
      sub = `${e.exercises.length} exercise${e.exercises.length === 1 ? '' : 's'}${e.duration ? ` · ${e.duration} min` : ''}`;
    } else {
      const parts = [];
      if (e.duration) parts.push(`${e.duration} min`);
      if (e.distance) parts.push(`${e.distance} km`);
      if (e.calories) parts.push(`${e.calories} kcal`);
      sub = parts.join(' · ') || 'Activity';
    }
    return `<button class="row entry ${e.kind === 'activity' ? 'activity' : ''}" data-action="view-entry" data-kind="${e.kind}" data-id="${e.id}">
      <div class="e-ic">${e.kind === 'activity' ? I.activity : I.dumbbell}</div>
      <div class="e-main"><div class="e-title">${esc(e.name)}</div><div class="e-sub">${esc(sub)}</div></div>
      <div class="e-date">${fmtDate(e.date)}</div></button>`;
  }

  function renderHistory() {
    const f = App.historyFilter;
    let entries = mergedEntries();
    // range
    if (f.range === 'week') { const s = startOfWeek(new Date()), e = endOfWeek(new Date()); entries = entries.filter(x => inRange(x.date, s, e)); }
    else if (f.range === 'month') { const d = new Date(); entries = entries.filter(x => { const p = parseDate(x.date); return p.getMonth() === d.getMonth() && p.getFullYear() === d.getFullYear(); }); }
    // type
    if (f.type !== 'all') entries = entries.filter(x => x.type === f.type);
    // exercise search
    if (f.exercise.trim()) {
      const q = f.exercise.trim().toLowerCase();
      entries = entries.filter(x => x.kind === 'workout' && x.exercises.some(ex => (ex.name || '').toLowerCase().includes(q)));
    }

    const ranges = [['all', 'All'], ['week', 'This Week'], ['month', 'This Month']];
    const types = [['all', 'All Types'], ['day1', 'Day 1'], ['day2', 'Day 2'], ['day3', 'Day 3'], ['day4', 'Day 4'], ['other', 'Other']];

    viewEl.innerHTML = `
      ${header('Log', 'History', `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)}
      <div class="chips" style="margin-bottom:10px;">
        ${ranges.map(r => `<button class="chip ${f.range === r[0] ? 'active' : ''}" data-action="hist-range" data-val="${r[0]}">${r[1]}</button>`).join('')}
      </div>
      <div class="field-row" style="margin-bottom:12px;">
        <select class="input" data-action="hist-type">${types.map(t => `<option value="${t[0]}" ${f.type === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}</select>
        <input class="input" type="search" placeholder="Filter by exercise" value="${esc(f.exercise)}" data-action="hist-exercise"/>
      </div>
      ${entries.length ? `<div class="stack">${entries.map(entryRow).join('')}</div>`
        : emptyState(I.history, 'Nothing here', 'No entries match these filters.')}`;
  }

  /* ---- SETTINGS ---------------------------------------------------------- */
  function renderSettings() {
    const s = App.state.settings;
    const themeSeg = `<div class="segmented">
      ${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(t =>
        `<button data-action="set-theme" data-val="${t[0]}" class="${s.theme === t[0] ? 'active' : ''}">${t[1]}</button>`).join('')}</div>`;

    viewEl.innerHTML = `
      ${header('You', 'Settings')}

      <div class="section-label">Appearance</div>
      <div class="card"><div class="card-head mb-0"><div class="card-title">Theme</div></div>
        <div class="mt-12">${themeSeg}</div></div>

      <div class="section-label">Training</div>
      <div class="card">
        <div class="field mb-0"><label>Weekly workout goal</label>
          <select class="input" data-action="set-target">
            ${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}" ${s.weeklyTarget === n ? 'selected' : ''}>${n} workout${n === 1 ? '' : 's'} / week</option>`).join('')}
          </select>
          <div class="hint">Day 4 is optional and not required to hit your goal.</div></div>
      </div>

      <div class="section-label">Your Data</div>
      <div class="stack">
        <button class="row" data-action="export-data"><div class="row-ic">${I.download}</div>
          <div class="row-main"><div class="row-title">Export Backup</div><div class="row-sub">Download all data as a JSON file</div></div>${chev()}</button>
        <button class="row" data-action="import-data"><div class="row-ic">${I.upload}</div>
          <div class="row-main"><div class="row-title">Import Backup</div><div class="row-sub">Restore from a backup file</div></div>${chev()}</button>
        <button class="row" data-action="reset-templates"><div class="row-ic">${I.dumbbell}</div>
          <div class="row-main"><div class="row-title">Reset Templates</div><div class="row-sub">Restore the default workout plan</div></div>${chev()}</button>
      </div>

      <div class="section-label">Storage</div>
      <div class="card tight"><div class="row" style="border:none;padding:6px 2px;">
        <div class="row-ic">${I.info}</div>
        <div class="row-main"><div class="row-title" id="storage-line">Calculating…</div>
        <div class="row-sub">${App.state.workouts.length} workouts · ${App.state.activities.length} activities · ${App.state.photos.length} media · ${App.state.measurements.length} measurements</div></div>
      </div></div>

      <div class="stack" style="margin-top:14px;">
        <button class="row" data-action="clear-data"><div class="row-ic" style="background:var(--danger-soft)"><span style="color:var(--danger)">${I.trash}</span></div>
          <div class="row-main"><div class="row-title danger-text">Erase All Data</div><div class="row-sub">Permanently delete everything on this device</div></div></button>
      </div>

      <p class="center small muted mt-16">Pulse · v1.0 — all data stays on your device.<br/>Back up regularly to avoid losing your progress.</p>`;

    // Fill storage estimate asynchronously.
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(est => {
        const used = (est.usage || 0) / (1024 * 1024);
        const line = $('#storage-line');
        if (line) line.textContent = `${used.toFixed(used < 10 ? 2 : 1)} MB used on this device`;
      }).catch(() => {});
    }
  }

  function chev() { return `<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`; }
  function emptyState(icon, title, text) {
    return `<div class="empty"><div class="e-emoji">${icon}</div><div class="e-title">${esc(title)}</div><div class="e-text">${esc(text)}</div></div>`;
  }

  /* ---- Router ------------------------------------------------------------ */
  function render() {
    if (App.view === 'home') renderHome();
    else if (App.view === 'workouts') renderWorkouts();
    else if (App.view === 'progress') renderProgress();
    else if (App.view === 'history') renderHistory();
    else if (App.view === 'settings') renderSettings();
    // Update tab bar active state
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === App.view));
    viewEl.scrollTop = 0; window.scrollTo(0, 0);
  }

  /* =========================================================================
     6. MODALS & FLOWS
     ========================================================================= */
  function openSheet(html, opts = {}) {
    modalRoot.innerHTML = `<div class="backdrop" data-action="backdrop">
      <div class="sheet ${opts.full ? 'full' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  }
  function closeModal() {
    if (App._exmUrl) { URL.revokeObjectURL(App._exmUrl); App._exmUrl = null; }
    modalRoot.innerHTML = '';
  }
  function sheetHead(title, right) {
    return `<div class="sheet-grip"></div><div class="sheet-head">
      <button class="text-btn" data-action="close-modal">Cancel</button>
      <div class="sheet-title">${esc(title)}</div>
      ${right || '<span style="width:54px"></span>'}</div>`;
  }

  /* ---- Start Workout flow ------------------------------------------------ */
  function startWorkout(presetKey) {
    // With a preset day the user already chose the workout → jump to tracking
    // (step 3). Without one, start from date selection (step 1).
    App.session = { step: presetKey ? 3 : 1, date: todayISO(), type: presetKey || null, exercises: [], duration: '', notes: '' };
    if (presetKey) loadTemplateIntoSession(presetKey);
    renderSessionSheet();
  }
  function loadTemplateIntoSession(key) {
    App.session.type = key;
    const tpl = App.state.templates[key];
    App.session.name = tpl.name;
    App.session.exercises = tpl.exercises.map(ex => ({ id: uid(), name: ex.name, sets: ex.sets, reps: ex.reps, weight: ex.weight, notes: ex.notes || '', done: false }));
  }

  function renderSessionSheet() {
    const s = App.session;
    let body = '';
    let foot = '';
    let title = 'New Workout';

    if (s.step === 1) {
      title = 'Select Date';
      body = `<div class="field"><label>Workout date</label>
        <input class="input" type="date" value="${s.date}" data-session="date" max="${todayISO()}"/></div>
        <div class="hint">Your week runs Monday to Sunday and resets every Monday.</div>`;
      foot = `<button class="btn primary full" data-action="session-next">Continue</button>`;
    } else if (s.step === 2) {
      title = 'Choose Workout';
      const ws = weekStats(parseDate(s.date));
      body = `<div class="day-pick">
        ${FT.PLAN_ORDER.map(key => {
          const tpl = App.state.templates[key];
          const suggested = key === ws.nextDay;
          const done = ws.daysDone.has(key);
          return `<button class="day-opt ${suggested ? 'suggested' : ''}" data-action="session-pick" data-key="${key}">
            <div class="d-tag">${FT.DAY_LABELS[key].replace(' ', '<br>')}</div>
            <div class="d-main"><div class="d-name">${esc(tpl.name.split('·')[0].trim())}</div>
              <div class="d-sub">${esc(tpl.name.split('·')[1] ? tpl.name.split('·')[1].trim() : tpl.exercises.length + ' exercises')}</div></div>
            ${suggested ? '<span class="d-badge">Next</span>' : done ? '<span class="d-badge" style="color:var(--success);background:var(--success-soft)">Done</span>' : ''}
          </button>`;
        }).join('')}
        <button class="day-opt other" data-action="session-pick" data-key="other">
          <div class="d-tag">Other</div>
          <div class="d-main"><div class="d-name">Other Activity</div>
            <div class="d-sub">Walk, run, yoga, swim… (doesn't affect the day cycle)</div></div></button>
      </div>`;
      foot = `<button class="btn ghost full" data-action="session-back">Back</button>`;
    } else if (s.step === 3) {
      title = s.name ? s.name.split('·')[0].trim() : 'Track Workout';
      body = `
        <div class="field-row">
          <div class="field"><label>Date</label><input class="input" type="date" value="${s.date}" data-session="date" max="${todayISO()}"/></div>
          <div class="field"><label>Duration (min)</label><input class="input" type="number" inputmode="numeric" placeholder="e.g. 60" value="${esc(s.duration)}" data-session="duration"/></div>
        </div>
        <div class="section-label" style="margin-top:4px;">Exercises</div>
        <div id="ex-list">${s.exercises.map(exEditCard).join('')}</div>
        <button class="btn ghost full" data-action="session-add-ex">${I.plus}<span>Add Exercise</span></button>
        <div class="field mt-16"><label>Session notes</label><textarea class="input" placeholder="How did it feel?" data-session="notes">${esc(s.notes)}</textarea></div>`;
      foot = `<button class="btn ghost" data-action="session-back" style="flex:0 0 38%">Back</button>
        <button class="btn success" style="flex:1" data-action="session-save">Save Workout</button>`;
    }

    openSheet(`${sheetHead(title, s.step === 3 ? '<span style="width:54px"></span>' : '')}
      <div class="steps">${[1, 2, 3].map(n => `<div class="dot ${stepGroup(s.step) >= n ? 'on' : ''}"></div>`).join('')}</div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot">${foot}</div>`, { full: s.step === 3 });
  }
  function stepGroup(step) { return step; } // 1,2,3 map directly

  function exEditCard(ex) {
    return `<div class="ex-edit" data-ex="${ex.id}">
      <div class="ee-head">
        ${exThumb(ex.name)}
        <input type="text" value="${esc(ex.name)}" placeholder="Exercise name" data-exfield="name"/>
        <button class="ex-del" data-action="session-del-ex" data-id="${ex.id}" aria-label="Remove">${I.trash}</button>
      </div>
      <div class="ee-grid">
        <div class="field"><label>Sets</label><input class="input" inputmode="numeric" value="${esc(ex.sets)}" data-exfield="sets"/></div>
        <div class="field"><label>Reps</label><input class="input" value="${esc(ex.reps)}" data-exfield="reps"/></div>
        <div class="field"><label>Weight (kg)</label><input class="input" inputmode="decimal" value="${esc(ex.weight)}" data-exfield="weight"/></div>
      </div>
      <div class="ee-note"><input class="input" placeholder="Notes (optional)" value="${esc(ex.notes || '')}" data-exfield="notes"/></div>
    </div>`;
  }

  // Pull current DOM values of the session exercise cards back into state.
  function syncSessionFromDOM() {
    const s = App.session; if (!s) return;
    const dateEl = modalRoot.querySelector('[data-session="date"]'); if (dateEl) s.date = dateEl.value || s.date;
    const durEl = modalRoot.querySelector('[data-session="duration"]'); if (durEl) s.duration = durEl.value;
    const notesEl = modalRoot.querySelector('[data-session="notes"]'); if (notesEl) s.notes = notesEl.value;
    modalRoot.querySelectorAll('[data-ex]').forEach(card => {
      const ex = s.exercises.find(e => e.id === card.dataset.ex); if (!ex) return;
      card.querySelectorAll('[data-exfield]').forEach(inp => { ex[inp.dataset.exfield] = inp.value; });
    });
  }

  function saveSession() {
    syncSessionFromDOM();
    const s = App.session;
    const exs = s.exercises.filter(e => (e.name || '').trim()).map(e => ({
      id: e.id, name: e.name.trim(), sets: e.sets, reps: e.reps,
      weight: e.weight === '' ? '' : num(e.weight), notes: e.notes || '',
    }));
    if (!exs.length) { toast('Add at least one exercise', 'err'); return; }
    App.state.workouts.push({
      id: uid(), date: s.date, type: s.type, name: s.name || FT.DAY_LABELS[s.type],
      duration: num(s.duration) || '', notes: s.notes || '', exercises: exs, createdAt: Date.now(),
    });
    save(); closeModal(); App.session = null;
    toast('Workout saved 💪');
    App.view = 'home'; render();
  }

  /* ---- Activity ("Other") form ------------------------------------------- */
  function addActivity(prefillDate) {
    const presets = FT.ACTIVITY_PRESETS.map(p => `<button type="button" class="chip" data-action="activity-preset" data-val="${esc(p)}">${esc(p)}</button>`).join('');
    openSheet(`${sheetHead('Add Activity')}
      <form class="sheet-body" data-form="activity">
        <div class="field"><label>Activity name</label>
          <input class="input" name="name" id="act-name" placeholder="e.g. Morning run" required/></div>
        <div class="chips" style="margin:-4px 0 14px;">${presets}</div>
        <div class="field-row">
          <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${prefillDate || todayISO()}" max="${todayISO()}"/></div>
          <div class="field"><label>Duration (min)</label><input class="input" type="number" inputmode="numeric" name="duration" placeholder="30"/></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Distance (km)</label><input class="input" inputmode="decimal" name="distance" placeholder="optional"/></div>
          <div class="field"><label>Calories</label><input class="input" inputmode="numeric" name="calories" placeholder="optional"/></div>
        </div>
        <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="optional"></textarea></div>
      </form>
      <div class="sheet-foot"><button class="btn primary full" data-action="submit-form" data-form="activity">Save Activity</button></div>`);
  }
  function saveActivity(data) {
    if (!data.name.trim()) { toast('Name is required', 'err'); return; }
    App.state.activities.push({
      id: uid(), name: data.name.trim(), date: data.date || todayISO(),
      duration: num(data.duration) || '', distance: num(data.distance) || '',
      calories: num(data.calories) || '', notes: data.notes || '', createdAt: Date.now(),
    });
    save(); closeModal(); toast('Activity added 🏃');
    render();
  }

  /* ---- Measurement form -------------------------------------------------- */
  function addMeasurement() {
    const last = sortedMeasurements().slice(-1)[0] || {};
    const fields = FT.MEASUREMENT_FIELDS.map(f =>
      `<div class="field"><label>${f.label} (${f.unit})</label>
        <input class="input" inputmode="decimal" name="${f.key}" value="${last[f.key] != null ? esc(last[f.key]) : ''}" placeholder="—"/></div>`).join('');
    openSheet(`${sheetHead('Log Measurement')}
      <form class="sheet-body" data-form="measurement">
        <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${todayISO()}" max="${todayISO()}"/></div>
        <div class="field-row">${fields}</div>
        <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="optional"></textarea></div>
        <div class="hint">Pre-filled with your last entry — adjust what changed.</div>
      </form>
      <div class="sheet-foot"><button class="btn primary full" data-action="submit-form" data-form="measurement">Save</button></div>`);
  }
  function saveMeasurement(data) {
    const rec = { id: uid(), date: data.date || todayISO(), notes: data.notes || '' };
    let any = false;
    FT.MEASUREMENT_FIELDS.forEach(f => { rec[f.key] = data[f.key] === '' ? '' : (data[f.key] != null ? data[f.key] : ''); if (rec[f.key] !== '') any = true; });
    if (!any) { toast('Enter at least one value', 'err'); return; }
    App.state.measurements.push(rec);
    save(); closeModal(); toast('Measurement saved 📏');
    render();
  }

  /* ---- Photos ------------------------------------------------------------ */
  function addPhoto() {
    openSheet(`${sheetHead('Add Progress Media')}
      <form class="sheet-body" data-form="photo">
        <div class="field"><label>Photo or video</label>
          <input class="input" type="file" name="file" accept="image/*,video/*" id="photo-file" required/>
          <div class="hint">On iPhone you can take a new photo or pick from your library.</div></div>
        <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${todayISO()}" max="${todayISO()}"/></div>
        <div class="field"><label>Notes</label><textarea class="input" name="notes" placeholder="e.g. front pose, after 4 weeks"></textarea></div>
      </form>
      <div class="sheet-foot"><button class="btn primary full" data-action="submit-form" data-form="photo">Save</button></div>`);
  }

  async function savePhoto(form) {
    const fileInput = form.querySelector('[name="file"]');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { toast('Choose a file first', 'err'); return; }
    const date = form.querySelector('[name="date"]').value || todayISO();
    const notes = form.querySelector('[name="notes"]').value || '';
    const kind = file.type.startsWith('video') ? 'video' : 'photo';
    toast('Saving…');
    try {
      const mediaId = uid();
      await FT.Media.put(mediaId, file);
      const thumb = await makeThumb(file, kind);
      App.state.photos.push({ id: uid(), date, notes, kind, mediaId, thumb });
      save(); closeModal(); toast('Saved ✓');
      render();
    } catch (err) {
      console.error(err); toast('Could not save media', 'err');
    }
  }

  // Generate a small JPEG thumbnail (data URL) from an image or video file.
  function makeThumb(file, kind) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const done = (dataURL) => { URL.revokeObjectURL(url); resolve(dataURL); };
      const draw = (source, w, h) => {
        const max = 400, scale = Math.min(max / w, max / h, 1);
        const cw = Math.round(w * scale), ch = Math.round(h * scale);
        const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
        try { canvas.getContext('2d').drawImage(source, 0, 0, cw, ch); done(canvas.toDataURL('image/jpeg', 0.72)); }
        catch (e) { done(''); }
      };
      if (kind === 'video') {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
        v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, v.duration || 0.1); } catch (e) { draw(v, v.videoWidth || 300, v.videoHeight || 300); } };
        v.onseeked = () => draw(v, v.videoWidth || 300, v.videoHeight || 300);
        v.onerror = () => done('');
        setTimeout(() => { if (v.readyState < 2) done(''); }, 3000);
      } else {
        const img = new Image(); img.onload = () => draw(img, img.naturalWidth, img.naturalHeight); img.onerror = () => done(''); img.src = url;
      }
    });
  }

  // Fullscreen photo/video viewer with swipe.
  async function viewPhoto(index) {
    const photos = [...App.state.photos].sort((a, b) => parseDate(a.date) - parseDate(b.date));
    if (!photos.length) return;
    App.viewer = { photos, index: Math.max(0, Math.min(index, photos.length - 1)), url: null };
    renderViewer();
  }
  async function renderViewer() {
    const v = App.viewer; const p = v.photos[v.index];
    if (v.url) { URL.revokeObjectURL(v.url); v.url = null; }
    modalRoot.innerHTML = `<div class="viewer" id="viewer">
      <div class="viewer-top">
        <button class="icon-btn" data-action="close-viewer">${I.close}</button>
        <div class="vt-date">${fmtDateLong(p.date)}</div>
        <button class="icon-btn" data-action="delete-photo" data-id="${p.id}">${I.trash}</button>
      </div>
      <div class="viewer-stage" id="viewer-stage">
        <div class="muted" style="color:#888">Loading…</div>
        ${v.photos.length > 1 ? `<button class="viewer-nav prev" data-action="viewer-prev"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <button class="viewer-nav next" data-action="viewer-next"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>` : ''}
      </div>
      <div class="viewer-bottom">${esc(p.notes || '')}${p.notes ? ' · ' : ''}${v.index + 1} / ${v.photos.length}</div>
    </div>`;
    attachSwipe();
    try {
      const blob = await FT.Media.get(p.mediaId);
      if (!blob) { $('#viewer-stage').insertAdjacentHTML('afterbegin', '<div style="color:#888">Media unavailable</div>'); return; }
      v.url = URL.createObjectURL(blob);
      const stage = $('#viewer-stage'); const placeholder = stage.querySelector('div'); if (placeholder) placeholder.remove();
      const media = p.kind === 'video'
        ? `<video src="${v.url}" controls playsinline></video>`
        : `<img src="${v.url}" alt="${esc(p.notes || 'progress photo')}"/>`;
      stage.insertAdjacentHTML('afterbegin', media);
    } catch (err) { console.error(err); }
  }
  function attachSwipe() {
    const stage = $('#viewer-stage'); if (!stage) return;
    let x0 = null;
    stage.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) dx < 0 ? viewerStep(1) : viewerStep(-1);
      x0 = null;
    }, { passive: true });
  }
  function viewerStep(dir) {
    const v = App.viewer; const ni = v.index + dir;
    if (ni < 0 || ni >= v.photos.length) return; v.index = ni; renderViewer();
  }
  function closeViewer() { const v = App.viewer; if (v && v.url) URL.revokeObjectURL(v.url); App.viewer = null; closeModal(); }

  async function deletePhoto(id) {
    if (!confirm('Delete this media permanently?')) return;
    const p = App.state.photos.find(x => x.id === id); if (!p) return;
    try { await FT.Media.delete(p.mediaId); } catch (e) {}
    App.state.photos = App.state.photos.filter(x => x.id !== id);
    save(); closeViewer(); toast('Deleted'); render();
  }

  /* ---- Entry detail (history) -------------------------------------------- */
  function viewEntry(kind, id) {
    if (kind === 'activity') {
      const a = App.state.activities.find(x => x.id === id); if (!a) return;
      openSheet(`${sheetHead('Activity')}
        <div class="sheet-body">
          <div class="card"><div class="card-title">${esc(a.name)}</div>
            <div class="page-sub">${fmtDateLong(a.date)}</div>
            <div class="stat-row" style="grid-template-columns:repeat(3,1fr);margin-top:14px;">
              <div class="stat"><div class="num">${a.duration || '—'}</div><div class="lbl">Minutes</div></div>
              <div class="stat"><div class="num">${a.distance || '—'}</div><div class="lbl">km</div></div>
              <div class="stat"><div class="num">${a.calories || '—'}</div><div class="lbl">kcal</div></div>
            </div>
            ${a.notes ? `<p class="muted small mt-12">${esc(a.notes)}</p>` : ''}
          </div>
        </div>
        <div class="sheet-foot"><button class="btn danger full" data-action="delete-entry" data-kind="activity" data-id="${id}">Delete</button></div>`);
      return;
    }
    const w = App.state.workouts.find(x => x.id === id); if (!w) return;
    const list = (w.exercises || []).map((ex) => `
      <div class="ex-item">${exThumb(ex.name)}
        <div class="ex-main"><div class="ex-name">${esc(ex.name)}</div>
          <div class="ex-meta"><span class="pill">${esc(ex.sets)} × ${esc(ex.reps)}</span>${ex.weight !== '' ? esc(kg(ex.weight)) : 'Bodyweight'}${ex.notes ? ` · ${esc(ex.notes)}` : ''}</div></div></div>`).join('');
    openSheet(`${sheetHead(FT.DAY_LABELS[w.type] || 'Workout')}
      <div class="sheet-body">
        <div class="card">
          <div class="card-title">${esc(w.name || FT.DAY_LABELS[w.type])}</div>
          <div class="page-sub">${fmtDateLong(w.date)}${w.duration ? ` · ${w.duration} min` : ''}</div>
          <div class="mt-12">${list || '<p class="muted small">No exercises recorded.</p>'}</div>
          ${w.notes ? `<p class="muted small mt-12">📝 ${esc(w.notes)}</p>` : ''}
        </div>
      </div>
      <div class="sheet-foot"><button class="btn danger full" data-action="delete-entry" data-kind="workout" data-id="${id}">Delete Workout</button></div>`);
  }
  function deleteEntry(kind, id) {
    if (!confirm('Delete this entry permanently?')) return;
    if (kind === 'activity') App.state.activities = App.state.activities.filter(x => x.id !== id);
    else App.state.workouts = App.state.workouts.filter(x => x.id !== id);
    save(); closeModal(); toast('Deleted'); render();
  }

  /* ---- Template editor --------------------------------------------------- */
  function editTemplate(key) {
    App.editKey = key;
    const tpl = App.state.templates[key];
    openSheet(`${sheetHead('Edit Template', `<button class="text-btn" data-action="save-template">Save</button>`)}
      <div class="sheet-body">
        <div class="field"><label>Template name</label><input class="input" id="tpl-name" value="${esc(tpl.name)}"/></div>
        <div class="section-label">Exercises</div>
        <div id="tpl-ex">${tpl.exercises.map(exEditCard).join('')}</div>
        <button class="btn ghost full" data-action="tpl-add-ex">${I.plus}<span>Add Exercise</span></button>
        <p class="hint mt-12">Changes are saved permanently and used next time you start ${FT.DAY_LABELS[key]}.</p>
      </div>`, { full: true });
  }
  function saveTemplate() {
    const key = App.editKey; const tpl = App.state.templates[key];
    const nameEl = $('#tpl-name'); if (nameEl) tpl.name = nameEl.value.trim() || tpl.name;
    const exs = [];
    modalRoot.querySelectorAll('#tpl-ex [data-ex]').forEach(card => {
      const ex = { id: card.dataset.ex };
      card.querySelectorAll('[data-exfield]').forEach(inp => { ex[inp.dataset.exfield] = inp.value; });
      if ((ex.name || '').trim()) exs.push({ id: ex.id, name: ex.name.trim(), sets: ex.sets, reps: ex.reps, weight: ex.weight === '' ? '' : num(ex.weight), notes: ex.notes || '' });
    });
    tpl.exercises = exs;
    save(); closeModal(); toast('Template updated'); render();
  }

  /* ---- Exercise demo image: viewer + attach ------------------------------ */
  function openExerciseMedia(name) {
    if (!name || !name.trim()) { toast('Name the exercise first', 'err'); return; }
    App.exMediaName = name;
    renderExerciseMedia();
  }

  async function renderExerciseMedia() {
    const name = App.exMediaName, key = exKey(name);
    const m = App.state.exerciseMedia[key];
    const c = EXCAT[exerciseCategory(name)] || EXCAT.generic;
    let stage;
    if (m && m.mediaId) stage = `<div class="exm-stage" id="exm-stage"><div class="muted small">Loading…</div></div>`;
    else if (m && m.url) stage = `<div class="exm-stage"><img src="${esc(m.url)}" alt="${esc(name)}"/></div>`;
    else stage = `<div class="exm-stage placeholder" style="--c1:${c.c1};--c2:${c.c2}"><svg viewBox="0 0 24 24">${c.g}</svg></div>`;

    openSheet(`${sheetHead(name)}
      <div class="sheet-body">
        ${stage}
        <p class="hint center mt-12">${m ? 'Tap below to change or remove this image.' : 'Add a photo or GIF so you can recognise this exercise at a glance. It stays on your device and is reused everywhere this exercise appears.'}</p>
        <input type="file" accept="image/*" id="exm-file" style="display:none"/>
      </div>
      <div class="sheet-foot" style="flex-wrap:wrap;gap:10px;">
        <button class="btn primary grow" data-action="exm-upload">${I.camera}<span>Upload image / GIF</span></button>
        <button class="btn ghost grow" data-action="exm-url">Use a link</button>
        ${m ? `<button class="btn danger full" data-action="exm-remove">Remove image</button>` : ''}
      </div>`);

    if (m && m.mediaId) {
      try {
        const blob = await FT.Media.get(m.mediaId);
        const st = $('#exm-stage');
        if (blob && st) {
          const url = URL.createObjectURL(blob);
          App._exmUrl = url;
          st.innerHTML = `<img src="${url}" alt="${esc(name)}"/>`;
        } else if (st) { st.innerHTML = '<div class="muted small">Image unavailable</div>'; }
      } catch (e) { console.error(e); }
    }
  }

  async function handleExmFile(file) {
    if (!file) return;
    const key = exKey(App.exMediaName);
    toast('Saving…');
    try {
      const old = App.state.exerciseMedia[key];
      const mediaId = uid();
      await FT.Media.put(mediaId, file);
      const thumb = await makeThumb(file, 'photo');
      if (old && old.mediaId) { try { await FT.Media.delete(old.mediaId); } catch (e) {} }
      App.state.exerciseMedia[key] = { kind: 'image', mediaId, thumb };
      save(); toast('Image added ✓'); renderExerciseMedia(); render();
    } catch (err) { console.error(err); toast('Could not save image', 'err'); }
  }

  async function setExerciseMediaUrl() {
    const url = prompt('Paste an image or GIF URL (https://…)');
    if (!url) return;
    if (!/^https?:\/\//i.test(url.trim())) { toast('Enter a valid https URL', 'err'); return; }
    const key = exKey(App.exMediaName);
    const old = App.state.exerciseMedia[key];
    if (old && old.mediaId) { try { await FT.Media.delete(old.mediaId); } catch (e) {} }
    App.state.exerciseMedia[key] = { kind: 'url', url: url.trim(), thumb: url.trim() };
    save(); toast('Image linked ✓'); renderExerciseMedia(); render();
  }

  async function removeExerciseMedia() {
    const key = exKey(App.exMediaName);
    const m = App.state.exerciseMedia[key];
    if (m && m.mediaId) { try { await FT.Media.delete(m.mediaId); } catch (e) {} }
    delete App.state.exerciseMedia[key];
    save(); toast('Image removed'); renderExerciseMedia(); render();
  }

  /* ---- Export / Import --------------------------------------------------- */
  async function exportData() {
    toast('Preparing backup…');
    try {
      const backup = await FT.Store.export(App.state);
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `pulse-backup-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Backup downloaded ✓');
    } catch (err) { console.error(err); toast('Export failed', 'err'); }
  }
  function importData() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files && input.files[0]; if (!file) return;
      if (!confirm('Importing will REPLACE all current data on this device. Continue?')) return;
      toast('Importing…');
      try {
        const text = await file.text();
        const backup = JSON.parse(text);
        App.state = await FT.Store.import(backup);
        applyTheme(); toast('Backup restored ✓'); App.view = 'home'; render();
      } catch (err) { console.error(err); toast(err.message || 'Import failed', 'err'); }
    };
    input.click();
  }

  /* =========================================================================
     7. EVENT HANDLING
     ========================================================================= */
  const actions = {
    nav: (d) => { App.view = d.view; if (d.tab) App.progressTab = d.tab; closeModal(); render(); },
    'progress-tab': (d) => { App.progressTab = d.tab; renderProgress(); },
    'start-workout': (d) => startWorkout(d.key || null),
    'add-activity': () => addActivity(),
    'add-measurement': () => addMeasurement(),
    'add-photo': () => addPhoto(),
    'close-modal': () => closeModal(),
    backdrop: (d, el, e) => { if (e.target.classList.contains('backdrop')) closeModal(); },
    'dismiss-photo-reminder': () => { App.state.settings.photoReminderDismissed = todayISO(); save(); renderHome(); },

    // session flow
    'session-next': () => { syncSessionDate(); App.session.step = 2; renderSessionSheet(); },
    'session-back': () => { App.session.step = Math.max(1, App.session.step - 1); renderSessionSheet(); },
    'session-pick': (d) => {
      if (d.key === 'other') { const date = App.session.date; App.session = null; addActivity(date); return; }
      loadTemplateIntoSession(d.key); App.session.step = 3; renderSessionSheet();
    },
    'session-add-ex': () => { syncSessionFromDOM(); App.session.exercises.push({ id: uid(), name: '', sets: 3, reps: '10', weight: '', notes: '', done: false }); renderSessionSheet(); },
    'session-del-ex': (d) => { syncSessionFromDOM(); App.session.exercises = App.session.exercises.filter(e => e.id !== d.id); renderSessionSheet(); },
    'session-save': () => saveSession(),

    'activity-preset': (d) => { const el = $('#act-name'); if (el) el.value = d.val; },

    'select-exercise': (d, el) => { App.selectedExercise = el.value; renderProgress(); },
    'select-measure': (d, el) => { App.selectedMeasure = el.value; renderProgress(); },

    'view-entry': (d) => viewEntry(d.kind, d.id),
    'delete-entry': (d) => deleteEntry(d.kind, d.id),
    'view-photo': (d) => viewPhoto(parseInt(d.index, 10)),
    'close-viewer': () => closeViewer(),
    'viewer-prev': () => viewerStep(-1),
    'viewer-next': () => viewerStep(1),
    'delete-photo': (d) => deletePhoto(d.id),

    'exercise-media': (d) => openExerciseMedia(d.name),
    'exm-upload': () => { const f = $('#exm-file'); if (f) { f.onchange = () => handleExmFile(f.files && f.files[0]); f.click(); } },
    'exm-url': () => setExerciseMediaUrl(),
    'exm-remove': () => removeExerciseMedia(),

    'edit-template': (d) => editTemplate(d.key),
    'save-template': () => saveTemplate(),
    'tpl-add-ex': () => {
      // persist current edits, then add row
      const tpl = App.state.templates[App.editKey];
      const tmp = [];
      modalRoot.querySelectorAll('#tpl-ex [data-ex]').forEach(card => {
        const ex = { id: card.dataset.ex };
        card.querySelectorAll('[data-exfield]').forEach(inp => { ex[inp.dataset.exfield] = inp.value; });
        tmp.push(ex);
      });
      tpl.exercises = tmp.map(e => ({ id: e.id, name: e.name, sets: e.sets, reps: e.reps, weight: e.weight, notes: e.notes || '' }));
      tpl.exercises.push({ id: uid(), name: '', sets: 3, reps: '10', weight: '', notes: '' });
      editTemplate(App.editKey);
    },

    // history filters
    'hist-range': (d) => { App.historyFilter.range = d.val; renderHistory(); },
    'hist-type': (d, el) => { App.historyFilter.type = el.value; renderHistory(); },
    'hist-exercise': (d, el) => { App.historyFilter.exercise = el.value; /* live filter handled on input */ },

    // settings
    'set-theme': (d) => { App.state.settings.theme = d.val; save(); applyTheme(); renderSettings(); },
    'set-target': (d, el) => { App.state.settings.weeklyTarget = parseInt(el.value, 10); save(); toast('Goal updated'); },
    'export-data': () => exportData(),
    'import-data': () => importData(),
    'reset-templates': () => {
      if (!confirm('Restore the default workout plan? Your custom template edits will be lost (logged workouts are kept).')) return;
      App.state.templates = FT.defaultState().templates; save(); toast('Templates reset'); render();
    },
    'clear-data': async () => {
      if (!confirm('This permanently erases ALL data on this device. Export a backup first if unsure. Continue?')) return;
      if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
      FT.Store.clear(); await FT.Media.clear();
      App.state = FT.Store.load(); applyTheme(); App.view = 'home'; closeModal(); toast('All data erased'); render();
    },

    'submit-form': (d) => submitForm(d.form),
  };

  function syncSessionDate() {
    const el = modalRoot.querySelector('[data-session="date"]'); if (el && App.session) App.session.date = el.value || App.session.date;
  }

  // Read a form's named inputs into a plain object.
  function readForm(formEl) {
    const data = {};
    formEl.querySelectorAll('[name]').forEach(inp => { data[inp.name] = inp.value; });
    return data;
  }
  function submitForm(name) {
    const formEl = modalRoot.querySelector(`[data-form="${name}"]`); if (!formEl) return;
    if (name === 'activity') saveActivity(readForm(formEl));
    else if (name === 'measurement') saveMeasurement(readForm(formEl));
    else if (name === 'photo') savePhoto(formEl);
  }

  // Single delegated click handler.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const action = el.dataset.action; const fn = actions[action];
    if (!fn) return;
    // Allow native behaviour for selects (handled on change), file inputs, date inputs
    if (['select-exercise', 'select-measure', 'hist-type', 'set-target', 'hist-exercise'].includes(action)) return;
    e.preventDefault();
    fn(el.dataset, el, e);
  });

  // Prevent native form submission (page reload) and route to our handler.
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (form) { e.preventDefault(); submitForm(form.dataset.form); }
  });

  // Change handler for selects + live history search.
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const a = el.dataset.action;
    if (a === 'select-exercise') { App.selectedExercise = el.value; renderProgress(); }
    else if (a === 'select-measure') { App.selectedMeasure = el.value; renderProgress(); }
    else if (a === 'hist-type') { App.historyFilter.type = el.value; renderHistory(); }
    else if (a === 'set-target') actions['set-target'](el.dataset, el);
  });
  // Live exercise filter in history (input event, preserves focus by not re-rendering whole list every keypress would lose focus; we re-render but refocus)
  let histDebounce = null;
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-action="hist-exercise"]'); if (!el) return;
    App.historyFilter.exercise = el.value;
    clearTimeout(histDebounce);
    histDebounce = setTimeout(() => {
      renderHistory();
      const again = viewEl.querySelector('[data-action="hist-exercise"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 220);
  });

  /* =========================================================================
     8. THEME + INIT
     ========================================================================= */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', App.state.settings.theme || 'auto');
  }

  // Optional service worker for offline / installable PWA (safe if it fails).
  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  let started = false;
  function init() {
    if (started) return;
    started = true;
    applyTheme();
    render();
    registerSW();
    // React to OS theme changes while in auto mode.
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ((App.state.settings.theme || 'auto') === 'auto') render();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  // In case the script loads after DOMContentLoaded already fired.
  if (document.readyState !== 'loading') init();
})();
