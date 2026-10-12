/* Read-only workout summaries. Reveal preferences are separate from workout storage. */
(function (root, factory) {
  const dates = typeof module === "object" && module.exports ? require("./dates.js") : root.LiftLogDates;
  const loads = typeof module === "object" && module.exports ? require("./exercise-load.js") : root.LiftLogExerciseLoad;
  const api = factory(root, dates, loads);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LiftLogRecaps = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, Dates, Loads) {
  "use strict";

  const MUSCLES = ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Forearms", "Quads",
    "Hamstrings", "Glutes", "Calves", "Core", "Cardio", "Other"];
  const SEEN_PREFIX = "liftlog_recap_seen_v1:";
  const FEMALE_ART = new Set(["workouts", ...MUSCLES.map(name => `muscle-${name.toLowerCase()}`)]);
  const TILE_DURATION = 530, TILE_DELAY = 105;
  const config = { getDB: () => ({ sessions: [], exercises: {}, templates: {} }),
    getUnit: () => "kg", formatWeight: null, assetBase: "assets/recap/", now: () => new Date(),
    getTheme: () => root.LiftLogTheme?.getTheme?.() || "light",
    weekStartsOn: 0, muscleColors: {}, scrollLock: null, onOpenChange: null };
  let dialog = null, panel = null, content = null, title = null, timer = null;
  let month = null, phase = "cover", returnFocus = null, lock = null, motionQuery = null;
  let animationVersion = 0;
  let preparedArt = null, idleWarmup = false;
  const warmedSources = new Set();
  const seen = createSeenState(() => root.localStorage);

  function validMonth(key) { return typeof key === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(key); }
  function createSeenState(getStorage) {
    const memory = new Set();
    return {
      has(key) {
        if (!validMonth(key)) return false;
        if (memory.has(key)) return true;
        try { if (getStorage()?.getItem(SEEN_PREFIX + key) === "1") memory.add(key); }
        catch (_) { /* A blocked preference store must not prevent a recap opening. */ }
        return memory.has(key);
      },
      mark(key) {
        if (!validMonth(key)) return false;
        memory.add(key);
        try { getStorage()?.setItem(SEEN_PREFIX + key, "1"); }
        catch (_) { /* Keep this tab's preference even when persistent storage is unavailable. */ }
        return true;
      }
    };
  }

  // Decode while the cover is still visible, with a bounded fallback for missing
  // assets or stalled WebKit decoders. This never touches workout storage.
  function prepareImages(images, { setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root), timeout = 1800 } = {}) {
    const usable = [...images].filter(image => typeof image.decode === "function" || typeof image.complete === "boolean");
    const state = { ready: usable.length === 0, promise: null };
    state.promise = Promise.all(usable.map(image => new Promise(resolve => {
      const source = image.src;
      let finished = false, decoding = false, deadline;
      function finish(ok) {
        if (finished) return;
        finished = true; clearTimer(deadline);
        if (!ok && image.src === source) { image.hidden = true; image.parentElement?.classList.add("recap-art-unavailable"); }
        resolve(ok);
      }
      function decode() {
        if (decoding || finished) return;
        decoding = true;
        if (typeof image.decode !== "function") { finish(image.naturalWidth > 0); return; }
        try { Promise.resolve(image.decode()).then(() => finish(true), () => finish(false)); }
        catch (_) { finish(false); }
      }
      deadline = setTimer(() => finish(false), timeout);
      image.addEventListener("load", decode, { once: true });
      image.addEventListener("error", () => finish(false), { once: true });
      if (image.complete) { if (image.naturalWidth > 0) decode(); else finish(false); }
      else if (typeof image.decode === "function") decode();
    }))).then(() => { state.ready = true; });
    return state;
  }

  function assetSource(name) {
    let purple = false;
    try { purple = typeof config.getTheme === "function" && config.getTheme() === "purple"; }
    catch (_) { /* Appearance helpers cannot prevent a recap from opening. */ }
    const base = String(config.assetBase).replace(/\/?$/, "/");
    return `${base}${purple && FEMALE_ART.has(name) ? "female/" : ""}${name}.webp`;
  }

  function warmImagesWhenIdle() {
    if (idleWarmup || typeof root.Image !== "function") return;
    idleWarmup = true;
    const warm = () => {
      idleWarmup = false;
      const names = ["workouts", "time", "weeks", "trophy", ...MUSCLES.map(name => `muscle-${name.toLowerCase()}`)];
      const sources = names.map(assetSource).filter(source => !warmedSources.has(source));
      const images = sources.map(source => { warmedSources.add(source);
        const image = new root.Image(); image.decoding = "async"; image.fetchPriority = "low";
        image.src = source; return image; });
      prepareImages(images);
    };
    // No work on the workout-start path and no network dependency for cached art.
    if (root.requestIdleCallback) root.requestIdleCallback(warm, { timeout: 5000 });
    else root.setTimeout(warm, 1400);
  }

  function asDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Dates
      ? Dates.parseLocalDay(value) : new Date(value);
  }
  function monthKey(value) {
    const date = asDate(value);
    if (!Number.isFinite(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  function monthBounds(key) {
    if (typeof key !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new RangeError("Use a month in YYYY-MM format.");
    const [year, number] = key.split("-").map(Number);
    if (year < 1000) throw new RangeError("The recap year is invalid.");
    return { start: new Date(year, number - 1, 1), end: new Date(year, number, 1) };
  }
  function dateNow() { return asDate(typeof config.now === "function" ? config.now() : config.now); }
  function completedSets(sets, exercise) {
    if (Dates && typeof Dates.completedSets === "function") return Dates.completedSets(sets, exercise);
    const number = value => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
    return (Array.isArray(sets) ? sets : []).filter(set => set && set.completed !== false &&
      (exercise?.type === "cardio" ? (number(set.time) && Number(set.time) > 0) || (number(set.dist) && Number(set.dist) > 0)
        : number(set.r) && Number(set.r) > 0 && Number.isInteger(Number(set.r)) &&
          (set.w === "" || set.w === null || set.w === undefined || number(set.w))));
  }
  function completedSessions(db, now) {
    const exercises = db?.exercises || {};
    return (Array.isArray(db?.sessions) ? db.sessions : []).filter(session => {
      if (!session || !session.start || !session.end) return false;
      const start = asDate(session.start).getTime(), end = asDate(session.end).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end >= start && end <= now.getTime()
        && Object.entries(session.entries || {}).some(([id, sets]) => completedSets(sets, exercises[id]).length);
    }).slice().sort((a, b) => asDate(a.start) - asDate(b.start) || String(a.id || "").localeCompare(String(b.id || "")));
  }
  function localWeekKey(value, weekStartsOn) {
    const date = asDate(value);
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (date.getDay() - weekStartsOn + 7) % 7);
    return Dates ? Dates.localDayKey(start) : `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
  }
  function rankCounts(counts) {
    return Object.entries(counts).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  function displayMonth(key) {
    const { start } = monthBounds(key);
    return start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }

  /** Canonical kg records; positive external-load strength sets only. */
  function eligiblePB(exercise, set) {
    if (!exercise || exercise.type === "cardio") return false;
    const mode = Loads ? Loads.resolveSetMode(set, exercise) : set?.loadType || (exercise.isAssisted ? 'assisted' : 'external');
    if (mode !== 'external') return false;
    // Explicit per-set mode outranks library defaults and retained legacy flags.
    // Keep the old bodyweight safeguards only for untyped historical sets.
    if (!set?.loadType && (exercise.isBodyweight || /body\s*weight/i.test(String(exercise.equip || "")))) return false;
    return Number.isFinite(Number(set.w)) && Number(set.w) > 0 && Number.isInteger(Number(set.r)) && Number(set.r) > 0;
  }
  function findPersonalBest(sessions, exercises, start, end) {
    const prior = new Map(), records = [];
    // Group simultaneous starts: one workout's own sets must not invent its baseline.
    for (let index = 0; index < sessions.length;) {
      const stamp = asDate(sessions[index].start).getTime(), group = [];
      while (index < sessions.length && asDate(sessions[index].start).getTime() === stamp) group.push(sessions[index++]);
      if (stamp >= end.getTime()) break;
      const updates = new Map();
      group.forEach(session => Object.entries(session.entries || {}).forEach(([id, sets]) => {
        const exercise = exercises[id];
        completedSets(sets, exercise).filter(set => eligiblePB(exercise, set)).forEach(set => {
          const reps = Number(set.r), weightKg = Number(set.w), key = `${id}\u0000${reps}`;
          const previous = prior.get(key);
          if (stamp >= start.getTime() && previous && weightKg > previous.weightKg + 1e-8) {
            records.push({ exerciseId: id, exerciseName: exercise.name || "Exercise", reps, weightKg,
              previousWeightKg: previous.weightKg, improvementKg: weightKg - previous.weightKg,
              date: session.start, previousDate: previous.date, sessionId: session.id });
          }
          if (!updates.has(key) || updates.get(key).weightKg < weightKg) updates.set(key, { weightKg, date: session.start });
        });
      }));
      updates.forEach((record, key) => { if (!prior.has(key) || record.weightKg > prior.get(key).weightKg) prior.set(key, record); });
    }
    // Prefer the latest evidenced best; do not rank unrelated exercises by kilograms.
    records.sort((a, b) => asDate(b.date) - asDate(a.date) || a.exerciseName.localeCompare(b.exerciseName)
      || b.reps - a.reps || b.weightKg - a.weightKg);
    return records[0] || null;
  }

  function summarizeMonth(db, key, options = {}) {
    const { start, end } = monthBounds(key);
    const now = asDate(options.now === undefined ? new Date() : options.now);
    if (!Number.isFinite(now.getTime())) throw new RangeError("The current date is invalid.");
    const isCompletedMonth = end <= new Date(now.getFullYear(), now.getMonth(), 1);
    const result = { monthKey: key, label: displayMonth(key), isCompletedMonth, hasData: false,
      workoutCount: 0, durationMs: 0, totalMinutes: 0, activeWeeks: 0, completedStrengthSets: 0,
      muscleSets: {}, topMuscle: null, favouriteRoutine: null, personalBest: null, highlight: null, highlights: [],
      weekStartsOn: options.weekStartsOn === 1 ? 1 : 0, timeDefinition: "Elapsed completed-workout time, including rests." };
    if (!isCompletedMonth) return result;
    const exercises = db?.exercises || {}, all = completedSessions(db, now);
    const selected = all.filter(session => asDate(session.start) >= start && asDate(session.start) < end);
    const weeks = new Set(), routineCounts = Object.create(null), routines = new Map();
    selected.forEach(session => {
      result.workoutCount++;
      result.durationMs += asDate(session.end).getTime() - asDate(session.start).getTime();
      weeks.add(localWeekKey(session.start, result.weekStartsOn));
      const routineName = String(session.templateName || db?.templates?.[session.templateId]?.name || "").trim();
      if ((session.templateId || routineName) && routineName.toLowerCase() !== "freestyle") {
        const id = String(session.templateId || `name:${routineName}`);
        routineCounts[id] = (routineCounts[id] || 0) + 1;
        routines.set(id, routineName || "Saved routine");
      }
      Object.entries(session.entries || {}).forEach(([id, sets]) => {
        const exercise = exercises[id];
        if (exercise?.type === "cardio") return;
        const count = completedSets(sets, exercise).length;
        if (!count) return;
        const muscle = MUSCLES.includes(exercise?.muscle) && exercise.muscle !== "Cardio" ? exercise.muscle : "Other";
        result.muscleSets[muscle] = (result.muscleSets[muscle] || 0) + count;
        result.completedStrengthSets += count;
      });
    });
    result.hasData = result.workoutCount > 0;
    result.totalMinutes = Math.round(result.durationMs / 60000);
    result.activeWeeks = weeks.size;
    const muscles = rankCounts(result.muscleSets);
    if (muscles.length) {
      const ties = muscles.filter(item => item.count === muscles[0].count).map(item => item.name);
      result.topMuscle = { name: muscles[0].name, sets: muscles[0].count, tied: ties.length > 1, ties };
    }
    const rankedRoutines = Object.entries(routineCounts).map(([id, count]) => ({ id, count, name: routines.get(id) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    if (rankedRoutines.length) {
      const first = rankedRoutines[0], ties = rankedRoutines.filter(item => item.count === first.count).map(item => item.name);
      result.favouriteRoutine = { ...first, tied: ties.length > 1, ties };
    }
    result.personalBest = findPersonalBest(all, exercises, start, end);
    if (result.personalBest) result.highlights.push({ kind: "personalBest", data: result.personalBest });
    if (result.topMuscle) result.highlights.push({ kind: "muscle", data: result.topMuscle });
    if (result.favouriteRoutine?.count >= 2) result.highlights.push({ kind: "routine", data: result.favouriteRoutine });
    if (result.highlights.length) result.highlight = result.personalBest ? result.highlights[0]
      : result.highlights[(start.getFullYear() * 12 + start.getMonth()) % result.highlights.length];
    return result;
  }

  function availableMonths(db = config.getDB(), now = dateNow()) {
    now = asDate(now);
    if (!Number.isFinite(now.getTime())) return [];
    const current = monthKey(now);
    return [...new Set(completedSessions(db, now).map(session => monthKey(session.start)).filter(key => key && key < current))].sort().reverse();
  }
  function latestMonth(db = config.getDB(), now = dateNow()) {
    now = asDate(now);
    const key = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    return key && availableMonths(db, now).includes(key) ? key : null;
  }
  function formatDuration(minutes) {
    if (minutes === 0) return "<1 min";
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }
  function configure(options = {}) {
    Object.keys(config).forEach(key => { if (Object.prototype.hasOwnProperty.call(options, key)) config[key] = options[key]; });
    warmImagesWhenIdle();
    return api;
  }
  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, className, action) {
    const node = el("button", className, label); node.type = "button"; node.addEventListener("click", action); return node;
  }
  function art(name, className) {
    const image = el("img", className); image.alt = ""; image.decoding = "async"; image.draggable = false;
    image.dataset.recapAsset = name;
    image.src = assetSource(name);
    image.addEventListener("error", () => { image.hidden = true; image.parentElement?.classList.add("recap-art-unavailable"); });
    return image;
  }
  function refreshArtwork() {
    warmImagesWhenIdle();
    if (!dialog?.open) return;
    let changed = false;
    dialog.querySelectorAll("img").forEach(image => {
      const name = image.dataset.recapAsset;
      if (!name) return;
      const source = assetSource(name);
      // Browsers resolve img.src to an absolute URL; the attribute preserves the
      // relative source and keeps repeated theme notifications inexpensive.
      const previous = image.getAttribute ? image.getAttribute("src") : image.src;
      if (previous === source) return;
      image.hidden = false;
      image.parentElement?.classList.remove("recap-art-unavailable");
      image.src = source;
      changed = true;
    });
    if (changed) preparedArt = prepareImages(dialog.querySelectorAll("img"));
  }
  function reducedMotion() { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function clearAnimation() { animationVersion++; if (timer !== null) root.clearTimeout(timer); timer = null; }
  function setPhase(next) {
    phase = next; if (panel) panel.dataset.phase = next;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = el("dialog", "neo-modal recap-modal"); dialog.setAttribute("aria-labelledby", "recap-dialog-title");
    const header = el("header", "recap-modal-header");
    title = el("h2", "recap-dialog-title", "Month in review"); title.id = "recap-dialog-title";
    const closeButton = button("×", "recap-close", close); closeButton.setAttribute("aria-label", "Close month in review");
    header.append(title, closeButton);
    content = el("div", "recap-modal-scroll"); dialog.append(header, content);
    dialog.addEventListener("close", finishClose);
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    root.document.body.append(dialog);
    motionQuery = root.matchMedia?.("(prefers-reduced-motion: reduce)");
    const changed = () => { if (motionQuery.matches && ["opening", "revealing"].includes(phase)) showTiles(false, true); };
    if (motionQuery?.addEventListener) motionQuery.addEventListener("change", changed);
  }
  function weightText(kg) {
    const unit = config.getUnit() === "lbs" || config.getUnit() === "lb" ? "lbs" : "kg";
    const value = typeof config.formatWeight === "function" ? config.formatWeight(kg, unit)
      : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(unit === "lbs" ? kg * 2.2046226218 : kg);
    return `${value} ${unit}`;
  }
  function tile(label, value, detail, asset, className = "") {
    const card = el("article", `recap-tile ${className}`);
    const copy = el("div", "recap-tile-copy");
    copy.append(el("p", "recap-tile-label", label), el("p", "recap-tile-value", value));
    if (detail) copy.append(el("p", "recap-tile-detail", detail));
    card.append(copy, art(asset, "recap-tile-art")); return card;
  }
  function highlightTile(highlight) {
    let card;
    if (highlight?.kind === "personalBest") {
      const best = highlight.data;
      card = tile(`Best at ${best.reps} reps`, weightText(best.weightKg), `${best.exerciseName} · previously ${weightText(best.previousWeightKg)} at ${best.reps} reps`, "trophy", "recap-tile-wide recap-highlight");
    } else if (highlight?.kind === "muscle") {
      const muscle = highlight.data;
      card = tile(muscle.tied ? "Joint most logged" : "Most logged muscle", muscle.ties.join(" / "),
        `${muscle.sets} completed ${muscle.sets === 1 ? "set" : "sets"}${muscle.tied ? " each" : ""} · primary muscle only`,
        muscle.tied ? "weeks" : `muscle-${muscle.name.toLowerCase()}`, "recap-tile-wide recap-highlight");
      if (!muscle.tied && config.muscleColors[muscle.name]) card.style.setProperty("--recap-muscle-color", config.muscleColors[muscle.name]);
    } else if (highlight?.kind === "routine") {
      const routine = highlight.data;
      card = tile(routine.tied ? "Joint most used routines" : "Most used routine", routine.ties.join(" / "),
        `${routine.count} workouts${routine.tied ? " each" : ""}`, "workouts", "recap-tile-wide recap-highlight");
    } else {
      card = tile("Your record", "A month logged", "Your completed workouts are here whenever you want to look back.", "weeks", "recap-tile-wide recap-highlight");
    }
    return card;
  }
  function buildHighlights(summary) {
    const choices = summary.highlights.length ? summary.highlights : [null];
    let selected = Math.max(0, choices.indexOf(summary.highlight));
    const card = el("article", "recap-tile recap-tile-wide recap-highlight");
    const stage = el("div", "recap-highlight-stage");
    // Each real panel occupies the same grid cell, so the largest determines the
    // stable height. Inactive panels are invisible and excluded from accessibility.
    const panels = choices.map((choice, index) => {
      const source = highlightTile(choice), item = el("div", "recap-highlight-panel");
      item.append(...source.childNodes);
      item.dataset.index = String(index);
      stage.append(item);
      return item;
    });
    card.append(stage);
    let count = null;
    function select(index, animate) {
      selected = (index + choices.length) % choices.length;
      panels.forEach((item, itemIndex) => {
        const active = itemIndex === selected;
        item.setAttribute("aria-hidden", active ? "false" : "true");
        item.classList.toggle("is-current", active);
        item.classList.toggle("is-entering", active && animate && !reducedMotion());
      });
      const current = choices[selected];
      const colour = current?.kind === "muscle" && !current.data.tied ? config.muscleColors[current.data.name] : null;
      if (colour) card.style.setProperty("--recap-muscle-color", colour);
      else card.style.removeProperty("--recap-muscle-color");
      if (count) { count.textContent = `${selected + 1} / ${choices.length}`;
        count.setAttribute("aria-label", `Highlight ${selected + 1} of ${choices.length}: ${panels[selected].textContent}`); }
    }
    if (choices.length > 1) {
      const controls = el("div", "recap-highlight-controls");
      const previous = button("‹", "recap-highlight-nav", () => select(selected - 1, true));
      previous.setAttribute("aria-label", "Previous monthly highlight");
      const next = button("›", "recap-highlight-nav", () => select(selected + 1, true));
      next.setAttribute("aria-label", "Next monthly highlight");
      count = el("span", "recap-highlight-count"); count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite");
      controls.append(previous, count, next); card.append(controls);
    }
    select(selected, false);
    return card;
  }
  function buildTiles(summary) {
    const tiles = el("div", "recap-spotlight");
    tiles.append(tile("Workouts", String(summary.workoutCount), "", "workouts", "recap-workouts"));
    tiles.append(tile("Time", formatDuration(summary.totalMinutes), "", "time", "recap-time"));
    tiles.append(tile("Active weeks", String(summary.activeWeeks), "", "weeks", "recap-weeks"));
    tiles.append(buildHighlights(summary));
    [...tiles.children].forEach((node, index) => node.style.setProperty("--recap-tile-index", String(index)));
    return tiles;
  }
  function archive(db, currentKey) {
    const wrap = el("section", "recap-archive"); wrap.setAttribute("aria-label", "Monthly recap archive");
    wrap.append(el("h3", "recap-archive-title", "Previous months"));
    const months = availableMonths(db, dateNow());
    if (!months.length) wrap.append(el("p", "recap-explanation", "Completed months will appear here after you log a workout."));
    months.forEach(key => {
      const item = button(displayMonth(key), "recap-archive-button", () => renderMonth(key));
      if (key === currentKey) { item.setAttribute("aria-current", "true"); item.append(el("span", "recap-archive-current", "Viewing")); }
      else item.append(el("span", "recap-archive-arrow", "↗"));
      wrap.append(item);
    });
    return wrap;
  }
  function showTiles(animate = true, remember = false) {
    clearAnimation();
    const cover = panel?.querySelector(".recap-cover"), body = panel?.querySelector(".recap-results");
    if (!cover || !body) return;
    cover.hidden = true; body.hidden = false;
    const moving = animate && !reducedMotion();
    panel.classList.toggle("recap-animate-tiles", moving);
    const key = month, version = animationVersion;
    let completed = false;
    function complete() {
      if (completed || version !== animationVersion || month !== key || !dialog?.open) return;
      completed = true;
      if (timer !== null) root.clearTimeout(timer); timer = null;
      setPhase("revealed");
      if (remember) seen.mark(key);
    }
    if (moving) {
      setPhase("revealing");
      const tiles = body.querySelector(".recap-spotlight").children, last = tiles[tiles.length - 1];
      last?.addEventListener("animationend", event => {
        if (event.target === last && event.animationName === "recap-tile-unfurl") complete();
      });
      // CSS event timing follows the actual last tile; the fallback handles unavailable animations.
      timer = root.setTimeout(complete, TILE_DURATION + TILE_DELAY * Math.max(0, tiles.length - 1) + 100);
    } else { setPhase("revealed"); if (remember) complete(); }
    const heading = body.querySelector(".recap-results-heading"); heading?.focus({ preventScroll: true });
    content.scrollTop = 0;
  }
  function reveal() {
    if (phase !== "cover") return;
    const revealButton = panel.querySelector(".recap-reveal"); revealButton.disabled = true;
    const version = animationVersion;
    function start() {
      if (version !== animationVersion || !dialog?.open) return;
      if (reducedMotion()) { showTiles(false, true); return; }
      revealButton.textContent = "Reveal";
      setPhase("opening");
      timer = root.setTimeout(() => {
        if (version === animationVersion && dialog?.open) showTiles(true, true);
      }, 900);
    }
    function waitForArtwork() {
      if (version !== animationVersion || !dialog?.open) return;
      if (preparedArt && !preparedArt.ready) {
        setPhase("preparing"); revealButton.textContent = "Preparing…";
        preparedArt.promise.then(waitForArtwork);
      } else start();
    }
    waitForArtwork();
  }
  function focusMonth() {
    panel?.querySelector(phase === "cover" ? ".recap-reveal" : ".recap-results-heading")?.focus({ preventScroll: true });
  }
  function renderArchive() {
    clearAnimation(); month = null; title.textContent = "Previous months";
    panel = el("section", "recap-panel");
    panel.append(archive(config.getDB(), null)); content.replaceChildren(panel); content.scrollTop = 0;
    setPhase("archive");
    const heading = panel.querySelector(".recap-archive-title"); heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  function renderMonth(key) {
    clearAnimation();
    const db = config.getDB(), summary = summarizeMonth(db, key, { now: dateNow(), weekStartsOn: config.weekStartsOn });
    month = key; title.textContent = summary.label;
    content.replaceChildren();
    panel = el("section", "recap-panel"); panel.dataset.phase = "cover";
    if (!summary.hasData) {
      panel.append(el("p", "recap-empty", summary.isCompletedMonth ? "No completed workouts recorded for this month." : "This recap becomes available after the month ends."));
      content.append(panel, archive(db, key)); setPhase("empty"); return;
    }
    const cover = el("div", "recap-cover");
    const coverStage = el("div", "recap-cover-stage");
    coverStage.append(art("trophy", "recap-cover-art"));
    cover.append(coverStage, button("Reveal", "recap-reveal", reveal), button("Previous months", "recap-archive-link", renderArchive));
    const result = el("div", "recap-results"); result.hidden = true;
    const heading = el("h3", "recap-results-heading", "Your month in review"); heading.tabIndex = -1;
    result.append(heading, buildTiles(summary));
    const details = el("details", "recap-method"); details.append(el("summary", "", "What counts?"));
    details.append(el("p", "", "Finished workouts with at least one completed entry, grouped by their local start date. Time includes rests and uses the current start and finish times. Unfinished and empty workouts are excluded."));
    details.append(el("p", "", `Active weeks start on ${summary.weekStartsOn === 1 ? "Monday" : "Sunday"}; this is an activity count, not a streak goal. Muscle totals count strength sets for the primary muscle only, using your current exercise definitions.`));
    details.append(el("p", "", "A best needs a heavier positive external load at the same rep count for the same exercise, compared with all earlier completed workouts. Assisted, bodyweight, weighted-bodyweight and cardio sets are excluded. A first logged result is not called a personal best."));
    result.append(details, archive(db, key));
    panel.append(cover, result); content.append(panel); setPhase("cover"); content.scrollTop = 0;
    preparedArt = prepareImages(panel.querySelectorAll("img"));
    if (seen.has(key)) showTiles(false);
    if (dialog.open) focusMonth();
  }
  function open(key, options = {}) {
    if (!root.document) return false;
    const db = config.getDB(), months = availableMonths(db, dateNow());
    key = key || months[0]; if (!key) return false;
    monthBounds(key);
    ensureDialog();
    if (!dialog.open) returnFocus = root.document.activeElement;
    if (options.archive) renderArchive(); else renderMonth(key);
    if (!dialog.open) {
      if (config.scrollLock) lock = config.scrollLock;
      else if (!lock && root.LiftLogLogging?.createScrollLock) lock = root.LiftLogLogging.createScrollLock(root, root.document);
      lock?.acquire("recap");
      try { dialog.showModal(); } catch (error) { lock?.release("recap"); throw error; }
    }
    if (options.archive) {
      const archiveHeading = panel.querySelector(".recap-archive-title");
      if (archiveHeading) { archiveHeading.tabIndex = -1; archiveHeading.focus({ preventScroll: true });
        content.scrollTop = Math.max(0, archiveHeading.offsetTop - content.offsetTop - 12); }
    } else focusMonth();
    if (config.onOpenChange) config.onOpenChange(true);
    return true;
  }
  function finishClose() {
    clearAnimation(); lock?.release("recap");
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    if (config.onOpenChange) config.onOpenChange(false);
  }
  function close() { clearAnimation(); if (dialog?.open) dialog.close(); }
  function openArchive() { return open(undefined, { archive: true }); }
  function isOpen() { return !!dialog?.open; }
  function refresh() { if (isOpen()) { if (month) renderMonth(month); else renderArchive(); } }

  const api = { configure, summarizeMonth, availableMonths, latestMonth, monthKey, displayMonth,
    formatDuration, open, openArchive, close, isOpen, refresh, refreshArtwork, assetSource, createSeenState, prepareImages };
  return api;
});
