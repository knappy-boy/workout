/**
 * LIFTLOG ULTRA - Neobrutalist Edition
 * 2026 Refactor
 */

const DB_KEY = "liftlog_ultra_v1";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --- DEFAULT DATA & MIGRATION ---
const DEFAULT_DB = {
  user: {
    theme: "light",
    increment: 2.5,
    useLbs: false,        // false = kg, true = lbs
    showSuggestions: true,
    includeCompound: true, // retained for backup compatibility; charts use only the primary muscle
    trainingGoal: "hypertrophy", // hypertrophy or strength
    bodyweight: null      // user's bodyweight for assisted exercises
  },
  exercises: {}, // id -> {id, name, type, muscle, equip, increment, isAssisted, isCompound, secondaryMuscles, cardioGoal}
  templates: {}, // id -> {id, name, exercises: [{exId, sets}]}
  sessions: [],  // [{id, start, end, name, notes, entries: {exId: [{w, r, note, type}] } }]
  bodyweight: [], // [{date, kg}]
  goals: {}
};

// Conversion constants
const KG_TO_LBS = 2.20462;
const LBS_TO_KG = 0.453592;

// Bodyweight chart state
let _bwPeriod = "month"; // "month", "year", "all"
let _bwZoom = 1;
let _bwPanOffset = 0; // as percentage of visible range
let _bwIsDragging = false;
let _bwDragStart = 0;
let _bwPanStart = 0;

// Persistent state lives separately from the cached app files.
const copyState = value => JSON.parse(JSON.stringify(value));
let DB = copyState(DEFAULT_DB);
let ACTIVE_SESSION = null;
let WORKOUT_TIMER = null;
const STORE = LiftLogStorage;
let STORE_READY = false, STORAGE_ERROR = null, STORAGE_REVISION = 0, STORAGE_EPOCH = 0;
let BASE_DB = copyState(DB), BASE_DRAFT = null;
let QUEUED_DB = copyState(DB), QUEUED_DRAFT = null;
let SAVE_QUEUE = Promise.resolve(true), PENDING_SAVES = 0, UPDATE_LOCK = false;
let FINISHING = false, STARTING = false, COMMITTING = false, EXTERNAL_CHANGE = false;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
}
function showNotice(message, kind = "info") {
  const notice = document.querySelector("#appNotice");
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}
function updateReliabilityStrip() {
  const save = document.querySelector("#saveStatus");
  const update = document.querySelector("#updateStatus");
  const strip = document.querySelector(".save-strip");
  if (strip) strip.hidden = (save.hidden || !save.textContent) && (update.hidden || !update.textContent);
}
function updateSaveStatus() {
  if ((UPDATE_LOCK || COMMITTING) && typeof clearActiveDrag === 'function') clearActiveDrag();
  const text = STORAGE_ERROR ? "Not saved — action needed" :
    !STORE_READY ? "Opening your saved data…" : PENDING_SAVES ? "Saving…" : "Saved on this device";
  const status = document.querySelector("#saveStatus");
  status.textContent = text;
  // Ordinary saves stay quiet in every build; failures remain visible.
  status.hidden = STORE_READY && !STORAGE_ERROR;
  const loggerStatus = document.querySelector("#logSaveStatus");
  if (loggerStatus) {
    loggerStatus.textContent = text;
    loggerStatus.hidden = !STORAGE_ERROR;
    loggerStatus.dataset.kind = STORAGE_ERROR ? "error" : "saved";
  }
  updateReliabilityStrip();
  document.querySelector("#storageProblem").hidden = !STORAGE_ERROR;
  if (STORAGE_ERROR) document.querySelector("#storageProblemText").textContent = STORAGE_ERROR.message;
  document.querySelector("#appShell").inert = !STORE_READY || UPDATE_LOCK || COMMITTING;
}
function storageFailure(error) {
  STORAGE_ERROR = error;
  updateSaveStatus();
  return false;
}
function rememberSnapshot(snapshot) {
  BASE_DB = copyState(snapshot.db); BASE_DRAFT = copyState(snapshot.draft);
  STORAGE_REVISION = snapshot.revision; STORAGE_EPOCH = snapshot.epoch;
}
function applySnapshot(snapshot) {
  rememberSnapshot(snapshot);
  DB = copyState(snapshot.db); ACTIVE_SESSION = copyState(snapshot.draft);
  QUEUED_DB = copyState(DB); QUEUED_DRAFT = copyState(ACTIVE_SESSION);
  STORAGE_ERROR = null; STORE_READY = true; EXTERNAL_CHANGE = false;
  LiftLogTheme.apply(DB.user.theme);
  updateSaveStatus();
}
function queueStateSave(kind) {
  if (!STORE_READY || STORAGE_ERROR) return Promise.resolve(false);
  const edited = copyState(kind === "db" ? DB : ACTIVE_SESSION);
  const base = copyState(kind === "db" ? QUEUED_DB : QUEUED_DRAFT);
  if (LiftLogStorage.equal(edited, base)) return SAVE_QUEUE;
  const epoch = STORAGE_EPOCH;
  if (kind === "db") QUEUED_DB = copyState(edited); else QUEUED_DRAFT = copyState(edited);
  PENDING_SAVES++; updateSaveStatus();
  SAVE_QUEUE = SAVE_QUEUE.then(async () => {
    if (STORAGE_ERROR) return false;
    try {
      const result = await (kind === "db" ? STORE.saveDB(edited, base, {epoch}) : STORE.saveDraft(edited, base, {epoch}));
      STORAGE_REVISION = result.revision;
      // A write to one part must never adopt another window’s newer baseline.
      // Otherwise retry/finish could treat stale local data as intentional deletion.
      if (kind === "db") BASE_DB = copyState(edited); else BASE_DRAFT = copyState(edited);
      if (kind === "db" && LiftLogStorage.equal(DB, edited)) {
        DB = copyState(result.db); QUEUED_DB = copyState(DB); BASE_DB = copyState(DB);
      }
      if (kind === "draft" && LiftLogStorage.equal(ACTIVE_SESSION, edited)) {
        ACTIVE_SESSION = copyState(result.draft); QUEUED_DRAFT = copyState(ACTIVE_SESSION);
      }
      return true;
    } catch (error) { return storageFailure(error); }
  }).finally(() => { PENDING_SAVES--; updateSaveStatus(); });
  return SAVE_QUEUE;
}
function saveDB() { return queueStateSave("db"); }
function saveDraft() { return queueStateSave("draft"); }
async function flushSaves() {
  await saveDB(); await saveDraft(); await SAVE_QUEUE;
  return !STORAGE_ERROR && STORE_READY;
}
function hasOpenEditor() {
  return Boolean(document.querySelector(".overlay:not(.hidden), dialog[open]")) ||
    Boolean(document.activeElement && document.activeElement.matches("input, textarea, select") && document.activeElement.value);
}
function canUpdate() { return STORE_READY && !STORAGE_ERROR && !PENDING_SAVES && !ACTIVE_SESSION && !FINISHING && !STARTING && !COMMITTING && !hasOpenEditor(); }
async function refreshSavedData(force = false) {
  if (!STORE_READY || PENDING_SAVES || (!force && (ACTIVE_SESSION || hasOpenEditor() || STORAGE_ERROR))) return;
  try {
    const latest = await STORE.load();
    // Recheck after the async read: never replace an edit which began during it.
    if (PENDING_SAVES || (!force && (ACTIVE_SESSION || hasOpenEditor() || STORAGE_ERROR))) return;
    applySnapshot(latest);
    renderCurrentTab(document.querySelector(".tab.active").dataset.tab);
    if (ACTIVE_SESSION) showNotice("An unfinished workout is saved. Choose Resume workout to continue.");
  } catch (error) { storageFailure(error); }
}
function downloadJSON(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// In-page dialogs keep confirmation accessible and reliable in installed mode.
function askDialog(title, message, text = false) {
  const dialog = document.querySelector("#appDialog");
  if (dialog.open) return Promise.resolve(null);
  document.querySelector("#dialogTitle").textContent = title;
  document.querySelector("#dialogMessage").textContent = message;
  const input = document.querySelector("#dialogInput"); input.hidden = !text; input.value = "";
  return new Promise(resolve => {
    const finish = accepted => {
      dialog.close(); clean(); resolve(accepted ? (text ? input.value : true) : (text ? null : false));
    };
    const accept = () => finish(true), cancel = () => finish(false);
    const escape = event => { event.preventDefault(); cancel(); };
    const clean = () => {
      document.querySelector("#dialogConfirm").removeEventListener("click", accept);
      document.querySelector("#dialogCancel").removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", escape);
    };
    document.querySelector("#dialogConfirm").addEventListener("click", accept);
    document.querySelector("#dialogCancel").addEventListener("click", cancel);
    dialog.addEventListener("cancel", escape);
    dialog.showModal(); (text ? input : document.querySelector("#dialogCancel")).focus();
  });
}
function askConfirm(title, message) { return askDialog(title, message); }
function askText(title, message) { return askDialog(title, message, true); }


// --- DOM HELPERS ---
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// --- MODAL WORKFLOW HELPERS ---
function resetEditorScroll(scroller) { if (scroller) scroller.scrollTop = 0; }
function focusModalTitle(title) {
  title?.setAttribute?.('tabindex', '-1');
  title?.focus?.({preventScroll: true});
}
function trapModalFocus(event, overlay) {
  if (event.key !== 'Tab') return;
  const controls = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex="0"]')]
    .filter(node => !node.disabled && !node.hidden && node.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    event.preventDefault(); last.focus({preventScroll: true});
  } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
    event.preventDefault(); first.focus({preventScroll: true});
  }
}
function restoreModalFocus(launcher, fallback) {
  const visible = launcher?.isConnected && (!launcher.getClientRects || launcher.getClientRects().length);
  (visible ? launcher : fallback)?.focus?.({preventScroll: true});
}

// --- TABS & NAVIGATION ---
$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach(b => b.classList.remove("active"));
    $$(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    clearActiveDrag();
    const navigation = $(".tabs-scroll");
    navigation.scrollLeft = Math.max(0, btn.offsetLeft - (navigation.clientWidth - btn.offsetWidth) / 2);
    $("#tab-" + btn.dataset.tab).classList.add("active");
    renderCurrentTab(btn.dataset.tab);
    window.scrollTo(0, 0);
  });
});

function renderCurrentTab(tab) {
  updateRecapLinks();
  if (tab === "dashboard") renderDashboard();
  if (tab === "workout") renderWorkoutTab();
  if (tab === "exercises") renderExerciseLibrary();
  if (tab === "history") renderHistory();
  if (tab === "stats") renderStats();
  if (tab === "settings") renderSettings();
}

// --- DASHBOARD ---
function renderDashboard() {
  $("#btnQuickStart").textContent = ACTIVE_SESSION ? "RESUME WORKOUT" : "START WORKOUT";
  updateRecapLinks();
  renderRecentLogs();
  renderCalendar();
}

function renderRecentLogs() {
  const container = $("#recentLogs");
  container.innerHTML = "";

  const recentSessions = DB.sessions.slice(0, 3);

  if (recentSessions.length === 0) {
    container.innerHTML = '<p class="muted">No workouts yet.</p>';
    return;
  }

  recentSessions.forEach(sess => {
    const div = document.createElement("div");
    div.className = "recent-log-item";

    const date = new Date(sess.start);
    const dateStr = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const completedExercises = LiftLogDates.completedExerciseIds(sess, DB.exercises);
    const exerciseCount = completedExercises.length;
    const exerciseWord = exerciseCount === 1 ? 'exercise' : 'exercises';

    // Get muscle groups worked
    const muscles = new Set();
    completedExercises.forEach(exId => {
      const ex = DB.exercises[exId];
      if (ex) muscles.add(ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other'));
    });

    const templateBadge = sess.templateName
      ? `<span class="template-badge">${escapeHTML(sess.templateName)}</span>`
      : '<span class="template-badge freestyle">Freestyle</span>';

    div.innerHTML = `
      <div class="recent-log-date">${dateStr}</div>
      <div class="recent-log-info">${exerciseCount} ${exerciseWord}</div>
      <div class="recent-log-meta">${templateBadge}</div>
      <div class="recent-log-muscles">${escapeHTML([...muscles].slice(0, 3).join(', ')) || 'No data'}</div>
    `;
    container.appendChild(div);
  });
}

// Both entry points use the same routine cards before starting the timer.
$("#btnQuickStart").addEventListener("click", () => {
  showNotice("");
  $(".tab[data-tab='workout']").click();
});

function populateDashboardTemplates() {
  const sel = $("#dashboardTemplateSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">Freestyle</option>';
  Object.values(DB.templates).forEach(t => {
    sel.innerHTML += `<option value="${t.id}">${escapeHTML(t.name)}</option>`;
  });
}

$("#btnLogBW").addEventListener("click", () => {
  const inputVal = parseFloat($("#bwInput").value);
  if (!inputVal) return;
  // Convert to kg if user is using lbs
  const kg = DB.user.useLbs ? inputVal * LBS_TO_KG : inputVal;
  DB.bodyweight.push({ date: new Date().toISOString(), kg });
  DB.bodyweight.sort((a,b) => new Date(a.date) - new Date(b.date));
  saveDB();
  drawBodyweightChart();
  renderBodyweightEntries();
  $("#bwInput").value = "";
});

// Bodyweight period tabs
const _chartMotionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const _chartAnimator = LiftLogChartMotion.createAnimator({
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: frame => cancelAnimationFrame(frame),
  now: () => performance.now(),
  reduced: () => _chartMotionPreference.matches || document.hidden
});
let _bwPaintFrame = null, _statsResizeFrame = null, _bwVisualAnimation = null;
let _bwPointCount = 0, _bwPlotWidth = 1;
const bwCanvas = $("#bwChart");
function queueBodyweightPaint() {
  if (_bwPaintFrame !== null) return;
  _bwPaintFrame = requestAnimationFrame(() => { _bwPaintFrame = null; drawBodyweightChart(); });
}
function stopBodyweightGesture() {
  _bwIsDragging = false;
  _bwTouchMode = "none";
  bwCanvas.style.cursor = "grab";
}
function zoomBodyweight(nextZoom, anchor = 0.5) {
  const next = Math.max(1, Math.min(10, nextZoom));
  _bwPanOffset = LiftLogChartMotion.anchoredZoom(_bwPointCount, _bwZoom, _bwPanOffset, next, anchor);
  _bwZoom = next;
  queueBodyweightPaint();
}
function bodyweightAnchor(clientX) {
  const rect = bwCanvas.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - rect.left - 40) / Math.max(1, rect.width - 60)));
}
function bodyweightPan(dx, startOffset, startZoom = _bwZoom) {
  const { count } = LiftLogChartMotion.viewport(_bwPointCount, startZoom, startOffset);
  _bwPanOffset = LiftLogChartMotion.viewport(_bwPointCount, _bwZoom, startOffset + dx / _bwPlotWidth * Math.max(0, count - 1)).offset;
  queueBodyweightPaint();
}
document.querySelectorAll(".bw-period-tab").forEach(tab => {
  tab.setAttribute("aria-pressed", String(tab.classList.contains("active")));
  tab.addEventListener("click", () => {
    document.querySelectorAll(".bw-period-tab").forEach(t => { t.classList.remove("active"); t.setAttribute("aria-pressed", "false"); });
    tab.classList.add("active");
    tab.setAttribute("aria-pressed", "true");
    _bwPeriod = tab.dataset.period;
    _bwZoom = 1;
    _bwPanOffset = 0;
    stopBodyweightGesture();
    drawBodyweightChart({ animate: true });
  });
});

// Gesture paints share one animation frame. One-finger vertical drags continue
// to scroll the page; horizontal drags and two-finger pinches own only the plot.
bwCanvas.addEventListener("wheel", e => {
  e.preventDefault();
  zoomBodyweight(_bwZoom * Math.exp(-Math.max(-150, Math.min(150, e.deltaY)) * 0.003), bodyweightAnchor(e.clientX));
}, { passive: false });
bwCanvas.addEventListener("mousedown", e => {
  if (e.button !== 0) return;
  _bwIsDragging = true;
  _bwDragStart = e.clientX;
  _bwPanStart = _bwPanOffset;
  bwCanvas.style.cursor = "grabbing";
});
document.addEventListener("mousemove", e => {
  if (_bwIsDragging && _bwTouchMode === "none") bodyweightPan(_bwDragStart - e.clientX, _bwPanStart);
});
document.addEventListener("mouseup", stopBodyweightGesture);
window.addEventListener("blur", stopBodyweightGesture);
let _bwTouchMode = "none", _bwTouchStartDist = 0, _bwTouchStartZoom = 1;
let _bwTouchStartX = 0, _bwTouchStartY = 0, _bwPinchAnchor = 0.5;
function startBodyweightTouch(touches) {
  _bwPanStart = _bwPanOffset;
  _bwTouchStartZoom = _bwZoom;
  if (touches.length === 2) {
    _bwTouchMode = "pinch";
    _bwIsDragging = false;
    _bwTouchStartDist = Math.max(1, Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY));
    _bwPinchAnchor = bodyweightAnchor((touches[0].clientX + touches[1].clientX) / 2);
  } else if (touches.length === 1) {
    _bwTouchMode = "pending";
    _bwIsDragging = false;
    _bwTouchStartX = touches[0].clientX;
    _bwTouchStartY = touches[0].clientY;
  } else stopBodyweightGesture();
}
bwCanvas.addEventListener("touchstart", e => startBodyweightTouch(e.touches), { passive: true });
bwCanvas.addEventListener("touchmove", e => {
  if (e.touches.length === 2) {
    if (_bwTouchMode !== "pinch") startBodyweightTouch(e.touches);
    if (e.cancelable) e.preventDefault();
    const distance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const nextZoom = Math.max(1, Math.min(10, _bwTouchStartZoom * distance / _bwTouchStartDist));
    _bwPanOffset = LiftLogChartMotion.anchoredZoom(_bwPointCount, _bwTouchStartZoom, _bwPanStart, nextZoom, _bwPinchAnchor);
    _bwZoom = nextZoom;
    queueBodyweightPaint();
  } else if (e.touches.length === 1) {
    const dx = _bwTouchStartX - e.touches[0].clientX;
    const dy = _bwTouchStartY - e.touches[0].clientY;
    if (_bwTouchMode === "pending") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      _bwTouchMode = Math.abs(dx) > Math.abs(dy) ? "pan" : "vertical";
    }
    if (_bwTouchMode !== "pan") return;
    if (e.cancelable) e.preventDefault();
    bodyweightPan(dx, _bwPanStart, _bwTouchStartZoom);
  }
}, { passive: false });
bwCanvas.addEventListener("touchend", e => startBodyweightTouch(e.touches), { passive: true });
bwCanvas.addEventListener("touchcancel", stopBodyweightGesture, { passive: true });
bwCanvas.tabIndex = 0;
bwCanvas.addEventListener("keydown", e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.key === "+" || e.key === "=") zoomBodyweight(_bwZoom * 1.3);
  else if (e.key === "-") zoomBodyweight(_bwZoom / 1.3);
  else if (e.key === "Home" || e.key === "0") { _bwZoom = 1; _bwPanOffset = 0; queueBodyweightPaint(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const { count } = LiftLogChartMotion.viewport(_bwPointCount, _bwZoom, _bwPanOffset);
    _bwPanOffset = LiftLogChartMotion.viewport(_bwPointCount, _bwZoom, _bwPanOffset + (e.key === "ArrowLeft" ? -1 : 1) * Math.max(0.2, count / 5)).offset;
    queueBodyweightPaint();
  } else return;
  e.preventDefault();
});
const _bwControls = document.createElement("div");
_bwControls.className = "bw-chart-controls";
_bwControls.setAttribute("role", "group");
_bwControls.setAttribute("aria-label", "Bodyweight chart zoom");
[["−", "Zoom out", () => zoomBodyweight(_bwZoom / 1.3)], ["+", "Zoom in", () => zoomBodyweight(_bwZoom * 1.3)], ["↺", "Reset bodyweight zoom", () => { _bwZoom = 1; _bwPanOffset = 0; queueBodyweightPaint(); }]].forEach(([text, label, action]) => {
  const button = document.createElement("button");
  button.type = "button"; button.className = "btn-white btn-small";
  button.textContent = text; button.setAttribute("aria-label", label); button.addEventListener("click", action);
  _bwControls.appendChild(button);
});
document.querySelector(".bw-chart-toolbar").appendChild(_bwControls);
const _bwHint = document.querySelector(".bw-zoom-hint");
if (_bwHint) _bwHint.textContent = "Tap a point for its value · pinch to zoom · drag to pan";
function redrawVisibleStats() {
  if (_statsResizeFrame !== null) return;
  _statsResizeFrame = requestAnimationFrame(() => {
    _statsResizeFrame = null;
    if (!$("#tab-stats").classList.contains("active")) return;
    drawBodyweightChart(); updateStatsChart(); renderBreakdownChart();
  });
}
window.addEventListener("resize", redrawVisibleStats, { passive: true });
if (typeof ResizeObserver !== "undefined") {
  const chartResizeObserver = new ResizeObserver(redrawVisibleStats);
  chartResizeObserver.observe(bwCanvas.parentElement);
}
_chartMotionPreference.addEventListener("change", () => {
  if (_chartMotionPreference.matches) { _chartAnimator.finishAll(); _bwVisualAnimation?.cancel(); }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  _chartAnimator.finishAll(); _bwVisualAnimation?.cancel(); stopBodyweightGesture();
  if (_bwPaintFrame !== null) { cancelAnimationFrame(_bwPaintFrame); _bwPaintFrame = null; }
  if (_statsResizeFrame !== null) { cancelAnimationFrame(_statsResizeFrame); _statsResizeFrame = null; }
});

function updateBodyweightUnitLabel() {
  const label = $("#bwUnitLabel");
  if (label) label.textContent = getWeightUnit();
}

function renderBodyweightEntries() {
  const container = $("#bwEntries");
  if (!container) return;
  container.innerHTML = "";

  // Show last 5 entries with delete option
  const recent = DB.bodyweight.slice(-5).reverse();

  if (recent.length === 0) {
    container.innerHTML = '<p class="muted small">No entries yet</p>';
    return;
  }

  const unit = getWeightUnit();
  recent.forEach((entry, idx) => {
    const actualIdx = DB.bodyweight.length - 1 - idx;
    const date = new Date(entry.date);
    const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
    const displayWeight = convertWeight(entry.kg);

    const div = document.createElement("div");
    div.className = "bw-entry";
    div.innerHTML = `
      <span>${dateStr}</span>
      <span>${displayWeight} ${unit}</span>
      <button class="btn-ghost small text-red" onclick="deleteBodyweightEntry(${actualIdx})">✕</button>
    `;
    container.appendChild(div);
  });
}

async function deleteBodyweightEntry(index) {
  if (!await askConfirm("Delete bodyweight entry?", "This entry will be removed from your chart.")) return;
  DB.bodyweight.splice(index, 1);
  saveDB();
  drawBodyweightChart();
  renderBodyweightEntries();
}

function updateChartInspection(canvas, items) {
  let state = canvas._liftlogInspection;
  if (!state) {
    const readout = document.createElement("output");
    readout.className = "chart-readout"; readout.hidden = true;
    readout.setAttribute("aria-live", "polite");
    canvas.parentElement.appendChild(readout);
    state = canvas._liftlogInspection = { items: [], selected: -1, readout, start: null, moved: false };
    canvas.tabIndex = 0;
    function show(index) {
      state.selected = index;
      readout.hidden = index < 0;
      readout.textContent = index < 0 ? "" : state.items[index].label;
    }
    canvas.addEventListener("pointerdown", e => {
      state.moved = !e.isPrimary;
      state.start = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointermove", e => {
      if (state.start && Math.hypot(e.clientX - state.start.x, e.clientY - state.start.y) > 6) state.moved = true;
    });
    canvas.addEventListener("pointercancel", () => { state.moved = true; state.start = null; });
    canvas.addEventListener("click", e => {
      if (state.moved) return;
      _chartAnimator.finish(canvas);
      const rect = canvas.getBoundingClientRect();
      show(LiftLogChartMotion.hitTest(state.items, e.clientX - rect.left, e.clientY - rect.top));
    });
    canvas.addEventListener("keydown", e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") { show(-1); e.preventDefault(); return; }
      const bodyweight = canvas.id === "bwChart";
      if (bodyweight && !e.shiftKey && e.key !== "Enter") return;
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(e.key)) return;
      _chartAnimator.finish(canvas);
      if (!state.items.length) return;
      let next = state.selected;
      if (e.key === "Home") next = 0;
      else if (e.key === "End" || e.key === "Enter" || next < 0) next = state.items.length - 1;
      else next = Math.max(0, Math.min(state.items.length - 1, next + (e.key === "ArrowLeft" ? -1 : 1)));
      show(next); e.preventDefault();
    });
    canvas.addEventListener("blur", () => show(-1));
  }
  state.items = items; state.selected = -1; state.readout.hidden = true;
}

function updateChartDataTable(canvas, captionText, rows) {
  let table = document.getElementById(`${canvas.id}DataTable`);
  if (!table) {
    // Tables retain intrinsic minimum widths. Clip a normal block around the
    // table so its cells cannot enlarge the page's horizontal scroll area.
    const wrapper = document.createElement("div"); wrapper.className = "chart-sr-only";
    table = document.createElement("table"); table.id = `${canvas.id}DataTable`;
    wrapper.appendChild(table); canvas.parentElement.insertAdjacentElement("afterend", wrapper);
  }
  table.replaceChildren();
  const caption = document.createElement("caption"); caption.textContent = captionText; table.appendChild(caption);
  rows.forEach(([label, value]) => {
    const row = document.createElement("tr"), th = document.createElement("th"), td = document.createElement("td");
    th.scope = "row"; th.textContent = label; td.textContent = value; row.append(th, td); table.appendChild(row);
  });
}

function drawBodyweightChart({ animate = false } = {}) {
  const canvas = $("#bwChart");
  const now = new Date();
  let data = [...DB.bodyweight];
  if (_bwPeriod === "month") {
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 30);
    data = data.filter(d => new Date(d.date) >= cutoff);
  } else if (_bwPeriod === "year") {
    const cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - 1);
    data = data.filter(d => new Date(d.date) >= cutoff);
  }
  _bwPointCount = data.length;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  const isDark = document.body.classList.contains("theme-dark");
  const textColor = LiftLogTheme.chartColors().ink;
  ctx.clearRect(0, 0, w, h);
  canvas.setAttribute("role", "img");
  updateChartInspection(canvas, []);
  updateChartDataTable(canvas, `Bodyweight · ${getWeightUnit()}`, data.map(item => [new Date(item.date).toLocaleDateString(), convertWeight(item.kg)]));
  if (data.length < 2) {
    ctx.font = "14px -apple-system, sans-serif"; ctx.fillStyle = textColor; ctx.textAlign = "center";
    ctx.fillText("Log more data to see chart", w / 2, h / 2);
    canvas.setAttribute("aria-label", "Bodyweight chart. Log at least two entries in this period to see a trend.");
    return;
  }
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const { width: chartW, height: chartH } = LiftLogChartMotion.plotGeometry(w, h, padding);
  _bwPlotWidth = Math.max(1, chartW);
  const view = LiftLogChartMotion.viewport(data.length, _bwZoom, _bwPanOffset);
  _bwPanOffset = view.offset;
  const span = Math.max(1, view.count - 1);
  const startIdx = Math.floor(view.offset), endIdx = Math.min(data.length - 1, Math.ceil(view.offset + span));
  const values = data.map(d => convertWeight(d.kg));
  // A fixed Y range for the selected period prevents vertical jumps while panning.
  const stepSize = DB.user.useLbs ? 10 : 5;
  const minVal = Math.floor(Math.min(...values) / stepSize) * stepSize - stepSize;
  const maxVal = Math.ceil(Math.max(...values) / stepSize) * stepSize + stepSize;
  const range = maxVal - minVal || 1;
  const pointX = i => padding.left + (i - view.offset) / span * chartW;
  const pointY = value => padding.top + chartH - (value - minVal) / range * chartH;
  ctx.font = "11px -apple-system, sans-serif"; ctx.fillStyle = textColor; ctx.textAlign = "right";
  for (let value = minVal; value <= maxVal; value += stepSize) {
    const y = pointY(value);
    ctx.fillText(value.toFixed(0), padding.left - 8, y + 4);
    ctx.strokeStyle = LiftLogTheme.chartColors().grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(w - padding.right, y); ctx.stroke();
  }
  const labelStep = Math.max(1, Math.ceil(view.count / 5));
  ctx.textAlign = "center";
  const xLabels = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const x = pointX(i);
    if (x < padding.left || x > w - padding.right) continue;
    if (i % labelStep === 0 || i === data.length - 1) {
      const date = new Date(data[i].date);
      const label = `${date.getDate()}/${date.getMonth() + 1}`;
      xLabels.push({ x, label, width: ctx.measureText?.(label)?.width ?? label.length * 6 });
    }
  }
  LiftLogChartMotion.spacedAxisLabels(xLabels).forEach(item => ctx.fillText(item.label, item.x, h - padding.bottom + 20));
  ctx.save(); ctx.beginPath(); ctx.rect(padding.left - 1, padding.top - 6, chartW + 2, chartH + 12); ctx.clip();
  ctx.beginPath(); ctx.strokeStyle = LiftLogTheme.chartColors().accent; ctx.lineWidth = 3;
  for (let i = startIdx; i <= endIdx; i++) {
    if (i === startIdx) ctx.moveTo(pointX(i), pointY(values[i])); else ctx.lineTo(pointX(i), pointY(values[i]));
  }
  ctx.stroke(); ctx.restore();
  // Clip the connecting line, not the visible points: edge dots need their full
  // radius inside the canvas margins, including while the chart is panned.
  ctx.fillStyle = LiftLogTheme.chartColors().accent; ctx.strokeStyle = LiftLogTheme.chartColors().accent; ctx.lineWidth = 1.3;
  for (let i = startIdx; i <= endIdx; i++) {
    const x = pointX(i);
    if (x < padding.left || x > w - padding.right) continue;
    ctx.beginPath(); ctx.arc(x, pointY(values[i]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  updateChartInspection(canvas, data.map((item, i) => ({ x: pointX(i), y: pointY(values[i]),
    label: `${new Date(item.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${values[i]} ${getWeightUnit()}`
  })).filter(point => point.x >= padding.left && point.x <= w - padding.right));
  if (_bwZoom > 1) {
    ctx.font = "10px -apple-system, sans-serif"; ctx.fillStyle = textColor; ctx.textAlign = "right";
    ctx.fillText(`${Math.round(_bwZoom * 100)}%`, w - 5, 15);
  }
  const first = data[startIdx], last = data[endIdx];
  canvas.setAttribute("aria-label", `Bodyweight chart, ${data.length} entries in this period. Visible from ${new Date(first.date).toLocaleDateString()} at ${values[startIdx]} ${getWeightUnit()} to ${new Date(last.date).toLocaleDateString()} at ${values[endIdx]} ${getWeightUnit()}. Tap a point for its value. Use plus and minus to zoom, left and right arrows to pan, Home to reset; Enter or Shift and arrow keys to read values, Escape to dismiss.`);
  _bwVisualAnimation?.cancel();
  if (animate && !_chartMotionPreference.matches && !document.hidden && canvas.animate) {
    _bwVisualAnimation = canvas.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  }
}

// Calendar state
let calendarDate = new Date();

// Muscle group colors for calendar dots
const MUSCLE_COLORS = {
  Chest: "#E57373", Back: "#64B5F6", Shoulders: "#FFB74D",
  Biceps: "#BA68C8", Triceps: "#F06292", Forearms: "#CE93D8",
  Quads: "#81C784", Hamstrings: "#4DB6AC", Glutes: "#4DD0E1",
  Calves: "#26A69A", Core: "#90A4AE", Cardio: "#FFD54F", Other: "#78909C"
};


function renderCalendar() {
  const grid = $("#calendarGrid");
  grid.innerHTML = "";

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();

  // Update header
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  $("#calendarMonth").textContent = `${monthNames[month].toUpperCase()} ${year}`;

  // First day of month and total days
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const today = new Date();
  const todayStr = LiftLogDates.localDayKey(today);
  const workoutsByDay = new Map();
  DB.sessions.forEach(session => {
    const key = LiftLogDates.localDayKey(session.start);
    if (!workoutsByDay.has(key)) workoutsByDay.set(key, []);
    workoutsByDay.get(key).push(session);
  });

  // Empty cells for days before month starts
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-day empty";
    grid.appendChild(empty);
  }

  // Days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const iso = LiftLogDates.localDayKey(date);

    const div = document.createElement("div");
    div.className = "cal-day";

    // Check if today
    if (iso === todayStr) div.classList.add("today");

    // Find workouts on this day
    const dayWorkouts = workoutsByDay.get(iso) || [];

    if (dayWorkouts.length > 0) {
      div.classList.add("has-workout");

      // Get unique muscle groups worked (including cardio)
      const muscles = new Set();
      dayWorkouts.forEach(sess => {
        LiftLogDates.completedExerciseIds(sess, DB.exercises).forEach(exId => {
          const ex = DB.exercises[exId];
          if (ex) {
            if (ex.type === 'cardio') {
              muscles.add('Cardio');
            } else if (ex.muscle) {
              muscles.add(ex.muscle);
            }
          }
        });
      });

      // Create dots container - show all muscle groups
      const dotsHtml = [...muscles].map(m =>
        `<span class="cal-dot" style="background:${MUSCLE_COLORS[m] || '#999'}"></span>`
      ).join("");

      div.innerHTML = `<span class="cal-day-num">${day}</span><div class="cal-dots">${dotsHtml}</div>`;

      // Click to view details
      div.setAttribute('role', 'button'); div.tabIndex = 0;
      div.setAttribute('aria-label', `${dayWorkouts.length} workout${dayWorkouts.length === 1 ? '' : 's'} on ${iso}`);
      div.onclick = () => showDayDetails(iso, dayWorkouts, div);
      div.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault(); showDayDetails(iso, dayWorkouts, div);
      });
    } else {
      div.innerHTML = `<span class="cal-day-num">${day}</span>`;
    }

    grid.appendChild(div);
  }
}

function showDayDetails(iso, workouts, launcher = document.activeElement) {
  DAY_RETURN_FOCUS = launcher;
  const date = LiftLogDates.parseLocalDay(iso);
  const dateStr = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $("#dayModalTitle").textContent = dateStr;

  let html = "";
  workouts.forEach(sess => {
    // Show workout notes if any
    if (sess.notes) {
      html += `<div class="history-notes" style="margin-bottom:10px;"><em>${escapeHTML(sess.notes)}</em></div>`;
    }

    LiftLogDates.completedExerciseIds(sess, DB.exercises).forEach(exId => {
      const ex = DB.exercises[exId];
      const sets = LiftLogDates.completedSets(sess.entries[exId], ex);
      if (!ex || !sets || sets.length === 0) return;

      // Get muscle group and color
      const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
      const color = MUSCLE_COLORS[category] || '#999';

      const unit = getWeightUnit();
      const setsHtml = sets.map(s => {
        if (ex.type !== 'cardio') {
          return `<span class="set-tag">${escapeHTML(LiftLogLogging.formatStrengthSet(s, ex, unit))}</span>`;
        }
        return `<span class="set-tag">${escapeHTML(s.time || '—')}m / ${escapeHTML(s.dist || '—')}${escapeHTML(ex.cardioMetric || 'km')}</span>`;
      }).join("");

      html += `<div class="day-exercise"><strong>${escapeHTML(ex.name)}</strong> <span class="muscle-tag" style="background:${color}">${escapeHTML(category)}</span><div style="margin-top:8px">${setsHtml}</div></div>`;
    });
  });

  if (!html) html = '<p class="muted">No exercises recorded</p>';
  $("#dayModalContent").innerHTML = html;
  const box = $("#dayModal .day-modal-box");
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'dayModalTitle');
  $("#dayModal").classList.remove("hidden");
  LOGGER_SCROLL_LOCK.acquire('calendar-day');
  resetEditorScroll($("#dayModalContent"));
  focusModalTitle($("#dayModalTitle"));
}

let DAY_RETURN_FOCUS = null;
function closeDayDetails() {
  $("#dayModal").classList.add("hidden");
  LOGGER_SCROLL_LOCK.release('calendar-day');
  restoreModalFocus(DAY_RETURN_FOCUS, $("#btnQuickStart"));
  DAY_RETURN_FOCUS = null;
  LiftLogUpdates.notifySafe();
}
$("#btnCloseDayModal").addEventListener("click", closeDayDetails);

// Close day modal when clicking outside the box
$("#dayModal").addEventListener("click", (e) => {
  if (e.target === $("#dayModal")) {
    closeDayDetails();
  }
});
$("#dayModal").addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDayDetails(); return; }
  trapModalFocus(event, $("#dayModal"));
});

$("#btnPrevMonth").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
  renderCalendar();
});

$("#btnNextMonth").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
  renderCalendar();
});

// --- EXERCISES ---
const MUSCLE_GROUPS = ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Forearms", "Quads", "Hamstrings", "Glutes", "Calves", "Core", "Other"];
const EXERCISE_TYPES = ["Strength", "Cardio"];

// Migration map for old categories
const MUSCLE_MIGRATION = {
  "Push": "Chest",
  "Pull": "Back",
  "Legs": "Quads"
};

function migrateExerciseCategories() {
  let migrated = false;
  Object.values(DB.exercises).forEach(ex => {
    if (MUSCLE_MIGRATION[ex.muscle]) {
      ex.muscle = MUSCLE_MIGRATION[ex.muscle];
      migrated = true;
    }
  });
  if (migrated) {
    saveDB();
    console.log("Migrated exercise categories to new muscle groups");
  }
}

function renderExerciseLibrary() {
  renderLibraryTabs();
  renderTemplates();

  const container = $("#exerciseList");
  container.innerHTML = "";

  const search = $("#searchEx").value.toLowerCase();

  const allExercises = Object.values(DB.exercises).filter(ex => !ex.archived);

  // Show empty state if no exercises exist at all
  if (allExercises.length === 0) {
    container.innerHTML = '<p class="muted" style="padding: 20px; text-align: center;">No exercises yet. Click "+ NEW" to add your first exercise!</p>';
    return;
  }

  const list = allExercises
    .filter(ex => {
      // Filter by Cardio (type) or muscle group
      if (_libraryFilter === "Cardio") {
        if (ex.type !== "cardio") return false;
      } else if (_libraryFilter !== "All") {
        if (ex.muscle !== _libraryFilter) return false;
      }
      if (search && !ex.name.toLowerCase().includes(search)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Show message if filters return no results
  if (list.length === 0) {
    container.innerHTML = '<p class="muted" style="padding: 20px; text-align: center;">No exercises match your search.</p>';
    return;
  }

  list.forEach(ex => {
    // Determine category for styling - cardio uses type, others use muscle
    const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
    const div = document.createElement("div");
    div.className = `ex-item-card ex-cat-${escapeHTML(category)}`;

    // Get last session data for this exercise
    const lastSession = findLastSessionWithExercise(ex.id);
    let historyHtml = '<div class="ex-history muted small">No history yet</div>';

    if (lastSession) {
      const date = new Date(lastSession.date);
      const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const unit = getWeightUnit();
      const sets = lastSession.sets.map(s => {
        if (ex.type !== 'cardio' && Number(s.r) > 0) {
          const raw = LiftLogLogging.formatStrengthSet(s, ex, unit), estimate = LiftLogLogging.estimatedSetText(s, unit);
          return `${escapeHTML(raw)}${estimate ? ` <span class="muted">(${escapeHTML(estimate)})</span>` : ''}`;
        }
        if (Number(s.time) > 0 || Number(s.dist) > 0) return `${escapeHTML(s.time || 0)}m / ${escapeHTML(s.dist || 0)}${escapeHTML(ex.cardioMetric || 'km')}`;
        return '';
      }).filter(Boolean).join(', ');

      historyHtml = `<div class="ex-history"><span class="muted small">${dateStr}:</span> <span class="small">${sets}</span></div>`;
    }

    // Label shows "Cardio" for cardio type, muscle name for strength
    const labelText = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
    const muscleColor = MUSCLE_COLORS[category] || '#999';

    div.innerHTML = `
      <div class="ex-item-header">
        <span class="ex-name">${escapeHTML(ex.name)} <span class="muscle-tag" style="background: ${muscleColor}; color: #000;">${escapeHTML(labelText)}</span></span>
        <button class="btn-ghost icon-btn" data-edit-exercise="${ex.id}" aria-label="Edit ${escapeHTML(ex.name)}" onclick="editExercise('${ex.id}')">✎</button>
      </div>
      ${historyHtml}
    `;
    container.appendChild(div);
  });
}

// Populate Dropdowns
function populateSelects() {
  const muscles = $("#newExMuscle");

  if (muscles) {
    muscles.innerHTML = '';
    MUSCLE_GROUPS.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      muscles.appendChild(opt);
    });
  }

  $("#newExEquip").innerHTML = `
    <option value="barbell">Barbell</option>
    <option value="dumbbell">Dumbbell</option>
    <option value="machine">Machine</option>
    <option value="cable">Cable</option>
    <option value="bodyweight">Bodyweight</option>
  `;
}

// Library filter state
let _libraryFilter = "All";

function renderLibraryTabs() {
  const container = $("#libraryTabs");
  if (!container) return;
  const filters = ['All', ...MUSCLE_GROUPS, 'Cardio'];
  if (container.children.length !== filters.length) {
    container.replaceChildren();
    filters.forEach(muscle => {
      const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = muscle;
      tab.onclick = () => { _libraryFilter = muscle; renderExerciseLibrary(); };
      container.appendChild(tab);
    });
  }
  [...container.children].forEach((tab, index) => {
    const muscle = filters[index], active = _libraryFilter === muscle, color = MUSCLE_COLORS[muscle];
    tab.className = `picker-tab ${active ? 'active' : ''}`;
    tab.setAttribute('aria-pressed', String(active));
    tab.style.borderColor = color || '';
    tab.style.background = active && color ? color : '';
    tab.style.color = active && color ? '#000' : '';
  });
}

// Library search listener
$("#searchEx").addEventListener("input", renderExerciseLibrary);

let _createdExerciseCallback = null;
let _createdExerciseCancelCallback = null;
function openNewExerciseModal(fromPicker = false) {
  _createdExerciseCallback = fromPicker === true ? id => closeExercisePicker(id) : null;
  _createdExerciseCancelCallback = fromPicker === true ? resumeExercisePicker : null;
  // Reset form for new exercise
  EDITING_EXERCISE_ID = null;
  $("#exModalTitle").textContent = "NEW EXERCISE";
  $("#newExName").value = "";
  $("#newExType").value = "strength";
  $("#newExMuscle").value = MUSCLE_GROUPS[0];
  $("#newExEquip").value = "barbell";
  $("#newExInc").value = "2.5";
  $("#newExCardioMetric").value = "";
  $("#newExCardioGoal").value = "endurance";
  $("#newExLoadType").value = 'external';
  updateExerciseLoadHelp();
  $("#strengthOptions").classList.remove("hidden");
  $("#cardioOptions").classList.add("hidden");
  $("#muscleSelectWrapper").classList.remove("hidden");
  $("#btnDeleteEx").classList.add("hidden"); // Hide delete for new exercise
  showExerciseModal();
}

$("#btnShowAddEx").addEventListener("click", openNewExerciseModal);

$("#btnCloseExModal").addEventListener("click", closeExerciseModal);

// Close exercise modal when clicking outside
$("#addExModal").addEventListener("click", (e) => {
  if (e.target === $("#addExModal")) {
    closeExerciseModal();
  }
});

$("#newExType").addEventListener("change", (e) => {
   if(e.target.value === 'cardio') {
     $("#strengthOptions").classList.add("hidden");
     $("#cardioOptions").classList.remove("hidden");
     $("#muscleSelectWrapper").classList.add("hidden");
   } else {
     $("#strengthOptions").classList.remove("hidden");
     $("#cardioOptions").classList.add("hidden");
     $("#muscleSelectWrapper").classList.remove("hidden");
   }
});

let EDITING_EXERCISE_ID = null;
let EXERCISE_RETURN_FOCUS = null;
let EXERCISE_SAVING = false;

function updateExerciseLoadHelp() {
  const help = {
    external: 'Log the weight you lift. Keep different variations as separate exercises.',
    bodyweight: 'Reps only, for full-bodyweight movements such as dips or pull-ups. The estimate uses workout bodyweight.',
    assisted: 'Enter machine assistance. The estimate is workout bodyweight minus assistance.',
    weighted: 'Enter added weight. The estimate is workout bodyweight plus added weight.'
  };
  $("#exerciseLoadHelp").textContent = help[$("#newExLoadType").value] || help.external;
}
$("#newExLoadType").addEventListener('change', updateExerciseLoadHelp);

function showExerciseModal() {
  EXERCISE_RETURN_FOCUS = document.activeElement;
  $("#addExModal").classList.remove("hidden");
  LOGGER_SCROLL_LOCK.acquire("exercise-editor");
  resetEditorScroll($("#addExModal .exercise-editor-body"));
  $("#exModalTitle").focus({preventScroll: true});
}
function closeExerciseModal() {
  if (EXERCISE_SAVING) return;
  const onCancel = _createdExerciseCancelCallback;
  EDITING_EXERCISE_ID = null; _createdExerciseCallback = null; _createdExerciseCancelCallback = null;
  $("#addExModal").classList.add("hidden");
  LOGGER_SCROLL_LOCK.release("exercise-editor");
  const exerciseId = EXERCISE_RETURN_FOCUS?.dataset?.editExercise;
  const returnTarget = EXERCISE_RETURN_FOCUS?.isConnected ? EXERCISE_RETURN_FOCUS
    : exerciseId ? document.querySelector(`[data-edit-exercise="${exerciseId}"]`) || $("#btnShowAddEx") : null;
  EXERCISE_RETURN_FOCUS = null;
  if (onCancel) onCancel();
  else returnTarget?.focus({preventScroll: true});
}
function setExerciseSaving(busy) {
  EXERCISE_SAVING = busy;
  $("#addExModal").querySelectorAll('button, input, select').forEach(node => { node.disabled = busy; });
}
$("#addExModal").addEventListener("keydown", event => {
  if (event.key === 'Escape') { event.preventDefault(); closeExerciseModal(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...$("#addExModal").querySelectorAll('button, input, select')]
    .filter(node => !node.disabled && node.getClientRects().length);
  if (!controls.length) { event.preventDefault(); return; }
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
});

$("#btnSaveEx").addEventListener("click", async () => {
  if (EXERCISE_SAVING) return;
  const name = $("#newExName").value.trim();
  if (!name) { $("#newExName").reportValidity(); $("#newExName").focus(); return; }

  const type = $("#newExType").value;
  const existing = EDITING_EXERCISE_ID && DB.exercises[EDITING_EXERCISE_ID];
  if (existing && type !== (existing.type || 'strength') && exerciseHasRecordedInputs(EDITING_EXERCISE_ID)) {
    $("#newExType").value = existing.type || 'strength';
    $("#newExType").dispatchEvent(new Event('change', {bubbles: true}));
    $("#newExType").focus({preventScroll: true});
    await askConfirm('Keep exercise type', 'This exercise has saved or unfinished sets. Create a separate exercise for a different type.');
    return;
  }
  const exerciseData = {
    name,
    type,
    muscle: type === 'cardio' ? null : $("#newExMuscle").value,
    equip: type === 'cardio' ? null : $("#newExEquip").value,
    increment: type === 'cardio' ? null : (Number.isFinite(parseFloat($("#newExInc").value)) ? parseFloat($("#newExInc").value) : 2.5),
    cardioMetric: type === 'cardio' ? ($("#newExCardioMetric").value.trim() || 'km') : null,
    cardioGoal: type === 'cardio' ? $("#newExCardioGoal").value : null,
    ...(type === 'strength' ? {loadType: $("#newExLoadType").value} : {}),
    ...(!EDITING_EXERCISE_ID ? {isAssisted: false} : {})
  };

  let savedExerciseId = EDITING_EXERCISE_ID;
  if (EDITING_EXERCISE_ID) {
    // Only replace visible fields; retain imported/legacy exercise metadata.
    DB.exercises[EDITING_EXERCISE_ID] = { ...DB.exercises[EDITING_EXERCISE_ID], ...exerciseData };
  } else {
    // Create new exercise
    const id = uid();
    DB.exercises[id] = { id, ...exerciseData };
    savedExerciseId = id;
  }

  EDITING_EXERCISE_ID = savedExerciseId;
  let saved = false;
  setExerciseSaving(true);
  try { saved = await saveDB(); } finally { setExerciseSaving(false); }
  if (!saved) return;
  EDITING_EXERCISE_ID = null;
  const callback = _createdExerciseCallback;
  _createdExerciseCallback = null; _createdExerciseCancelCallback = null;
  renderExerciseLibrary();
  closeExerciseModal();
  callback?.(savedExerciseId);
});

function exerciseHasRecordedInputs(id) {
  const sessions = [...(DB.sessions || []), ...(typeof ACTIVE_SESSION !== 'undefined' && ACTIVE_SESSION ? [ACTIVE_SESSION] : [])];
  return sessions.some(session => (Array.isArray(session.entries?.[id]) && session.entries[id].length > 0)
    || (Array.isArray(session.logDrafts?.[id]?.rows) && session.logDrafts[id].rows.length > 0));
}

function editExercise(id) {
  const ex = DB.exercises[id];
  if (!ex) return;

  EDITING_EXERCISE_ID = id;
  _createdExerciseCallback = null; _createdExerciseCancelCallback = null;
  $("#exModalTitle").textContent = "EDIT EXERCISE";

  // Pre-populate form with existing data
  $("#newExName").value = ex.name;
  $("#newExType").value = ex.type || 'strength';
  $("#newExMuscle").value = ex.muscle || '';
  $("#newExEquip").value = ex.equip || 'barbell';
  $("#newExInc").value = ex.increment ?? 2.5;
  $("#newExCardioMetric").value = ex.cardioMetric || '';
  $("#newExCardioGoal").value = ex.cardioGoal || 'endurance';
  $("#newExLoadType").value = LiftLogExerciseLoad.resolveMode(ex);
  updateExerciseLoadHelp();

  // Show/hide options based on type
  if (ex.type === 'cardio') {
    $("#strengthOptions").classList.add("hidden");
    $("#cardioOptions").classList.remove("hidden");
    $("#muscleSelectWrapper").classList.add("hidden");
  } else {
    $("#strengthOptions").classList.remove("hidden");
    $("#cardioOptions").classList.add("hidden");
    $("#muscleSelectWrapper").classList.remove("hidden");
  }

  $("#btnDeleteEx").classList.remove("hidden"); // Show delete for existing exercise
  showExerciseModal();
}

$("#btnDeleteEx").addEventListener("click", async () => {
  if (!EDITING_EXERCISE_ID || EXERCISE_SAVING) return;
  if (!await askConfirm("Archive exercise?", "Hide it from the exercise library. Past workouts and routines keep their exercise details.")) return;

  DB.exercises[EDITING_EXERCISE_ID].archived = true;
  let saved = false;
  setExerciseSaving(true);
  try { saved = await saveDB(); } finally { setExerciseSaving(false); }
  if (!saved) return;
  renderExerciseLibrary();
  closeExerciseModal();
});

// --- WORKOUT LOGGING ---
function renderWorkoutTab() {
  if (ACTIVE_SESSION) {
    $("#startWorkoutPanel").classList.add("hidden");
    $("#activeWorkoutPanel").classList.remove("hidden");
    renderActiveSession();
    startTimer();
  } else {
    $("#startWorkoutPanel").classList.remove("hidden");
    $("#activeWorkoutPanel").classList.add("hidden");
    stopTimer();
    renderTemplates();
  }
}

function startTimer() {
  if (WORKOUT_TIMER || !ACTIVE_SESSION) return;
  const tick = () => {
    if (!ACTIVE_SESSION) return;
    const diff = Math.max(0, Math.floor((Date.now() - new Date(ACTIVE_SESSION.start).getTime()) / 1000));
    const m = Math.floor(diff / 60).toString().padStart(2, '0');
    const sec = (diff % 60).toString().padStart(2, '0');
    $("#workoutTimer").textContent = `${m}:${sec}`;
  };
  tick(); WORKOUT_TIMER = setInterval(tick, 1000);
}

function stopTimer() {
  if (WORKOUT_TIMER) clearInterval(WORKOUT_TIMER);
  WORKOUT_TIMER = null;
}

// Starting
$("#btnStartEmpty").addEventListener("click", () => startWorkout());

async function startWorkout(template = null) {
  if (!STORE_READY || STORAGE_ERROR || UPDATE_LOCK || FINISHING || STARTING) return;
  if (ACTIVE_SESSION) {
    $(".tab[data-tab='workout']").click();
    showNotice("");
    return;
  }
  STARTING = true;
  try {
  // Read once before starting so a second window cannot silently replace a draft.
  await refreshSavedData();
  if (ACTIVE_SESSION) { $(".tab[data-tab='workout']").click(); return; }
  if (STORAGE_ERROR || UPDATE_LOCK) return;
  stopTimer();
  ACTIVE_SESSION = {
    id: uid(), start: new Date().toISOString(), entries: {}, order: [],
    notes: "", exerciseNotes: {}, logDrafts: {},
    templateName: template ? template.name : null,
    templateId: template ? template.id : null
  };
  ACTIVE_SESSION.bodyweightSnapshot = LiftLogExerciseLoad.latestBodyweight(DB.bodyweight, ACTIVE_SESSION.start);
  if (template) ACTIVE_SESSION.order = [...new Set(template.exercises.map(item => item.exId))].filter(id => DB.exercises[id]);
  if (await saveDraft()) {
    renderWorkoutTab(); showNotice("");
    window.scrollTo({top: 0, left: 0, behavior: 'instant'});
  }
  } finally { STARTING = false; }
}

// Active handle drag state: one pointer owns the gesture across mouse, pen and touch.
let _activeDrag = null;

function renderActiveSession() {
  clearActiveDrag();
  const progress = arguments[0]; // Supplied only after a successful set save, never ordinary navigation.
  const list = $("#activeExerciseList");
  list.innerHTML = "";

  // Load workout notes
  loadWorkoutNotes();
  $("#activeRoutineName").textContent = ACTIVE_SESSION.templateName || 'Freestyle';
  const completed = ACTIVE_SESSION.order.filter(id => LiftLogDates.completedSets(ACTIVE_SESSION.entries[id] || [], DB.exercises[id]).length > 0);
  const motion = progress && LiftLogWorkoutMotion.completionTransition(ACTIVE_SESSION.order, progress.beforeCompleted, completed, progress.savedExercise);
  $("#workoutProgress").textContent = `${completed.length} / ${ACTIVE_SESSION.order.length} logged`;
  let connected = true;

  ACTIVE_SESSION.order.forEach((exId, idx) => {
    const ex = DB.exercises[exId];
    if (!ex) return;
    const sets = ACTIVE_SESSION.entries[exId] || [];
    const isDone = completed.includes(exId);
    const hasDraft = Boolean(ACTIVE_SESSION.logDrafts?.[exId]);
    const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');

    const div = document.createElement("div");
    div.className = `neo-card bg-white mb-2 p-2 draggable-exercise workout-step ${isDone ? 'is-logged' : ''} ${connected && isDone ? 'rail-logged' : ''}`;
    if (!isDone) connected = false;
    div.draggable = false;
    div.dataset.idx = idx;
    div.dataset.exerciseId = exId;
    if (motion?.tick === exId) div.classList.add('progress-tick-enter');
    const segment = motion?.segments.indexOf(exId) ?? -1;
    if (segment >= 0) {
      div.classList.add('progress-rail-enter');
      div.style.setProperty('--rail-delay', `${Math.min(segment, 2) * 100}ms`);
    }
    if (motion?.next === exId) {
      div.classList.add('progress-next-enter');
      div.style.setProperty('--node-delay', `${360 + Math.min(motion.segments.length - 1, 2) * 100}ms`);
    }
    div.innerHTML = `
      <span class="progress-node" aria-hidden="true"><span class="progress-tick">${isDone ? '✓' : ''}</span></span>
      <div class="exercise-step-content">
        <button class="exercise-open"><strong>${escapeHTML(ex.name)}</strong><span class="muscle-label"><i style="--muscle-color:${MUSCLE_COLORS[category] || '#999'}"></i>${escapeHTML(category)}</span><span class="muted small">${hasDraft ? 'In progress' : isDone ? `${LiftLogDates.completedSets(sets, ex).length} set${LiftLogDates.completedSets(sets, ex).length === 1 ? '' : 's'} logged` : 'Log sets'}</span></button>
        <div class="exercise-step-actions"><button class="drag-handle btn-ghost" aria-label="Reorder ${escapeHTML(ex.name)}" title="Drag to reorder; use arrow keys with keyboard">☰</button><button class="exercise-remove btn-ghost text-red" aria-label="Remove ${escapeHTML(ex.name)}">✕</button></div>
      </div>
    `;
    div.querySelector('.exercise-open').addEventListener('click', () => openLogger(exId));
    div.querySelector('.exercise-remove').addEventListener('click', () => removeExerciseFromSession(exId));

    const handle = div.querySelector(".drag-handle");
    handle.draggable = false;
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const to = idx + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= ACTIVE_SESSION.order.length) return;
      moveActiveExercise(idx, to);
      $("#activeExerciseList").children[to]?.querySelector('.drag-handle').focus();
    });

    handle.addEventListener('pointerdown', event => startActivePointerDrag(event, idx, div, handle));
    handle.addEventListener('lostpointercapture', cancelActivePointerDrag);
    // Prevent native image/text dragging from competing with the owned handle gesture.
    div.addEventListener('dragstart', event => event.preventDefault());

    list.appendChild(div);
  });
  saveDraft();
}

function activeDragBlocked() {
  return !ACTIVE_SESSION || COMMITTING || FINISHING || UPDATE_LOCK || STARTING || !STORE_READY || STORAGE_ERROR;
}
function activeDragUnchanged(drag) {
  return !activeDragBlocked() && ACTIVE_SESSION.id === drag.sessionId && ACTIVE_SESSION.start === drag.sessionStart
    && STORAGE_EPOCH === drag.epoch && JSON.stringify(ACTIVE_SESSION.order) === JSON.stringify(drag.order);
}
function startActivePointerDrag(event, index, element, handle) {
  if (_activeDrag) { clearActiveDrag(); return; }
  if (activeDragBlocked() || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0) || ACTIVE_SESSION.order.length < 2) return;
  event.preventDefault();
  const rect = element.getBoundingClientRect();
  _activeDrag = {pointerId: event.pointerId, from: index, element, handle, clone: null, moved: false, target: null,
    startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
    sessionId: ACTIVE_SESSION.id, sessionStart: ACTIVE_SESSION.start, epoch: STORAGE_EPOCH, order: ACTIVE_SESSION.order.slice()};
  handle.setPointerCapture(event.pointerId);
}
function activeDragTarget(event) {
  const drag = _activeDrag;
  if (!drag) return;
  document.querySelectorAll('.drag-over').forEach(node => node.classList.remove('drag-over'));
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.draggable-exercise');
  const list = $('#activeExerciseList');
  drag.target = target && target !== drag.element && target.parentElement === list ? target : null;
  drag.target?.classList.add('drag-over');
}
function moveActivePointerDrag(event) {
  const drag = _activeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!activeDragUnchanged(drag)) { clearActiveDrag(); return; }
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
  event.preventDefault();
  if (!drag.moved) {
    drag.moved = true; drag.element.classList.add('dragging');
    const rect = drag.element.getBoundingClientRect();
    drag.clone = drag.element.cloneNode(true); drag.clone.classList.add('touch-drag-clone');
    drag.clone.setAttribute('aria-hidden', 'true'); drag.clone.inert = true;
    Object.assign(drag.clone.style, {position: 'fixed', width: `${rect.width}px`, zIndex: '1000', pointerEvents: 'none'});
    document.body.appendChild(drag.clone);
  }
  drag.clone.style.left = `${event.clientX - drag.offsetX}px`;
  drag.clone.style.top = `${event.clientY - drag.offsetY}px`;
  // Keep a longer workout reachable while the owned handle approaches the viewport edge.
  if (event.clientY < 100) window.scrollBy?.({top: -14, behavior: 'instant'});
  else if (event.clientY > window.innerHeight - 50) window.scrollBy?.({top: 14, behavior: 'instant'});
  activeDragTarget(event);
}
function endActivePointerDrag(event) {
  const drag = _activeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.moved) activeDragTarget(event);
  const target = drag.target, to = target ? Number(target.dataset.idx) : null;
  const commit = drag.moved && target && activeDragUnchanged(drag);
  clearActiveDrag();
  if (commit) {
    moveActiveExercise(drag.from, to);
    $('#activeExerciseList').children[to]?.querySelector('.drag-handle').focus({preventScroll: true});
  }
}
function cancelActivePointerDrag(event) {
  if (_activeDrag && (!event || event.pointerId === _activeDrag.pointerId)) clearActiveDrag();
}

function moveActiveExercise(from, to) {
  if (COMMITTING || FINISHING || UPDATE_LOCK || STARTING || !STORE_READY || STORAGE_ERROR) return;
  if (!ACTIVE_SESSION || !Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= ACTIVE_SESSION.order.length || to >= ACTIVE_SESSION.order.length) return;
  const [moved] = ACTIVE_SESSION.order.splice(from, 1);
  ACTIVE_SESSION.order.splice(to, 0, moved);
  renderActiveSession();
}

// Global pointer handlers continue an owned drag outside its handle without a second engine.
document.addEventListener('pointerdown', event => {
  if (_activeDrag && event.pointerId !== _activeDrag.pointerId) clearActiveDrag();
}, {passive: true});
document.addEventListener('pointermove', moveActivePointerDrag, {passive: false});
document.addEventListener('pointerup', endActivePointerDrag);
document.addEventListener('pointercancel', cancelActivePointerDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearActiveDrag(); });

function clearActiveDrag() {
  const drag = _activeDrag;
  _activeDrag = null;
  if (!drag) return;
  drag.element.classList.remove('dragging'); drag.clone?.remove();
  document.querySelectorAll('.drag-over').forEach(node => node.classList.remove('drag-over'));
  if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}
window.addEventListener('blur', clearActiveDrag);
window.addEventListener('resize', clearActiveDrag);

$("#btnAddExToWorkout").addEventListener("click", () => {
  openExercisePicker((exId) => {
    if (!ACTIVE_SESSION.order.includes(exId)) {
      ACTIVE_SESSION.order.push(exId);
      renderActiveSession();
    }
  });
});

$("#btnFinishWorkout").addEventListener("click", async () => {
  if (!ACTIVE_SESSION || FINISHING || UPDATE_LOCK) return;
  FINISHING = true;
  clearActiveDrag();
  try {
    const unfinished = Object.entries(ACTIVE_SESSION.logDrafts || {}).find(([exId]) =>
      LiftLogLogging.hasExerciseWork(ACTIVE_SESSION, exId));
    if (unfinished) {
      showNotice("Review your unfinished exercise edits and save the sets before finishing.");
      openLogger(unfinished[0]); return;
    }
    if (!await flushSaves()) return;
    const hasEntries = LiftLogDates.completedExerciseIds(ACTIVE_SESSION, DB.exercises).length > 0;
    if (!await askConfirm(hasEntries ? "Finish workout?" : "Discard empty workout?", hasEntries ?
      "Your logged sets and notes will be saved to History." : "No sets have been logged. Discard this unfinished workout?")) return;
    COMMITTING = true; updateSaveStatus();
    if (!await flushSaves()) return;
    if (!hasEntries) {
      const previous = ACTIVE_SESSION;
      ACTIVE_SESSION = null;
      if (!await saveDraft()) { ACTIVE_SESSION = previous; return; }
    } else {
      const expectedDraft = copyState(ACTIVE_SESSION);
      const completed = copyState(expectedDraft);
      completed.end = new Date().toISOString(); delete completed.logDrafts;
      const result = await STORE.finishWorkout(completed, expectedDraft, {epoch: STORAGE_EPOCH});
      applySnapshot(result);
    }
    stopTimer(); renderWorkoutTab();
    showNotice(hasEntries ? "Workout saved." : "Empty workout discarded.");
    $(".tab[data-tab='history']").click();
  } catch (error) { storageFailure(error); }
  finally { FINISHING = false; COMMITTING = false; updateSaveStatus(); LiftLogUpdates.notifySafe(); }
});

// --- LOGGING MODAL ---
let CURRENT_LOG_EX = null;
let LOGGER_RETURN_FOCUS = null;
let CURRENT_LOG_UNIT = "kg";
let CURRENT_LOG_MODE = 'external';
let LOG_SAVING = false;
let LOG_SWAPPING = false;
let REMOVING_EXERCISE = false;
const LOGGER_SCROLL_LOCK = LiftLogLogging.createScrollLock(window, document);

async function removeExerciseFromSession(exId) {
  const blocked = () => LOG_SAVING || COMMITTING || FINISHING || UPDATE_LOCK || STARTING || !STORE_READY || STORAGE_ERROR || CURRENT_LOG_EX;
  if (!ACTIVE_SESSION || REMOVING_EXERCISE || blocked() || !ACTIVE_SESSION.order.includes(exId)) return;
  const expected = copyState(ACTIVE_SESSION), expectedEpoch = STORAGE_EPOCH;
  const ex = DB.exercises[exId];
  let ownsCommitLock = false;
  REMOVING_EXERCISE = true;
  try {
    clearActiveDrag();
    if (!await askConfirm("Remove exercise?", `Remove ${ex?.name || 'this exercise'} and its saved sets and unfinished edits from this workout?`)) return;
    // A save may replace the draft object while the dialog is open. Compare its
    // contents and generation, not the object reference, before deleting anything.
    if (blocked()) return;
    if (STORAGE_EPOCH !== expectedEpoch || !LiftLogStorage.equal(ACTIVE_SESSION, expected)) {
      showNotice('This workout changed. Review it before removing the exercise.');
      return;
    }
    COMMITTING = true; ownsCommitLock = true; updateSaveStatus();
    const session = ACTIVE_SESSION;
    session.order = session.order.filter(id => id !== exId);
    delete session.entries[exId];
    if (session.logDrafts) delete session.logDrafts[exId];
    if (session.exerciseNotes) delete session.exerciseNotes[exId];
    const removedOrder = session.order.slice();
    let saved = false;
    try { saved = await saveDraft(); }
    catch (error) { storageFailure(error); }
    if (!saved) {
      if (STORAGE_EPOCH === expectedEpoch && ACTIVE_SESSION?.id === expected.id && ACTIVE_SESSION.start === expected.start) {
        // Restore only the removed exercise; never overwrite a replacement
        // session or unrelated edits if an asynchronous operation changed it.
        const current = ACTIVE_SESSION;
        if (LiftLogStorage.equal(current.order, removedOrder)) current.order = expected.order.slice();
        else if (!current.order.includes(exId)) current.order.splice(Math.min(expected.order.indexOf(exId), current.order.length), 0, exId);
        for (const field of ['entries', 'logDrafts', 'exerciseNotes']) {
          if (Object.hasOwn(expected[field] || {}, exId) && !Object.hasOwn(current[field] || {}, exId)) {
            current[field] ||= {};
            current[field][exId] = copyState(expected[field][exId]);
          }
        }
      }
      return;
    }
    if (ACTIVE_SESSION?.id === expected.id && ACTIVE_SESSION.start === expected.start && STORAGE_EPOCH === expectedEpoch) renderActiveSession();
  } finally {
    REMOVING_EXERCISE = false;
    if (ownsCommitLock) { COMMITTING = false; updateSaveStatus(); LiftLogUpdates.notifySafe(); }
  }
}

function loggerRows() {
  return Array.from($$("#logRows .log-row"), row => ({
    ...row._sourceRow,
    a: row.querySelector(".input-val-1").value,
    b: row.querySelector(".input-val-2").value
  }));
}

function loggerExercise() {
  const exercise = DB.exercises[CURRENT_LOG_EX];
  return exercise?.type === 'cardio' ? exercise : {...exercise, loadType: CURRENT_LOG_MODE};
}
function setupWorkoutBodyweight() {
  const relevant = DB.exercises[CURRENT_LOG_EX]?.type !== 'cardio' && CURRENT_LOG_MODE !== 'external';
  $("#logBodyweight").hidden = !relevant;
  if (!relevant) return;
  if (!Object.hasOwn(ACTIVE_SESSION, 'bodyweightSnapshot')) {
    ACTIVE_SESSION.bodyweightSnapshot = LiftLogExerciseLoad.latestBodyweight(DB.bodyweight, ACTIVE_SESSION.start);
  }
  if (!ACTIVE_SESSION.bodyweightInput || !['kg', 'lbs'].includes(ACTIVE_SESSION.bodyweightInput.unit)) {
    const snapshot = ACTIVE_SESSION.bodyweightSnapshot;
    const display = snapshot ? String(LiftLogLogging.displayWeight(snapshot.kg, CURRENT_LOG_UNIT)) : '';
    ACTIVE_SESSION.bodyweightInput = {value: display, unit: CURRENT_LOG_UNIT};
    if (snapshot) Object.assign(ACTIVE_SESSION.bodyweightInput, {originalKg: snapshot.kg, originalDisplay: display,
      originalDate: snapshot.date, ...(snapshot.sourceId ? {originalSourceId: snapshot.sourceId} : {})});
  }
  $("#logBodyweightInput").value = ACTIVE_SESSION.bodyweightInput.value;
  $("#logBodyweightUnit").textContent = `(${ACTIVE_SESSION.bodyweightInput.unit})`;
  updateWorkoutBodyweightDate();
}
function updateWorkoutBodyweightDate() {
  const source = ACTIVE_SESSION?.bodyweightSnapshot?.date;
  const calendarDay = typeof source === 'string' ? LiftLogDates.parseLocalDay(source.slice(0, 10)) : new Date(NaN);
  const date = typeof source === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source)
    ? calendarDay : new Date(source);
  const valid = typeof source === 'string' && Number.isFinite(calendarDay.getTime()) && Number.isFinite(date.getTime());
  const label = $("#logBodyweightDate");
  label.hidden = !valid;
  label.textContent = valid ? date.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}) : '';
  label.dateTime = valid ? source : '';
}
$("#logBodyweightInput").addEventListener('input', () => {
  if (!ACTIVE_SESSION || LOG_SAVING || !CURRENT_LOG_EX) return;
  const input = ACTIVE_SESSION.bodyweightInput || {unit: CURRENT_LOG_UNIT};
  input.value = $("#logBodyweightInput").value;
  ACTIVE_SESSION.bodyweightInput = input;
  ACTIVE_SESSION.bodyweightSnapshot = LiftLogLogging.parseBodyweightInput(input, ACTIVE_SESSION.start);
  updateWorkoutBodyweightDate();
  captureLogDraft();
});

function captureLogDraft() {
  if (!ACTIVE_SESSION || !CURRENT_LOG_EX || LOG_SAVING) return Promise.resolve(false);
  ACTIVE_SESSION.logDrafts ||= {};
  const draft = {
    rows: loggerRows(), notes: $("#logNotes").value, unit: CURRENT_LOG_UNIT, loadType: CURRENT_LOG_MODE
  };
  const sameSaved = LiftLogLogging.unchangedDraft(loggerExercise(), draft,
    ACTIVE_SESSION.entries[CURRENT_LOG_EX] || [], ACTIVE_SESSION.exerciseNotes?.[CURRENT_LOG_EX] || '');
  if (sameSaved) delete ACTIVE_SESSION.logDrafts[CURRENT_LOG_EX];
  else ACTIVE_SESSION.logDrafts[CURRENT_LOG_EX] = draft;
  const error = $("#logError");
  if (error) error.textContent = "";
  return saveDraft();
}

function openLogger(exId, {preserveScroll = false, preserveLauncher = false} = {}) {
  if (!ACTIVE_SESSION || !DB.exercises[exId] || LOG_SAVING) return;
  if (!preserveLauncher && !CURRENT_LOG_EX) LOGGER_RETURN_FOCUS = document.activeElement;
  const scrollTop = $("#logModal .drawer-body").scrollTop;
  CURRENT_LOG_EX = exId;
  const draft = ACTIVE_SESSION.logDrafts?.[exId];
  CURRENT_LOG_MODE = LiftLogExerciseLoad.MODES.includes(draft?.loadType) ? draft.loadType
    : draft ? LiftLogExerciseLoad.resolveSetMode({}, DB.exercises[exId]) : LiftLogExerciseLoad.resolveMode(DB.exercises[exId]);
  const ex = loggerExercise();
  CURRENT_LOG_UNIT = draft && ["kg", "lbs"].includes(draft.unit) ? draft.unit : getWeightUnit();
  setupWorkoutBodyweight();
  $("#logModalTitle").textContent = ex.name;
  const category = ex.type === 'cardio' ? 'Cardio' : ex.muscle || 'Other';
  $("#logModal").style.setProperty('--logger-muscle', MUSCLE_COLORS[category] || MUSCLE_COLORS.Other);
  const headers = $("#logHeaders");
  headers.querySelector(".h-val-1").textContent = ex.type === 'cardio'
    ? "MINS" : `${LiftLogExerciseLoad.rawLabel(CURRENT_LOG_MODE).toUpperCase()} (${CURRENT_LOG_UNIT.toUpperCase()})`;
  headers.querySelector(".h-val-2").textContent = ex.type === 'cardio'
    ? (ex.cardioMetric || 'km').toUpperCase() : "REPS";

  const history = $("#prevSessionInfo");
  history.innerHTML = "";
  history.hidden = true;
  $("#loggerCopySlot").innerHTML = "";
  const last = LiftLogLogging.findLast(exId, ex, DB.sessions, ACTIVE_SESSION);
  if (last) {
    const dateText = new Date(last.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const routine = last.session.templateName || (last.session.templateId ? 'another routine' : 'Freestyle');
    const context = last.sameRoutine
      ? (ACTIVE_SESSION.templateId || ACTIVE_SESSION.templateName ? 'Last in this routine' : 'Last freestyle workout')
      : `Last in ${routine}`;
    const performance = LiftLogLogging.rowsFromSets(ex, last.sets, CURRENT_LOG_UNIT).map((row, index) =>
      ex.type === 'cardio'
        ? `<span class="logger-previous-set" aria-label="Set ${index + 1}">${escapeHTML(row.a)} min · ${escapeHTML(row.b)} ${escapeHTML(ex.cardioMetric || 'km')}</span>`
        : `<span class="logger-previous-set" aria-label="Set ${index + 1}">${escapeHTML(LiftLogLogging.formatStrengthSet(row.originalSet, ex, CURRENT_LOG_UNIT))}</span>`
    ).join("");
    history.hidden = false;
    history.innerHTML = `<details class="logger-history-details" open><summary><span><strong>${escapeHTML(context)}</strong><time datetime="${escapeHTML(last.date)}">${escapeHTML(dateText)}</time></span><span class="logger-history-chevron" aria-hidden="true"><span class="logger-symbol logger-symbol-caret"></span></span></summary><div class="logger-previous-sets">${performance}</div></details>`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'logger-icon-button logger-copy-last';
    copy.id = 'btnCopyLastSets';
    const copyLabel = ex.type === 'cardio' ? 'Copy last time, distance and set count' : 'Copy last weights and set count';
    copy.setAttribute('aria-label', copyLabel); copy.title = copyLabel;
    copy.innerHTML = '<span class="logger-copy-artwork" aria-hidden="true"><img src="assets/icons/copy-original.jpg" alt=""></span>';
    copy.addEventListener('click', async () => {
      if (LOG_SAVING || !ACTIVE_SESSION || CURRENT_LOG_EX !== exId) return;
      const sessionId = ACTIVE_SESSION.id;
      if (loggerRows().some(row => row.a.trim() || row.b.trim())) {
        const message = ex.type === 'cardio' ? 'Copy the previous time, distance and set count? Your exercise notes will stay.'
          : 'Copy the previous weights and set count? Reps will start blank. Your exercise notes will stay.';
        if (!await askConfirm('Replace these inputs?', message)) return;
      }
      if (LOG_SAVING || ACTIVE_SESSION?.id !== sessionId || CURRENT_LOG_EX !== exId) return;
      $("#logRows").innerHTML = "";
      LiftLogLogging.rowsForCopy(ex, last.sets, CURRENT_LOG_UNIT).forEach(row => addLogRow(ex, row));
      if (!await captureLogDraft()) $("#logError").textContent = 'These inputs could not be saved. Keep this workout open and try again.';
    });
    $("#loggerCopySlot").appendChild(copy);
  }
  if (ex.type !== 'cardio' && CURRENT_LOG_UNIT !== getWeightUnit()) {
    const unitNote = document.createElement('p');
    unitNote.className = 'small';
    unitNote.textContent = `Your unfinished inputs are still in ${CURRENT_LOG_UNIT.toUpperCase()}.`;
    history.hidden = false;
    history.appendChild(unitNote);
  }

  $("#logRows").innerHTML = "";
  const currentSets = ACTIVE_SESSION.entries[exId] || [];
  if (draft && Array.isArray(draft.rows)) {
    draft.rows.forEach(row => addLogRow(ex, row));
  } else if (currentSets.length) {
    LiftLogLogging.rowsFromSets(ex, currentSets, CURRENT_LOG_UNIT).forEach(row => addLogRow(ex, row));
  } else {
    const templateItem = DB.templates[ACTIVE_SESSION.templateId]?.exercises?.find(item => item.exId === exId);
    const rowCount = Math.min(20, Math.max(1, Number.parseInt(templateItem?.sets, 10) || 1));
    for (let i = 0; i < rowCount; i++) addLogRow(ex);
  }
  $("#logNotes").value = draft ? draft.notes || '' : ACTIVE_SESSION.exerciseNotes?.[exId] || '';
  $("#logNotes").setAttribute('aria-label', 'Exercise notes');
  if (!$("#logError")) {
    const error = document.createElement('p');
    error.id = 'logError';
    error.className = 'text-red small';
    error.setAttribute('role', 'alert');
    $("#logRows").after(error);
  }
  $("#logError").textContent = '';
  LOGGER_SCROLL_LOCK.acquire('logger');
  $("#logModal").classList.remove("hidden");
  resetEditorScroll($("#logModal .drawer-body"));
  if (preserveScroll) $("#logModal .drawer-body").scrollTop = scrollTop;
  focusModalTitle($("#logModalTitle"));
  updateSaveStatus();
  captureLogDraft();
}

function addLogRow(ex, data = null) {
  const row = document.createElement("div");
  row.className = "log-row";
  row._sourceRow = {...data};
  if (ex.type !== 'cardio' && !data?.originalSet) row._sourceRow.loadType = data?.loadType || CURRENT_LOG_MODE;
  if (data?.originalSet) row._sourceRow.originalSet = { ...data.originalSet };
  if (data?.originalKg !== undefined) {
    row._sourceRow.originalKg = data.originalKg;
    row._sourceRow.originalDisplay = data.originalDisplay;
  }
  row.innerHTML = `
    <div class="log-set-heading"><strong>SET <span class="index-num">#</span></strong><button class="btn-ghost text-red remove-row" type="button"><span class="logger-symbol logger-symbol-close" aria-hidden="true"></span></button></div>
    <label class="log-field log-field-first"><span class="log-field-name h-val-1"></span><input class="neo-input input-val-1" type="text" inputmode="decimal" autocomplete="off"></label>
    <label class="log-field log-field-second"><span class="log-field-name h-val-2"></span><input class="neo-input input-val-2" type="text" inputmode="${ex.type === 'cardio' ? 'decimal' : 'numeric'}" autocomplete="off"></label>
  `;
  const first = row.querySelector('.input-val-1');
  const second = row.querySelector('.input-val-2');
  first.value = data?.a ?? '';
  second.value = data?.b ?? '';
  const mode = data?.originalSet ? LiftLogExerciseLoad.resolveSetMode(data.originalSet, ex) : row._sourceRow.loadType;
  row.dataset.loadType = ex.type === 'cardio' ? 'cardio' : mode;
  first.hidden = mode === 'bodyweight' && ex.type !== 'cardio';
  row.querySelector('.log-field-first').hidden = first.hidden;
  if (first.hidden) first.value = '';
  first.addEventListener('input', captureLogDraft);
  second.addEventListener('input', captureLogDraft);
  row.querySelector('.remove-row').addEventListener('click', () => {
    if (LOG_SAVING) return;
    row.remove();
    renumberRows();
    captureLogDraft();
  });
  $("#logRows").appendChild(row);
  renumberRows();
}

function renumberRows() {
  const ex = DB.exercises[CURRENT_LOG_EX];
  const rows = Array.from($$("#logRows .log-row"));
  const modes = new Set(rows.map(row => row.dataset.loadType));
  const repsOnly = ex.type !== 'cardio' && modes.size === 1 && modes.has('bodyweight');
  $("#logHeaders").classList.toggle('log-reps-only', repsOnly);
  $("#logHeaders").querySelector('.h-val-1').hidden = repsOnly;
  $("#logHeaders").querySelector('.h-val-1').textContent = ex.type === 'cardio' ? 'MINS'
    : `${modes.size > 1 ? 'LOAD' : LiftLogExerciseLoad.rawLabel(rows[0]?.dataset.loadType || CURRENT_LOG_MODE).toUpperCase()} (${CURRENT_LOG_UNIT.toUpperCase()})`;
  rows.forEach((row, index) => {
    row.querySelector('.index-num').textContent = index + 1;
    const firstLabel = ex.type === 'cardio' ? 'Minutes' : `${LiftLogExerciseLoad.rawLabel(row.dataset.loadType)} in ${CURRENT_LOG_UNIT}`;
    const secondLabel = ex.type === 'cardio' ? `Distance in ${ex.cardioMetric || 'km'}` : 'Repetitions';
    row.querySelector('.input-val-1').setAttribute('aria-label', `Set ${index + 1}: ${firstLabel}`);
    row.querySelector('.input-val-2').setAttribute('aria-label', `Set ${index + 1}: ${secondLabel}`);
    const firstHeading = row.querySelector('.log-field-first .log-field-name');
    const secondHeading = row.querySelector('.log-field-second .log-field-name');
    if (firstHeading) firstHeading.textContent = ex.type === 'cardio' ? 'MINS'
      : row.dataset.loadType === 'external' ? CURRENT_LOG_UNIT.toUpperCase()
      : `${LiftLogExerciseLoad.rawLabel(row.dataset.loadType).toUpperCase()} (${CURRENT_LOG_UNIT.toUpperCase()})`;
    if (secondHeading) secondHeading.textContent = ex.type === 'cardio' ? (ex.cardioMetric || 'km').toUpperCase() : 'REPS';
    row.querySelector('.remove-row').setAttribute('aria-label', `Remove set ${index + 1}`);
    let modeLabel = row.querySelector('.log-row-mode');
    if (modes.size > 1) {
      if (!modeLabel) { modeLabel = document.createElement('span'); modeLabel.className = 'log-row-mode'; row.prepend(modeLabel); }
      modeLabel.textContent = LiftLogExerciseLoad.rawLabel(row.dataset.loadType);
    } else if (modeLabel) modeLabel.remove();
  });
}

$("#btnAddRow").addEventListener("click", () => {
  if (!ACTIVE_SESSION || LOG_SAVING) return;
  const ex = loggerExercise();
  addLogRow(ex, LiftLogLogging.nextRow(ex, loggerRows()));
  captureLogDraft();
});
$("#logNotes").addEventListener('input', captureLogDraft);

async function saveLog() {
  if (!ACTIVE_SESSION || !CURRENT_LOG_EX || LOG_SAVING) return;
  const exId = CURRENT_LOG_EX;
  const ex = loggerExercise();
  const raw = { rows: loggerRows(), notes: $("#logNotes").value, unit: CURRENT_LOG_UNIT, loadType: CURRENT_LOG_MODE };
  const result = LiftLogLogging.parseRows(ex, raw.rows, raw.unit, {snapshotNew: true, loadType: CURRENT_LOG_MODE, bodyweightSnapshot: ACTIVE_SESSION.bodyweightSnapshot});
  if (result.error) {
    $("#logError").textContent = result.error;
    const invalidRow = $$("#logRows .log-row")[result.row];
    if (invalidRow) {
      const first = invalidRow.querySelector('.input-val-1');
      (first.hidden ? invalidRow.querySelector('.input-val-2') : first).focus();
    }
    return;
  }
  const session = ACTIVE_SESSION;
  const beforeCompleted = (session.order || Object.keys(session.entries)).filter(id => LiftLogDates.completedSets(session.entries[id] || [], DB.exercises[id]).length > 0);
  const oldEntries = session.entries[exId];
  const oldNotes = session.exerciseNotes?.[exId];
  session.entries[exId] = result.entries;
  session.exerciseNotes ||= {};
  session.exerciseNotes[exId] = raw.notes;
  session.logDrafts ||= {};
  delete session.logDrafts[exId];
  LOG_SAVING = true;
  const controls = Array.from($$("#logModal input, #logModal textarea, #logModal button"));
  controls.forEach(control => control.disabled = true);
  const saved = await saveDraft();
  LOG_SAVING = false;
  controls.forEach(control => control.disabled = false);
  if (!saved) {
    if (oldEntries === undefined) delete session.entries[exId];
    else session.entries[exId] = oldEntries;
    if (oldNotes === undefined) delete session.exerciseNotes[exId];
    else session.exerciseNotes[exId] = oldNotes;
    session.logDrafts[exId] = raw;
    $("#logError").textContent = 'These changes could not be saved. Keep this workout open and try again.';
    return;
  }
  $("#logModal").classList.add("hidden");
  LOGGER_SCROLL_LOCK.release('logger');
  CURRENT_LOG_EX = null;
  if (ACTIVE_SESSION) renderActiveSession(ACTIVE_SESSION.id === session.id ? { beforeCompleted, savedExercise: exId } : undefined);
  restoreLoggerFocus(exId);
}
$("#btnSaveLog").addEventListener("click", saveLog);

async function closeLogger() {
  if (LOG_SAVING || !CURRENT_LOG_EX) return;
  const exId = CURRENT_LOG_EX;
  if (!await captureLogDraft()) return;
  $("#logModal").classList.add("hidden");
  LOGGER_SCROLL_LOCK.release('logger');
  CURRENT_LOG_EX = null;
  renderActiveSession();
  restoreLoggerFocus(exId);
}
function restoreLoggerFocus(exId) {
  const target = document.querySelector?.(`#activeExerciseList [data-exercise-id="${exId}"] .exercise-open`) || $("#btnAddExToWorkout");
  restoreModalFocus(LOGGER_RETURN_FOCUS, target);
  LOGGER_RETURN_FOCUS = null;
  LiftLogUpdates.notifySafe();
}
$("#logModalClose").addEventListener("click", closeLogger);
$("#logModal").addEventListener("click", event => {
  if (event.target === $("#logModal")) closeLogger();
});
$("#logModal").addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLogger(); return; }
  trapModalFocus(event, $("#logModal"));
});

async function swapLoggerExercise() {
  const blocked = () => COMMITTING || FINISHING || UPDATE_LOCK || STARTING || !STORE_READY || STORAGE_ERROR;
  if (!ACTIVE_SESSION || !CURRENT_LOG_EX || LOG_SAVING || LOG_SWAPPING || blocked()) return;
  const sourceId = CURRENT_LOG_EX, originalId = ACTIVE_SESSION.id, originalStart = ACTIVE_SESSION.start, epoch = STORAGE_EPOCH;
  const sourceScrollTop = $("#logModal .drawer-body").scrollTop;
  const source = DB.exercises[sourceId];
  const sameSession = () => ACTIVE_SESSION?.id === originalId && ACTIVE_SESSION.start === originalStart && STORAGE_EPOCH === epoch;
  const restore = message => {
    LOG_SWAPPING = false;
    if (!sameSession() || !ACTIVE_SESSION.order?.includes(sourceId)) return;
    openLogger(sourceId, {preserveScroll: true, preserveLauncher: true});
    $("#logModal .drawer-body").scrollTop = sourceScrollTop;
    if (message) $("#logError").textContent = message;
    $("#btnSwapLogExercise").focus?.({preventScroll: true});
  };
  LOG_SWAPPING = true;
  const controls = Array.from($$("#logModal input, #logModal textarea, #logModal button"));
  let flushed = false;
  try {
    // Capture before locking: even a half-entered row must reach storage before
    // the logger can disappear or another exercise can open.
    const pending = captureLogDraft();
    LOG_SAVING = true; controls.forEach(control => control.disabled = true);
    flushed = await pending;
  } catch (error) { storageFailure(error); }
  finally { LOG_SAVING = false; controls.forEach(control => control.disabled = false); }
  if (!flushed || !sameSession() || blocked()) {
    LOG_SWAPPING = false;
    $("#logError").textContent = 'Your inputs could not be saved. Keep this workout open and try again.';
    return;
  }
  $("#logModal").classList.add('hidden'); CURRENT_LOG_EX = null;
  openExercisePicker(async targetId => {
    if (!sameSession() || blocked()) { restore('The workout changed. Try again.'); return; }
    const target = DB.exercises[targetId];
    const category = exercise => exercise?.type === 'cardio' ? 'Cardio' : exercise?.muscle || 'Other';
    if (!target || target.archived || category(target) !== category(source)) { restore('Choose an exercise for the same muscle group.'); return; }
    let plan = LiftLogLogging.planExerciseSwap(ACTIVE_SESSION, sourceId, targetId);
    if (!plan) { restore('This exercise changed. Try again.'); return; }
    if (plan.keepSource && !plan.alreadyPresent) {
      if (!await askConfirm('Keep current work?', `Keep ${source.name} and its sets and notes, then add ${target.name} after it?`)) { restore(); return; }
      if (!sameSession() || blocked()) { restore('The workout changed. Try again.'); return; }
      plan = LiftLogLogging.planExerciseSwap(ACTIVE_SESSION, sourceId, targetId);
      if (!plan) { restore('This exercise changed. Try again.'); return; }
    }
    if (!plan.alreadyPresent) {
      const expected = copyState(ACTIVE_SESSION);
      ACTIVE_SESSION.order = plan.order;
      if (!plan.keepSource) {
        for (const field of ['entries', 'logDrafts', 'exerciseNotes']) if (ACTIVE_SESSION[field]) delete ACTIVE_SESSION[field][sourceId];
      }
      let saved = false;
      LOG_SAVING = true; COMMITTING = true; updateSaveStatus();
      try { saved = await saveDraft(); }
      catch (error) { storageFailure(error); }
      finally { LOG_SAVING = false; COMMITTING = false; updateSaveStatus(); }
      if (!saved) {
        if (sameSession()) {
          if (LiftLogStorage.equal(ACTIVE_SESSION.order, plan.order)) ACTIVE_SESSION.order = expected.order;
          if (!plan.keepSource) for (const field of ['entries', 'logDrafts', 'exerciseNotes']) {
            if (Object.hasOwn(expected[field] || {}, sourceId) && !Object.hasOwn(ACTIVE_SESSION[field] || {}, sourceId)) {
              ACTIVE_SESSION[field] ||= {}; ACTIVE_SESSION[field][sourceId] = expected[field][sourceId];
            }
          }
        }
        restore('The swap could not be saved. Your original exercise is still here.'); return;
      }
    }
    LOG_SWAPPING = false;
    if (!sameSession()) return;
    renderActiveSession(); openLogger(targetId, {preserveLauncher: true});
    $("#logModalClose").focus?.({preventScroll: true});
  }, () => restore(), {filter: source.type === 'cardio' ? 'Cardio' : source.muscle || 'Other', title: 'SWAP EXERCISE',
    excludeIds: [sourceId], lockedFilter: true, allowCreate: false});
  LOGGER_SCROLL_LOCK.release('logger');
}
$("#btnSwapLogExercise").addEventListener('click', swapLoggerExercise);

function findLastSessionWithExercise(exId, context = null) {
  return LiftLogLogging.findLast(exId, DB.exercises[exId] || {}, DB.sessions, context);
}

// --- TEMPLATES ---
function renderRoutineStartCards() {
  const container = $("#routineStartCards");
  container.replaceChildren();
  Object.values(DB.templates).forEach(template => {
    const exercises = (template.exercises || []).map(item => DB.exercises[item.exId]).filter(Boolean);
    const card = document.createElement('button');
    card.className = 'routine-start-card';
    card.innerHTML = `<strong>${escapeHTML(template.name)}</strong><span class="routine-exercises">${exercises.map(ex => {
      const muscle = ex.type === 'cardio' ? 'Cardio' : ex.muscle || 'Other';
      return `<span class="routine-exercise"><i style="--muscle-color:${MUSCLE_COLORS[muscle] || '#999'}"></i><span>${escapeHTML(ex.name)}<small>${escapeHTML(muscle)}</small></span></span>`;
    }).join('')}</span>`;
    card.addEventListener('click', () => startWorkout(template));
    container.appendChild(card);
  });
}
$("#btnSaveTemplate").addEventListener("click", async () => {
    const name = await askText("Save routine", "Name this routine:");
    if(!name) return;
    const tId = uid();
    const exercises = ACTIVE_SESSION.order.map(id => ({ exId: id }));
    DB.templates[tId] = { id: tId, name, exercises };
    saveDB();
    showNotice("Routine saved.");
});

function renderTemplates() {
  const list = $("#templateList");
  list.innerHTML = "";
  renderRoutineStartCards();
  if (!Object.keys(DB.templates).length) {
    list.innerHTML = '<li class="library-empty">Create a routine to keep your exercises in order and start faster.</li>';
    return;
  }
  Object.values(DB.templates).forEach(template => {
    const li = document.createElement('li');
    li.className = 'library-routine';
    const items = template.exercises || [];
    const preview = items.map(item => {
      const ex = DB.exercises[item.exId];
      const muscle = ex?.type === 'cardio' ? 'Cardio' : ex?.muscle || 'Other';
      return `<span class="library-routine-exercise"><i style="--routine-muscle:${MUSCLE_COLORS[muscle] || '#999'}" aria-hidden="true"></i><span>${escapeHTML(ex?.name || 'Unavailable exercise')}</span></span>`;
    }).join('');
    li.innerHTML = `<div class="library-routine-heading"><h3>${escapeHTML(template.name)}</h3><span>${items.length} ${items.length === 1 ? 'exercise' : 'exercises'}</span></div>
      <div class="library-routine-preview">${preview}</div>
      <div class="library-routine-actions"><button class="btn-white small routine-edit" type="button" aria-label="Edit ${escapeHTML(template.name)}">EDIT ROUTINE</button><button class="btn-ghost small text-red routine-delete" type="button" aria-label="Delete ${escapeHTML(template.name)}">DELETE</button></div>`;
    const edit = li.querySelector('.routine-edit');
    edit.dataset.editRoutine = template.id;
    edit.addEventListener('click', () => editTemplate(template.id));
    li.querySelector('.routine-delete').addEventListener('click', () => deleteTemplate(template.id));
    list.appendChild(li);
  });
}

function routineStorageBlocked() {
  return !STORE_READY || STORAGE_ERROR || UPDATE_LOCK || COMMITTING || FINISHING || STARTING;
}
async function persistRoutine(id, next, baseline, epoch) {
  if (routineStorageBlocked()) return {ok: false, error: 'Your changes could not be saved. Try again.'};
  COMMITTING = true; updateSaveStatus();
  let committed = false;
  try {
    if (!await flushSaves()) return {ok: false, error: 'Your changes could not be saved. Try again.'};
    if (STORAGE_EPOCH !== epoch || !LiftLogStorage.equal(DB.templates[id] ?? null, baseline)) {
      return {ok: false, error: 'This routine changed elsewhere. Close this editor and reopen the latest version.'};
    }
    const base = copyState(DB), edited = copyState(DB);
    if (next === null) delete edited.templates[id];
    else edited.templates[id] = copyState(next);
    // Commit an isolated copy. A failed write leaves DB and the editor draft intact.
    const result = await STORE.saveDB(edited, base, {epoch});
    committed = true;
    applySnapshot(result);
    return {ok: true};
  } catch (error) {
    if (committed) { showNotice('Your routine was saved. Reload LiftLog to refresh the screen.', 'error'); return {ok: true}; }
    return {ok: false, error: error.message || 'Your changes could not be saved. Try again.'};
  } finally { COMMITTING = false; updateSaveStatus(); LiftLogUpdates.notifySafe(); }
}
let _deletingRoutine = false;
async function deleteTemplate(id) {
  if (_deletingRoutine || routineStorageBlocked() || !DB.templates[id]) return;
  const original = copyState(DB.templates[id]), epoch = STORAGE_EPOCH;
  _deletingRoutine = true;
  try {
    if (!await askConfirm('Delete routine?', 'Past workouts will stay in History.')) return;
    const result = await persistRoutine(id, null, original, epoch);
    if (!result.ok) { showNotice(result.error, 'error'); return; }
    renderTemplates();
  } finally { _deletingRoutine = false; }
}

// --- TEMPLATE BUILDER ---
let _templateBuilderExercises = [];
let _editingTemplateId = null;
let _templateBaseline = null;
let _templateEpoch = 0;
let _templateOpen = false;
let _templateBusy = false;
let _templateConfirming = false;
let _templateReturnFocus = null;
let _templateDrag = null;

function templateBuilderBlocked() { return !_templateOpen || _templateBusy || _templateConfirming || routineStorageBlocked(); }
function templateBuilderDirty() {
  return $("#templateBuilderName").value !== (_templateBaseline?.name || '')
    || !LiftLogStorage.equal(_templateBuilderExercises, _templateBaseline?.exercises || []);
}
function openTemplateBuilder(template = null) {
  if (_templateOpen || routineStorageBlocked()) return;
  _templateReturnFocus = document.activeElement;
  _templateBaseline = template ? copyState(template) : null;
  _templateEpoch = STORAGE_EPOCH;
  _editingTemplateId = template?.id || null;
  _templateBuilderExercises = copyState(template?.exercises || []);
  _templateOpen = true;
  $("#templateBuilderName").value = template?.name || '';
  $("#templateBuilderTitle").textContent = template ? 'EDIT ROUTINE' : 'CREATE ROUTINE';
  $("#templateBuilderError").textContent = '';
  $("#templateBuilderStatus").textContent = '';
  renderTemplateBuilderList();
  $("#templateBuilderModal").classList.remove('hidden');
  LOGGER_SCROLL_LOCK.acquire('routine-builder');
  resetEditorScroll($("#templateBuilderBody"));
  $("#templateBuilderTitle").focus({preventScroll: true});
}
$("#btnNewTemplate").addEventListener('click', () => openTemplateBuilder());
function editTemplate(id) { if (DB.templates[id]) openTemplateBuilder(DB.templates[id]); }

function finishTemplateBuilder() {
  cancelTemplateDrag();
  _templateOpen = false; _editingTemplateId = null; _templateBaseline = null; _templateBuilderExercises = [];
  $("#templateBuilderModal").classList.add('hidden');
  LOGGER_SCROLL_LOCK.release('routine-builder');
  const id = _templateReturnFocus?.dataset?.editRoutine;
  const target = _templateReturnFocus?.isConnected ? _templateReturnFocus
    : id ? document.querySelector(`[data-edit-routine="${id}"]`) || $("#btnNewTemplate") : $("#btnNewTemplate");
  target?.focus({preventScroll: true});
  _templateReturnFocus = null;
  LiftLogUpdates.notifySafe();
}
async function closeTemplateBuilder() {
  if (!_templateOpen || _templateBusy || _templateConfirming) return;
  cancelTemplateDrag();
  if (templateBuilderDirty()) {
    _templateConfirming = true;
    let discard;
    try { discard = await askConfirm('Discard routine edits?', 'Your saved routine will stay unchanged.'); }
    finally { _templateConfirming = false; }
    if (!discard) return;
  }
  finishTemplateBuilder();
}
$("#btnCloseTemplateBuilder").addEventListener('click', closeTemplateBuilder);
$("#templateBuilderModal").addEventListener('click', event => { if (event.target === $("#templateBuilderModal")) closeTemplateBuilder(); });
$("#templateBuilderModal").addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); if (_templateDrag) cancelTemplateDrag(); else closeTemplateBuilder(); return; }
  if (event.key !== 'Tab' || _templateBusy) return;
  const controls = [...$("#templateBuilderModal").querySelectorAll('button, input')].filter(node => !node.disabled && node.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (!first) return;
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
});

$("#btnAddExToTemplate").addEventListener('click', () => {
  if (templateBuilderBlocked()) return;
  cancelTemplateDrag();
  $("#templateBuilderModal").classList.add('hidden');
  const restore = () => {
    if (!_templateOpen) return;
    renderTemplateBuilderList();
    $("#templateBuilderModal").classList.remove('hidden');
    $("#btnAddExToTemplate").focus({preventScroll: true});
  };
  openExercisePicker(exId => {
    if (!_templateOpen || routineStorageBlocked()) { restore(); return; }
    if (!_templateBuilderExercises.some(item => item.exId === exId)) {
      _templateBuilderExercises.push({exId}); clearTemplateValidation();
    }
    restore();
  }, restore);
});

function clearTemplateValidation() {
  const error = $("#templateBuilderError");
  if (['Enter a routine name.', 'Add at least one exercise.'].includes(error.textContent)) error.textContent = '';
}
$("#templateBuilderName").addEventListener('input', clearTemplateValidation);

function moveTemplateExercise(from, to) {
  if (templateBuilderBlocked() || !Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= _templateBuilderExercises.length || to >= _templateBuilderExercises.length) return false;
  const [item] = _templateBuilderExercises.splice(from, 1);
  _templateBuilderExercises.splice(to, 0, item);
  clearTemplateValidation();
  renderTemplateBuilderList();
  $("#templateBuilderList").children[to]?.querySelector('.routine-drag-handle').focus({preventScroll: true});
  const name = DB.exercises[item.exId]?.name || 'Exercise';
  $("#templateBuilderStatus").textContent = `${name} moved to position ${to + 1} of ${_templateBuilderExercises.length}.`;
  return true;
}
async function removeTemplateExercise(index) {
  if (templateBuilderBlocked()) return;
  const item = _templateBuilderExercises[index];
  if (!item) return;
  cancelTemplateDrag();
  _templateConfirming = true;
  let accepted;
  try { accepted = await askConfirm('Remove exercise?', `Remove ${DB.exercises[item.exId]?.name || 'this exercise'} from this routine? Past workouts will stay unchanged.`); }
  finally { _templateConfirming = false; }
  if (!accepted || templateBuilderBlocked()) return;
  const current = _templateBuilderExercises.indexOf(item);
  if (current < 0) return;
  _templateBuilderExercises.splice(current, 1);
  clearTemplateValidation();
  renderTemplateBuilderList();
  const target = $("#templateBuilderList").children[Math.min(current, _templateBuilderExercises.length - 1)]?.querySelector('.routine-remove') || $("#btnAddExToTemplate");
  target.focus({preventScroll: true});
  $("#templateBuilderStatus").textContent = 'Exercise removed from this draft.';
}
function renderTemplateBuilderList() {
  const container = $("#templateBuilderList");
  container.innerHTML = '';
  $("#templateExerciseCount").textContent = `${_templateBuilderExercises.length} ${_templateBuilderExercises.length === 1 ? 'exercise' : 'exercises'}`;
  if (!_templateBuilderExercises.length) {
    container.innerHTML = '<p class="template-builder-empty">Add your first exercise.</p>';
    return;
  }
  _templateBuilderExercises.forEach((item, index) => {
    const ex = DB.exercises[item.exId];
    const category = ex?.type === 'cardio' ? 'Cardio' : ex?.muscle || 'Other';
    const row = document.createElement('div');
    row.className = 'routine-builder-row'; row.dataset.index = index;
    row.style.setProperty('--routine-muscle', MUSCLE_COLORS[category] || '#999');
    const name = ex?.name || 'Unavailable exercise';
    const sets = item.sets ? ` · ${escapeHTML(item.sets)} ${Number(item.sets) === 1 ? 'set' : 'sets'}` : '';
    row.innerHTML = `<button class="routine-drag-handle" type="button" aria-label="Reorder ${escapeHTML(name)}, position ${index + 1} of ${_templateBuilderExercises.length}" aria-describedby="routineReorderHelp"><span aria-hidden="true">⠿</span></button>
      <div class="routine-builder-copy"><strong>${escapeHTML(name)}</strong><span><i aria-hidden="true"></i>${escapeHTML(category)}${sets}</span></div>
      <button class="routine-remove" type="button" aria-label="Remove ${escapeHTML(name)} from routine">×</button>`;
    const handle = row.querySelector('.routine-drag-handle');
    handle.addEventListener('keydown', event => {
      const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? _templateBuilderExercises.length - 1 : null;
      if (to === null) return;
      event.preventDefault(); moveTemplateExercise(index, to);
    });
    handle.addEventListener('pointerdown', event => startTemplateDrag(event, index, row, handle));
    handle.addEventListener('pointermove', moveTemplateDrag);
    handle.addEventListener('pointerup', endTemplateDrag);
    handle.addEventListener('pointercancel', cancelTemplateDrag);
    handle.addEventListener('lostpointercapture', cancelTemplateDrag);
    row.querySelector('.routine-remove').addEventListener('click', () => removeTemplateExercise(index));
    container.appendChild(row);
  });
}
function cancelTemplateDrag() {
  const drag = _templateDrag;
  if (!drag) return;
  _templateDrag = null;
  drag.row.classList.remove('is-dragging'); drag.row.style.removeProperty('transform');
  $("#templateBuilderList").querySelectorAll('.is-drop-target').forEach(row => row.classList.remove('is-drop-target'));
  if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}
function startTemplateDrag(event, index, row, handle) {
  cancelTemplateDrag();
  if (templateBuilderBlocked() || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  _templateDrag = {pointerId: event.pointerId, from: index, to: index, startY: event.clientY, offset: 0, scrollStart: $("#templateBuilderBody").scrollTop, row, handle};
  handle.setPointerCapture(event.pointerId);
  row.classList.add('is-dragging');
}
function moveTemplateDrag(event) {
  const drag = _templateDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (templateBuilderBlocked()) { cancelTemplateDrag(); return; }
  event.preventDefault();
  const pane = $("#templateBuilderBody"), bounds = pane.getBoundingClientRect();
  if (event.clientY < bounds.top + 45) pane.scrollTop -= 12;
  else if (event.clientY > bounds.bottom - 45) pane.scrollTop += 12;
  const rows = [...$("#templateBuilderList").children];
  let closest = drag.from, distance = Infinity;
  rows.forEach((row, index) => {
    const rect = row.getBoundingClientRect();
    const center = (rect.top + rect.bottom) / 2 - (index === drag.from ? drag.offset : 0);
    const delta = Math.abs(event.clientY - center);
    if (delta < distance) { closest = index; distance = delta; }
    row.classList.remove('is-drop-target');
  });
  drag.to = closest;
  if (closest !== drag.from) rows[closest].classList.add('is-drop-target');
  drag.offset = event.clientY - drag.startY + pane.scrollTop - drag.scrollStart;
  drag.row.style.transform = `translateY(${drag.offset}px)`;
}
function endTemplateDrag(event) {
  const drag = _templateDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const {from, to} = drag;
  cancelTemplateDrag();
  moveTemplateExercise(from, to);
}
document.addEventListener('pointerdown', event => {
  if (_templateDrag && event.pointerId !== _templateDrag.pointerId) cancelTemplateDrag();
}, {passive: true});

$("#btnSaveTemplateBuilder").addEventListener('click', async () => {
  if (templateBuilderBlocked()) return;
  cancelTemplateDrag();
  const rawName = $("#templateBuilderName").value;
  const name = rawName === _templateBaseline?.name ? rawName : rawName.trim();
  const error = $("#templateBuilderError"); error.textContent = '';
  if (!name.trim()) { error.textContent = 'Enter a routine name.'; $("#templateBuilderName").focus(); return; }
  if (!_templateBuilderExercises.length) { error.textContent = 'Add at least one exercise.'; $("#btnAddExToTemplate").focus(); return; }
  if (!templateBuilderDirty()) { finishTemplateBuilder(); return; }
  const id = _editingTemplateId || uid();
  const next = {...copyState(_templateBaseline || {}), id, name, exercises: copyState(_templateBuilderExercises)};
  _templateBusy = true;
  const controls = [...$("#templateBuilderModal").querySelectorAll('button, input')];
  controls.forEach(control => { control.disabled = true; });
  const result = await persistRoutine(id, next, _templateBaseline, _templateEpoch);
  _templateBusy = false;
  controls.forEach(control => { control.disabled = false; });
  if (!result.ok) { error.textContent = result.error; return; }
  renderTemplates(); finishTemplateBuilder();
});

// --- HISTORY & STATS ---
function renderHistory() {
  const cont = $("#historyLog");
  const openMonths = new Set([...cont.querySelectorAll('details.history-month')].filter(item => item.open).map(item => item.dataset.month));
  const openWorkouts = new Set([...cont.querySelectorAll('details.history-workout')].filter(item => item.open).map(item => item.dataset.session));
  cont.innerHTML = "";

  if (DB.sessions.length === 0) {
    cont.innerHTML = '<p class="muted">No workouts recorded yet.</p>';
    return;
  }

  // Group sessions by month
  const monthGroups = {};
  DB.sessions.forEach(sess => {
    const date = new Date(sess.start);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!monthGroups[monthKey]) {
      monthGroups[monthKey] = { label: monthLabel, sessions: [] };
    }
    monthGroups[monthKey].sessions.push(sess);
  });

  // Render each month group
  const sortedMonths = Object.keys(monthGroups).sort().reverse();
  sortedMonths.forEach(monthKey => {
    const group = monthGroups[monthKey];

    const monthDiv = document.createElement("details");
    monthDiv.className = "history-month";
    monthDiv.dataset.month = monthKey;
    monthDiv.open = openMonths.has(monthKey);

    const header = document.createElement("summary");
    header.className = "history-month-header";
    header.innerHTML = `
      <span class="history-month-copy"><strong>${escapeHTML(group.label)}</strong><small>${group.sessions.length} ${group.sessions.length === 1 ? 'workout' : 'workouts'}</small></span>
      <span class="history-chevron" aria-hidden="true"></span>
    `;

    const content = document.createElement("div");
    content.className = 'history-month-content';

    group.sessions.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).forEach(sess => {
      const div = document.createElement("details");
      div.className = "history-entry history-workout";
      div.dataset.session = sess.id;
      div.open = openWorkouts.has(sess.id);

      const date = new Date(sess.start).toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'});

      // Calculate workout duration
      let durationStr = "";
      if (sess.end) {
        const startTime = new Date(sess.start).getTime();
        const endTime = new Date(sess.end).getTime();
        const durationMins = Math.max(0, Math.round((endTime - startTime) / 60000));
        if (Number.isFinite(durationMins) && durationMins >= 60) {
          const hours = Math.floor(durationMins / 60);
          const mins = durationMins % 60;
          durationStr = `${hours}h${mins ? ` ${mins}m` : ''}`;
        } else if (Number.isFinite(durationMins)) {
          durationStr = `${durationMins}m`;
        }
      }

      let details = "";
      const completedExercises = LiftLogDates.completedExerciseIds(sess, DB.exercises);
      completedExercises.forEach(exId => {
         const ex = DB.exercises[exId];
         const sets = LiftLogDates.completedSets(sess.entries[exId], ex);
         const exName = ex?.name || "Unknown";
         const unit = getWeightUnit();
         let badges = sets.map(s => {
             let value = '';
             if(ex?.type !== 'cardio' && Number(s.r) > 0) {
               value = escapeHTML(LiftLogLogging.formatStrengthSet(s, ex, unit));
             } else if(Number(s.time) > 0 || Number(s.dist) > 0) {
               const metric = ex?.cardioMetric || 'km';
               value = `${escapeHTML(s.time || 0)}m / ${escapeHTML(s.dist || 0)}${escapeHTML(metric)}`;
             }
             const estimate = ex?.type !== 'cardio' ? LiftLogLogging.estimatedSetText(s, unit) : '';
             return value ? `<span class="history-set"><span class="set-tag">${value}</span>${estimate ? `<small class="muted">${escapeHTML(estimate)}</small>` : ''}${s.note ? `<span class="history-set-note">${escapeHTML(s.note)}</span>` : ''}</span>` : '';
         }).join("");
         const muscle = ex?.type === 'cardio' ? 'Cardio' : (ex?.muscle || 'Other');
         const muscleColor = MUSCLE_COLORS[muscle] || '#999';
         details += `<div class="history-detail" style="--history-muscle:${muscleColor}"><strong>${escapeHTML(exName)}</strong>${badges}${sess.exerciseNotes?.[exId] ? `<p class="small">${escapeHTML(sess.exerciseNotes[exId])}</p>` : ""}</div>`;
      });

      const routineName = sess.templateName || 'Freestyle';

      // Count only exercises that actually have logged entries
      const loggedExerciseCount = completedExercises.length;
      const exerciseWord = loggedExerciseCount === 1 ? 'exercise' : 'exercises';

      const notesHtml = sess.notes ? `<div class="history-notes"><strong>Workout notes</strong>${escapeHTML(sess.notes)}</div>` : '';

      const summary = document.createElement('summary');
      summary.className = 'history-workout-summary';
      summary.innerHTML = `<span class="history-summary-copy"><span class="history-summary-date">${escapeHTML(date)}</span><strong class="history-summary-name">${escapeHTML(routineName)}</strong><span class="history-summary-meta">${durationStr ? `${durationStr} · ` : ''}${loggedExerciseCount} ${exerciseWord}</span></span><span class="history-chevron" aria-hidden="true"></span>`;
      const body = document.createElement('div');
      body.className = 'history-workout-body';
      body.innerHTML = `${notesHtml}${details || '<p class="muted small">No completed sets recorded.</p>'}<div class="history-workout-actions"><button class="btn-white history-edit">EDIT WORKOUT</button><button class="btn-ghost text-red history-delete">DELETE</button></div>`;
      body.querySelector('.history-edit').addEventListener('click', () => editCompletedWorkout(sess.id));
      body.querySelector('.history-delete').addEventListener('click', () => deleteWorkout(sess.id));
      div.appendChild(summary); div.appendChild(body);
      content.appendChild(div);
    });

    monthDiv.appendChild(header);
    monthDiv.appendChild(content);
    cont.appendChild(monthDiv);
  });
}

async function deleteWorkout(sessionId) {
  if (!await askConfirm("Delete workout?", "This workout will be removed from History. Export a backup first if you want to keep a copy.")) return;
  const index = DB.sessions.findIndex(session => session.id === sessionId);
  if (index < 0) return;
  DB.sessions.splice(index, 1);
  if (!await saveDB()) return;
  renderHistory();
  renderDashboard(); // Update recent logs too
}

// --- STATS CHART (Canvas) ---
function simpleLineChart(ctx, labels, dataPoints, color) {
  // Reset
  ctx.canvas.width = ctx.canvas.offsetWidth;
  ctx.canvas.height = ctx.canvas.offsetHeight;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const padding = 20;
  
  if (dataPoints.length === 0) return;
  
  const maxVal = Math.max(...dataPoints) * 1.1;
  const minVal = Math.min(...dataPoints) * 0.9;
  
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  
  dataPoints.forEach((val, i) => {
    const x = padding + (i / Math.max(1, dataPoints.length - 1)) * (w - padding * 2);
    const y = h - padding - ((val - minVal) / (maxVal - minVal || 1)) * (h - padding * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    
    // Dot
    ctx.fillStyle = color;
    ctx.fillRect(x-3, y-3, 6, 6);
  });
  
  ctx.stroke();
}

function renderStats() {
    // Update unit label
    updateBodyweightUnitLabel();

    // Draw bodyweight chart and entries
    drawBodyweightChart();
    renderBodyweightEntries();
    $("#bwInput").value = "";

    const rangeControl = $("#progressRange");
    document.querySelectorAll?.(".progress-period-tab").forEach(button => {
      button.onclick = () => {
        rangeControl.dataset.period = button.dataset.period;
        if (button.dataset.period === 'custom') {
          const recent = LiftLogDates.progressRange('month');
          if (!$("#progressFrom").value) $("#progressFrom").value = LiftLogDates.localDayKey(recent.startDate);
          if (!$("#progressTo").value) $("#progressTo").value = LiftLogDates.localDayKey(new Date());
        }
        updateStatsChart();
      };
    });
    $("#progressFrom").onchange = updateStatsChart;
    $("#progressTo").onchange = updateStatsChart;
    $("#statLoadMode").onchange = () => {
      const metric = $("#statChartType");
      const measure = metric.value.endsWith('maxWeight') ? 'maxWeight' : 'volume';
      metric.value = `${$("#statLoadMode").value}:${measure}`;
      updateStatsChart();
    };

    // Rebuild after edits/imports while keeping a valid selection and historical archived lifts.
    const sel = $("#statExSelect");
    const previous = sel.value;
    const historicalIds = new Set(DB.sessions.flatMap(session => LiftLogDates.completedExerciseIds(session, DB.exercises)));
    const exercises = Object.values(DB.exercises).filter(ex => !ex.archived || historicalIds.has(ex.id));
    sel.innerHTML = "";
    exercises.forEach(ex => {
        const opt = document.createElement("option");
        opt.value = ex.id; opt.textContent = `${ex.name}${ex.archived ? ' (archived)' : ''}`;
        sel.appendChild(opt);
    });
    if (exercises.some(ex => ex.id === previous)) sel.value = previous;
    sel.onchange = () => {
        _exerciseHistoryExpanded = false;
        updateStatsChart();
    };
    updateStatsChart();

    // Render breakdown chart
    renderBreakdownChart();
}

function updateStatsChart() {
    const exId = $("#statExSelect").value;
    const requestedMetric = $("#statChartType").value;
    const chartType = requestedMetric.endsWith("maxWeight") ? "maxWeight" : "volume";
    const canvas = $("#progChart");
    const selectedPeriod = $("#progressRange").dataset.period || 'all';
    const dateRange = LiftLogDates.progressRange(selectedPeriod, $("#progressFrom").value, $("#progressTo").value);
    $("#progressCustomDates").hidden = selectedPeriod !== 'custom';
    const rangeStatus = $("#progressRangeStatus");
    rangeStatus.textContent = dateRange.error || dateRange.label;
    rangeStatus.classList?.toggle?.('is-error', !!dateRange.error);
    [$("#progressFrom"), $("#progressTo")].forEach(input => input.setAttribute?.('aria-invalid', String(!!dateRange.error)));
    document.querySelectorAll?.(".progress-period-tab").forEach(button => {
      const selected = button.dataset.period === selectedPeriod;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    });

    // High-DPI canvas setup
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    const isDark = document.body.classList.contains("theme-dark");
    const textColor = LiftLogTheme.chartColors().ink;

    const historyContainer = $("#exerciseHistory");
    if (typeof updateChartInspection === "function") updateChartInspection(canvas, []);

    if(!exId) {
        $("#statExercisePill").style.setProperty?.('--progress-muscle', MUSCLE_COLORS.Other || '#78909C');
        $("#statLoadMode").hidden = true;
        $("#statChartType").hidden = true;
        ctx.clearRect(0, 0, w, h);
        ctx.font = "14px -apple-system, sans-serif";
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.fillText("Select an exercise", w / 2, h / 2);
        canvas.setAttribute?.("aria-label", "Exercise progress. Select an exercise to see its history.");
        if (typeof updateChartDataTable === "function") updateChartDataTable(canvas, "Exercise progress · no exercise selected", []);
        const note = $("#statMetricNote"); if (note) { note.textContent = ''; note.hidden = true; }
        if (historyContainer) historyContainer.innerHTML = "";
        $("#exerciseHistoryRegion").hidden = true;
        const toggle = $("#btnToggleLiftHistory"); toggle.disabled = true;
        toggle.setAttribute?.('aria-expanded', 'false'); toggle.setAttribute?.('aria-label', 'Expand lift history, no exercise selected');
        return;
    }

    const ex = DB.exercises[exId];
    $("#statExercisePill").style.setProperty?.('--progress-muscle', MUSCLE_COLORS[ex?.type === 'cardio' ? 'Cardio' : ex?.muscle] || MUSCLE_COLORS.Other || '#78909C');
    const unit = getWeightUnit();
    const loadAPI = typeof LiftLogExerciseLoad !== "undefined" ? LiftLogExerciseLoad : null;
    const setMode = set => loadAPI ? loadAPI.resolveSetMode(set, ex) : set.loadType || (ex?.isAssisted ? 'assisted' : 'external');
    const metricSelect = $("#statChartType");
    const allHistoryForDisplay = DB.sessions.map(session => ({ date: session.start,
      sets: LiftLogDates.completedSets(session.entries?.[exId], ex) })).filter(item => item.sets.length)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const historyForDisplay = allHistoryForDisplay.filter(item => LiftLogDates.inProgressRange(item.date, dateRange));
    // Date ranges must not silently replace the selected load measure when empty.
    const modes = [...new Set(allHistoryForDisplay.flatMap(item => item.sets.map(setMode)))];
    const defaultMode = loadAPI ? loadAPI.resolveMode(ex) : ex?.isAssisted ? 'assisted' : 'external';
    if (!modes.length) modes.push(defaultMode);
    const requestedMode = requestedMetric.includes(':') ? requestedMetric.split(':')[0] : null;
    const mode = metricSelect.dataset.exerciseId === exId && modes.includes(requestedMode) ? requestedMode
      : modes.includes(defaultMode) ? defaultMode : modes[0];
    const names = {
      external: ['Volume', 'Max weight'], assisted: ['Assistance × reps', 'Highest assistance'],
      weighted: ['Added weight × reps', 'Max added weight'], bodyweight: ['Total reps', 'Best set reps']
    };
    const metricName = names[mode][chartType === 'maxWeight' ? 1 : 0];
    const metricUnit = mode === 'bodyweight' ? 'reps' : chartType === 'maxWeight' ? unit : `${unit} × reps`;
    // Preserve historical measures and their values. Only the active load type's
    // two choices appear in the slider, so mixed legacy records cannot crowd it.
    const loadSelect = $("#statLoadMode");
    const loadNames = { external: 'External weight', assisted: 'Machine assistance', weighted: 'Added weight', bodyweight: 'Bodyweight' };
    loadSelect.innerHTML = '';
    modes.forEach(loadMode => {
      const option = document.createElement('option');
      option.value = loadMode; option.textContent = loadNames[loadMode];
      loadSelect.appendChild(option);
    });
    loadSelect.value = mode;
    loadSelect.hidden = modes.length <= 1;
    metricSelect.hidden = false;
    metricSelect.innerHTML = '';
    modes.forEach(loadMode => ['volume', 'maxWeight'].forEach((measure, index) => {
      const option = document.createElement('option');
      option.value = modes.length > 1 ? `${loadMode}:${measure}` : measure;
      option.textContent = names[loadMode][index];
      option.hidden = loadMode !== mode;
      metricSelect.appendChild(option);
    }));
    metricSelect.value = modes.length > 1 ? `${mode}:${chartType}` : chartType;
    metricSelect.dataset.exerciseId = exId;
    const assisted = mode === 'assisted';
    const metricNote = $("#statMetricNote");
    if (metricNote) {
      const explanation = { external: '', assisted: 'Machine assistance logged; more assistance means more help.',
        weighted: 'Added weight only. Bodyweight estimates are kept separate.', bodyweight: 'Reps only. Bodyweight estimates are kept separate.' }[mode];
      metricNote.textContent = [modes.length > 1 ? 'Load types are shown separately. Choose a measure above.' : '', explanation].filter(Boolean).join(' ');
      metricNote.hidden = !metricNote.textContent;
    }
    // Chart needs oldest-first, display needs newest-first
    const history = historyForDisplay.map(item => {
      const sets = item.sets.filter(set => setMode(set) === mode);
      const values = sets.map(set => mode === 'bodyweight' ? Number(set.r) : convertWeight(Number(set.w) || 0));
      return { ...item, count: sets.length, volume: values.reduce((sum, value, i) => sum + value * (mode === 'bodyweight' ? 1 : Number(sets[i].r) || 0), 0), maxWeight: Math.max(0, ...values) };
    }).filter(item => item.count).reverse();

    // Render history list (newest first)
    const historyRegion = $("#exerciseHistoryRegion"), historyToggle = $("#btnToggleLiftHistory");
    const historyHeader = document.querySelector(".exercise-history-header");
    const historyCount = historyForDisplay.length;
    const historyIsExpanded = _exerciseHistoryExpanded && !!historyCount;
    if (historyHeader) historyHeader.style.display = 'block';
    historyRegion.hidden = !historyIsExpanded;
    historyToggle.disabled = !historyCount;
    historyToggle.setAttribute?.('aria-expanded', String(historyIsExpanded));
    historyToggle.setAttribute?.('aria-label', `${historyIsExpanded ? 'Collapse' : 'Expand'} lift history, ${historyCount} sessions in this date range`);
    historyToggle.onclick = () => { _exerciseHistoryExpanded = !_exerciseHistoryExpanded; updateStatsChart(); };
    if (historyContainer) {
        if (historyForDisplay.length === 0) {
            historyContainer.innerHTML = '';
        } else {
            const itemsToShow = historyForDisplay;

            let html = '';
            itemsToShow.forEach(h => {
                const date = new Date(h.date);
                const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
                const setsHtml = h.sets.map(s => {
                    if (ex?.type !== 'cardio' && Number(s.r) > 0) {
                        const displayW = convertWeight(Number(s.w) || 0);
                        const recordedMode = setMode(s);
                        const raw = recordedMode === 'bodyweight' ? 'Bodyweight' : `${displayW}${unit}${recordedMode === 'assisted' ? ' assistance' : recordedMode === 'weighted' ? ' added' : ''}`;
                        const estimate = recordedMode !== 'external' ? loadAPI?.estimatedLoad(s) : null;
                        const estimateText = estimate != null ? `<small class="stat-set-estimate">Est. load ${convertWeight(estimate)}${unit}</small>` : '';
                        return `<span class="set-tag">${raw} × ${escapeHTML(s.r)}${estimateText}</span>`;
                    }
                    if (Number(s.time) > 0 || Number(s.dist) > 0) return `<span class="set-tag">${escapeHTML(s.time || 0)}m / ${escapeHTML(s.dist || 0)}${escapeHTML(ex?.cardioMetric || 'km')}</span>`;
                    return '';
                }).join('');
                html += `<div class="ex-history-item"><div class="ex-history-date"><strong>${dateStr}</strong></div><div class="ex-history-sets">${setsHtml}</div></div>`;
            });
            historyContainer.innerHTML = html;

        }
    }

    // Get the data based on chart type
    const chartData = history.map(h => chartType === "maxWeight" ? h.maxWeight : h.volume);
    if (typeof updateChartDataTable === "function") updateChartDataTable(canvas, `${ex?.name || 'Exercise'} · ${metricName} · ${metricUnit} · ${dateRange.label}`,
      history.map((item, index) => [new Date(item.date).toLocaleDateString(), chartData[index]]));
    canvas.setAttribute?.("role", "img");
    canvas.setAttribute?.("aria-label", `${ex?.name || 'Exercise'}, ${metricName}, ${dateRange.error || dateRange.label}. ${history.length ? 'Tap a point for its value, or use arrow keys and Enter. Escape dismisses the value.' : 'No logged sets in this date range.'} ${assisted ? 'Higher values mean more machine assistance, not greater strength.' : ''}`);

    if(history.length < 2 || chartData.every(v => v === 0)) {
        ctx.clearRect(0, 0, w, h);
        ctx.font = "14px -apple-system, sans-serif";
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.fillText(dateRange.error ? "Check the date range above" : !history.length ? "No logged sets in this date range" : "Need more data for chart", w / 2, h / 2);
        return;
    }

    const padding = { top: 20, right: 20, bottom: 40, left: 40 };
    const { width: chartW, height: chartH } = LiftLogChartMotion.plotGeometry(w, h, padding);
    const { min: roundedMin, max: roundedMax } = LiftLogChartMotion.niceRange(chartData);
    const finalRange = roundedMax - roundedMin;

    ctx.clearRect(0, 0, w, h);

    // Fit the recorded range, so small load changes remain visible.
    ctx.font = "11px -apple-system, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    const numSteps = 5;
    for (let i = 0; i <= numSteps; i++) {
        const val = roundedMin + (i / numSteps) * finalRange;
        const y = padding.top + chartH - (i / numSteps) * chartH;
        ctx.fillText(val < 100 ? Number(val.toFixed(1)).toLocaleString() : formatAxisValue(val), padding.left - 8, y + 4);
        ctx.strokeStyle = LiftLogTheme.chartColors().grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(w - padding.right, y);
        ctx.stroke();
    }

    // X axis labels (dates)
    ctx.textAlign = "center";
    ctx.fillStyle = textColor;
    const xLabelStep = Math.max(1, Math.floor(history.length / 5));
    const xLabels = [];
    history.forEach((item, i) => {
        if (i % xLabelStep === 0 || i === history.length - 1) {
            const x = padding.left + (i / (history.length - 1)) * chartW;
            const date = new Date(item.date);
            const label = `${date.getDate()}/${date.getMonth() + 1}`;
            xLabels.push({ x, label, width: ctx.measureText?.(label)?.width ?? label.length * 6 });
        }
    });
    LiftLogChartMotion.spacedAxisLabels(xLabels).forEach(item => ctx.fillText(item.label, item.x, h - padding.bottom + 20));

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = MUSCLE_COLORS[ex?.muscle] || MUSCLE_COLORS.Other;
    ctx.lineWidth = 3;
    chartData.forEach((val, i) => {
        const x = padding.left + (i / (chartData.length - 1)) * chartW;
        const y = padding.top + chartH - ((val - roundedMin) / finalRange) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw dots
    ctx.fillStyle = ctx.strokeStyle;
    ctx.strokeStyle = LiftLogTheme.chartColors().outline; ctx.lineWidth = 1.3;
    chartData.forEach((val, i) => {
        const x = padding.left + (i / (chartData.length - 1)) * chartW;
        const y = padding.top + chartH - ((val - roundedMin) / finalRange) * chartH;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });
    updateChartInspection(canvas, chartData.map((value, i) => ({
      x: padding.left + i / (chartData.length - 1) * chartW,
      y: padding.top + chartH - (value - roundedMin) / finalRange * chartH,
      label: `${new Date(history[i].date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${Number(value.toFixed(2)).toLocaleString()} ${metricUnit}${assisted ? ' assistance' : ''}`
    })));
}

// --- EXPORT / IMPORT ---
const DATA_VERSION = 1;

function csvCell(value) {
  let text = String(value ?? "");
  // Spreadsheet imports should treat free text as data, including leading '='.
  if (/^[=+@\-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function exportCSV() {
  const rows = [["Date", "Routine", "Exercise", "Set", "Weight (kg)", "Reps", "Time (minutes)", "Distance", "Distance unit", "Workout notes", "Exercise notes", "Load type", "Bodyweight snapshot (kg)", "Bodyweight snapshot date", "Estimated load (kg)"]];
  DB.sessions.forEach(session => (session.order || []).forEach(exId => {
    const ex = DB.exercises[exId];
    (session.entries[exId] || []).forEach((set, index) => rows.push([
      LiftLogDates.localDayKey(session.start), session.templateName || "Freestyle", ex?.name || "Unknown",
      index + 1, set.w ?? "", set.r ?? "", set.time ?? "", set.dist ?? "",
      ex?.type === "cardio" ? ex.cardioMetric || "km" : "", session.notes || "", session.exerciseNotes?.[exId] || set.note || "",
      ex?.type === "cardio" ? "" : LiftLogExerciseLoad.resolveSetMode(set, ex), set.bodyweightKg ?? "", set.bodyweightDate ?? "",
      ex?.type === "cardio" ? "" : LiftLogExerciseLoad.estimatedLoad(set) ?? ""
    ]));
  }));
  rows.push([], ["Bodyweight date", "Weight (kg)"]);
  DB.bodyweight.forEach(entry => rows.push([LiftLogDates.localDayKey(entry.date), entry.kg]));
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}
$("#btnExportCSV").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([exportCSV()], {type: "text/csv;charset=utf-8"}));
  const a = document.createElement("a"); a.href = url; a.download = "liftlog_export.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("#btnExportJSON").addEventListener("click", async () => {
  let data = DB, draft = ACTIVE_SESSION;
  if (await flushSaves()) {
    try {
      // Export the complete committed snapshot, including saves from other windows.
      const snapshot = await STORE.load(); data = snapshot.db; draft = snapshot.draft;
    } catch (error) { storageFailure(error); }
  }
  downloadJSON({version: DATA_VERSION, exportedAt: new Date().toISOString(), data, draft},
    `liftlog_backup_${LiftLogDates.localDayKey(new Date())}.json`);
  if (STORAGE_ERROR) showNotice("Backup includes the edits in this window. Also export recovery to keep all saved copies.", "error");
});

async function restoreFile(event) {
  const file = event.target.files[0]; event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error("This file is too large to be a LiftLog backup (limit 50 MB).");
    const backup = JSON.parse(await file.text());
    const validated = STORE.parseBackupEnvelope(backup);
    if (STORE_READY && !await flushSaves()) return;
    const revision = STORAGE_REVISION;
    if (!await askConfirm("Restore backup?", `Replace current data with ${validated.db.sessions.length} workouts, ${Object.keys(validated.db.exercises).length} exercises and ${Object.keys(validated.db.templates).length} routines${validated.draft ? ", plus an unfinished workout" : ""}? A recovery copy of your current saved data will be kept on this device.`)) return;
    COMMITTING = true; updateSaveStatus();
    const result = await STORE.restore(backup, revision);
    applySnapshot(result); stopTimer(); loadSettings();
    $(".tab[data-tab='dashboard']").click();
    showNotice(validated.draft ? "Backup restored, including your unfinished workout." : "Backup restored. Use Restore previous save in Settings to undo this restore.");
  } catch (error) { showNotice(`Restore cancelled: ${error.message}. Your saved data was not replaced.`, "error"); }
  finally { COMMITTING = false; updateSaveStatus(); }
}
$("#fileRestore").addEventListener("change", restoreFile);
$("#recoveryRestore").addEventListener("change", restoreFile);

// --- PICKER UTILS ---
let _pickerCallback = null;
let _pickerCancelCallback = null;
let _pickerFilter = "All";
let _pickerReturnFocus = null;
let _pickerOptions = {};
let _pickerClosing = false;

function openExercisePicker(cb, cancelCb = null, options = {}) {
  if (_pickerClosing) return;
  _pickerCallback = cb; _pickerCancelCallback = cancelCb;
  _pickerOptions = options;
  _pickerReturnFocus = document.activeElement;
  _pickerFilter = ["All", ...MUSCLE_GROUPS, "Cardio"].includes(options.filter) ? options.filter : "All";
  $("#pickerTitle").textContent = options.title || 'SELECT EXERCISE';
  $("#pickerFooter").hidden = options.allowCreate === false;
  $("#pickerSearch").value = "";
  LOGGER_SCROLL_LOCK.acquire("exercise-picker");
  resumeExercisePicker();
}

function resumeExercisePicker() {
  $("#pickerModal").classList.remove("hidden");
  renderPickerTabs(); renderPickerList();
  $("#pickerTitle").focus({preventScroll: true});
}

function closeExercisePicker(exId = null) {
  if (_pickerClosing) return;
  const callback = exId === null ? _pickerCancelCallback : _pickerCallback;
  const returnFocus = _pickerReturnFocus;
  _pickerCallback = null; _pickerCancelCallback = null; _pickerReturnFocus = null;
  _pickerClosing = true;
  $("#pickerModal").classList.add("hidden");
  const finish = () => {
    _pickerClosing = false; _pickerOptions = {};
    LOGGER_SCROLL_LOCK.release("exercise-picker");
    // A callback may have opened and focused another editor. Keep that focus.
    const active = document.activeElement;
    const focusStillInPicker = active === document.body || !active?.isConnected || !active?.getClientRects().length || $("#pickerModal").contains(active);
    if (focusStillInPicker && returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({preventScroll: true});
  };
  // Preserve synchronous origins and await persistence-based handoffs.
  try {
    const result = callback?.(exId);
    if (result && typeof result.then === 'function') return Promise.resolve(result).then(finish, error => {
      finish(); showNotice(error?.message || 'Could not select this exercise.', 'error');
    });
    finish();
  } catch (error) { finish(); throw error; }
}

function renderPickerTabs() {
  const container = $("#pickerTabs"); container.replaceChildren();
  const filters = _pickerOptions.lockedFilter ? [_pickerFilter] : ["All", ...MUSCLE_GROUPS, "Cardio"];
  filters.forEach(muscle => {
    const tab = document.createElement("button"); tab.type = "button";
    tab.className = `picker-tab ${_pickerFilter === muscle ? "active" : ""}`;
    tab.textContent = muscle; tab.setAttribute("aria-pressed", String(_pickerFilter === muscle));
    if (MUSCLE_COLORS[muscle]) tab.style.setProperty('--filter-color', MUSCLE_COLORS[muscle]);
    tab.onclick = () => {
      _pickerFilter = muscle;
      // Keep the pressed button in place, including keyboard focus and horizontal scroll.
      [...container.children].forEach(button => {
        const active = button === tab;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      renderPickerList();
    };
    container.appendChild(tab);
  });
}

$("#pickerSearch").addEventListener("input", renderPickerList);
function renderPickerList() {
  const q = $("#pickerSearch").value.trim().toLowerCase();
  const list = $("#pickerList"); list.replaceChildren(); list.scrollTop = 0;
  const available = Object.values(DB.exercises).filter(ex => !ex.archived && !(_pickerOptions.excludeIds || []).includes(ex.id));
  const filtered = available.filter(ex => {
    const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
    if (_pickerFilter !== 'All' && category !== _pickerFilter) return false;
    return !q || ex.name.toLowerCase().includes(q);
  }).sort((a, b) => a.name.localeCompare(b.name));
  $("#pickerStatus").textContent = `${filtered.length} exercise${filtered.length === 1 ? '' : 's'}`;
  if (!filtered.length) {
    const empty = document.createElement('p'); empty.className = 'picker-empty';
    empty.textContent = available.length ? 'No matching exercises' : 'No exercises yet'; list.appendChild(empty);
    if (available.length && (q || (!_pickerOptions.lockedFilter && _pickerFilter !== 'All'))) {
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn-black picker-reset'; reset.textContent = 'CLEAR FILTERS';
      reset.onclick = () => { if (!_pickerOptions.lockedFilter) _pickerFilter = 'All'; $("#pickerSearch").value = ''; renderPickerTabs(); renderPickerList(); $("#pickerSearch").focus(); };
      list.appendChild(reset);
    }
  }
  filtered.forEach(ex => {
    const category = ex.type === 'cardio' ? 'Cardio' : ex.muscle || 'Other';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'picker-choice';
    button.style.setProperty('--muscle-color', MUSCLE_COLORS[category] || MUSCLE_COLORS.Other);
    const name = document.createElement('strong'); name.textContent = ex.name;
    const meta = document.createElement('span'); meta.className = 'picker-choice-meta'; meta.textContent = category;
    button.append(name, meta); button.onclick = () => closeExercisePicker(ex.id); list.appendChild(button);
  });
}
$("#pickerCreate").addEventListener('click', () => {
  $("#pickerModal").classList.add('hidden');
  openNewExerciseModal(true);
});
$("#pickerClose").addEventListener('click', () => closeExercisePicker());
$("#pickerModal").addEventListener('click', event => {
  if (event.target === $("#pickerModal")) closeExercisePicker();
});
$("#pickerModal").addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeExercisePicker(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...$("#pickerModal").querySelectorAll('button, input')].filter(node => !node.disabled && node.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
});

// Prevent scroll chaining on all overlays
document.querySelectorAll(".overlay").forEach(overlay => {
  overlay.addEventListener("touchmove", (e) => {
    // Only prevent if the touch is directly on the overlay (not on scrollable content inside)
    const target = e.target;
    const isScrollable = target.closest(".drawer-body, .picker-box, .modal-box, .day-modal-box");
    if (!isScrollable) {
      e.preventDefault();
    }
  }, { passive: false });

  // Prevent wheel scroll on overlay background
  overlay.addEventListener("wheel", (e) => {
    const target = e.target;
    const isScrollable = target.closest(".drawer-body, .picker-box, .modal-box, .day-modal-box");
    if (!isScrollable) {
      e.preventDefault();
    }
  }, { passive: false });
});

// Appearance changes save only the preference; unfinished workouts remain intact.
function setAppTheme(mode) {
   if (!STORE_READY || STORAGE_ERROR || UPDATE_LOCK || COMMITTING) return Promise.resolve(false);
   if (!LiftLogTheme.modes.includes(mode)) return Promise.resolve(false);
   DB.user.theme = mode;
   LiftLogTheme.apply(mode);
   LiftLogRecaps.refreshArtwork();
   // Repaint visible charts after their text, grid and bodyweight colours change.
   const activeTab = $(".tab.active")?.dataset.tab;
   if (activeTab === "stats") {
     drawBodyweightChart();
     updateStatsChart();
     renderBreakdownChart();
   } else if (activeTab === "dashboard") {
     renderCalendar();
   }
   return saveDB();
}
$("#btnTheme").addEventListener("click", () => {
   setAppTheme(LiftLogTheme.next(DB.user.theme));
});

// Timer Toggle - Click anywhere on timer card to toggle display
$("#timerCard").addEventListener("click", (e) => {
  // Don't toggle if clicking the FINISH button
  if (e.target.id === "btnFinishWorkout" || e.target.closest("#btnFinishWorkout")) return;

  const timerDisplay = $("#timerDisplay");
  const toggleIcon = $("#btnToggleTimer");
  timerDisplay.classList.toggle("hidden");

  // Update icon opacity to indicate hidden state
  if (timerDisplay.classList.contains("hidden")) {
    toggleIcon.classList.add("timer-hidden");
  } else {
    toggleIcon.classList.remove("timer-hidden");
  }
});

// Library subviews keep routine management separate from starting a workout.
function showLibraryView(view) {
  const routines = view === 'routines';
  const exercisesPanel = $("#libraryExercisesPanel"), routinesPanel = $("#libraryRoutinesPanel");
  const outgoing = routines ? exercisesPanel : routinesPanel;
  const focusLeavesPanel = typeof document !== 'undefined' && outgoing.contains(document.activeElement);
  $("#librarySwitch").dataset.view = routines ? 'routines' : 'exercises';
  exercisesPanel.hidden = routines;
  routinesPanel.hidden = !routines;
  $("#btnLibraryExercises").setAttribute('aria-pressed', String(!routines));
  $("#btnLibraryRoutines").setAttribute('aria-pressed', String(routines));
  if (routines) renderTemplates(); else renderExerciseLibrary();
  if (focusLeavesPanel) $(routines ? "#btnLibraryRoutines" : "#btnLibraryExercises").focus({preventScroll: true});
}
$("#btnLibraryExercises").addEventListener('click', () => showLibraryView('exercises'));
$("#btnLibraryRoutines").addEventListener('click', () => showLibraryView('routines'));
['exercises', 'routines'].forEach((view, index) => {
  const button = $(index ? "#btnLibraryRoutines" : "#btnLibraryExercises");
  button.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
    showLibraryView(target ? 'routines' : 'exercises');
    $(target ? "#btnLibraryRoutines" : "#btnLibraryExercises").focus({preventScroll: true});
  });
});

// Helper to get latest bodyweight from chart data
function getLatestBodyweight() {
  if (DB.bodyweight.length === 0) return null;
  return DB.bodyweight[DB.bodyweight.length - 1].kg;
}

// Handle orientation change to fix calendar width glitch
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    if ($("#tab-dashboard").classList.contains("active")) {
      renderCalendar();
    }
  }, 100);
});

window.addEventListener("resize", () => {
  if ($("#tab-dashboard").classList.contains("active")) {
    renderCalendar();
  }
});

// --- COLLAPSIBLE SECTIONS ---
// Data section toggle in settings
function setDataExpanded(expanded) {
  const content = $("#dataContent");
  const icon = $("#dataToggle");
  content.classList.toggle('collapsed', !expanded);
  icon.classList.toggle('collapsed', !expanded);
  content.inert = !expanded;
  content.setAttribute('aria-hidden', String(!expanded));
  $("#dataHeader").setAttribute('aria-expanded', String(expanded));
}
function toggleDataExpanded() { setDataExpanded($("#dataContent").classList.contains('collapsed')); }
$("#dataHeader").setAttribute('role', 'button');
$("#dataHeader").setAttribute('tabindex', '0');
$("#dataHeader").setAttribute('aria-controls', 'dataContent');
$("#dataHeader").addEventListener('click', toggleDataExpanded);
$("#dataHeader").addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault(); toggleDataExpanded();
});
setDataExpanded(!$("#dataContent").classList.contains('collapsed'));

// --- SETTINGS TAB ---
function renderSettings() {
  loadSettings();
}

// --- SETTINGS ---
function loadSettings() {
  // Set unit toggle
  const unitToggle = $("#settingUnit");
  if (unitToggle) unitToggle.checked = DB.user.useLbs || false;

  // Set suggestions toggle
  const suggestionsToggle = $("#settingSuggestions");
  if (suggestionsToggle) suggestionsToggle.checked = DB.user.showSuggestions !== false;

  // Set training goal
  const goalSelect = $("#settingGoal");
  if (goalSelect) goalSelect.value = DB.user.trainingGoal || "hypertrophy";
}

// Unit setting change (toggle)
$("#settingUnit").addEventListener("change", (e) => {
  DB.user.useLbs = e.target.checked;
  saveDB();
  // Update all charts and labels
  updateBodyweightUnitLabel();
  renderStats();
});

// --- UNIT CONVERSION HELPERS ---
function convertWeight(kg) {
  // Convert kg value to display unit
  if (DB.user.useLbs) {
    return parseFloat((kg * KG_TO_LBS).toFixed(1));
  }
  return Number(Number(kg).toFixed(2));
}

// Format Y-axis values with K abbreviation for large numbers
function formatAxisValue(val) {
  if (val >= 10000) {
    return (val / 1000).toFixed(0) + 'K';
  } else if (val >= 1000) {
    return (val / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return Math.round(val).toLocaleString();
}

function formatWeight(kg) {
  // Format kg value with unit label
  if (DB.user.useLbs) {
    return (kg * KG_TO_LBS).toFixed(1) + " lbs";
  }
  return Number(Number(kg).toFixed(2)) + " kg";
}

function formatWeightValue(value) {
  // Format a value that's already in display units
  return value + (DB.user.useLbs ? " lbs" : " kg");
}

function getWeightLabel() {
  return DB.user.useLbs ? "LBS" : "KG";
}

function getWeightUnit() {
  return DB.user.useLbs ? "lbs" : "kg";
}

// --- FACTORY RESET ---
$("#btnFactoryReset").addEventListener("click", async () => {
  if (!await flushSaves()) return;
  const revision = STORAGE_REVISION;
  const confirmation = await askText("Reset LiftLog?", 'Remove all current workouts, exercises and routines? A recovery copy will be kept. Type RESET to confirm.');
  if (confirmation !== "RESET") return;
  try {
    COMMITTING = true; updateSaveStatus();
    applySnapshot(await STORE.reset(revision)); stopTimer();
    $(".tab[data-tab='dashboard']").click();
    showNotice("LiftLog reset. Use Restore previous save in Settings to undo this reset.");
  } catch (error) { storageFailure(error); }
  finally { COMMITTING = false; updateSaveStatus(); }
});

// --- WORKOUT NOTES ---
// Save workout notes on input
$("#workoutNotes").addEventListener("input", (e) => {
  if (ACTIVE_SESSION) {
    ACTIVE_SESSION.notes = e.target.value;
    saveDraft();
  }
});

// Load workout notes when rendering active session
function loadWorkoutNotes() {
  const notesField = $("#workoutNotes");
  if (notesField && ACTIVE_SESSION) {
    notesField.value = ACTIVE_SESSION.notes || "";
  }
}

// --- CHART TYPE TOGGLE ---
$("#statChartType").addEventListener("change", () => {
  updateStatsChart();
});

// --- BREAKDOWN CHART ---
let _breakdownOffset = 0; // 0 = current period, -1 = previous, etc.
let _hiddenMuscles = new Set(); // Muscles hidden from chart
let _exerciseHistoryExpanded = false; // Lift History starts collapsed.

function getBreakdownPeriodInfo() {
  const period = $("#breakdownPeriod").value;
  const granularity = $("#breakdownGranularity").value;
  return LiftLogDates.periodInfo(period, granularity, _breakdownOffset);
}

function renderBreakdownChart() {
  const canvas = $("#breakdownChart");
  if (!canvas) return;
  const chartBounds = canvas.getBoundingClientRect();
  if (chartBounds.width <= 0 || chartBounds.height <= 0) return;

  const { startDate, endDate, labels, labelText, period, granularity } = getBreakdownPeriodInfo();
  $("#breakdownPeriodLabel").textContent = labelText;

  const mode = $("#breakdownMode").value; // "volume" or "sets"
  const isDark = document.body.classList.contains("theme-dark");
  const textColor = LiftLogTheme.chartColors().ink;

  // Set up high-DPI canvas
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;

  // Get relevant sessions
  const sessions = DB.sessions.filter(s => LiftLogDates.inPeriod(s.start, startDate, endDate));

  if (sessions.length === 0) {
    if (typeof updateChartInspection === "function") updateChartInspection(canvas, []);
    if (typeof _chartAnimator !== "undefined") _chartAnimator.cancel(canvas, true);
    delete canvas._liftlogBarSignature;
    canvas.setAttribute?.("aria-label", `Workout breakdown, ${labelText}. No workouts in this period.`);
    if (canvas.dataset) canvas.dataset.chartAnimating = "false";
    const table = document.getElementById?.("breakdownDataSummary");
    if (table) table.hidden = true;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "14px -apple-system, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.fillText("No workouts in this period", w / 2, h / 2);
    $("#breakdownLegend").innerHTML = "";
    $("#breakdownCardio").innerHTML = "";
    return;
  }

  // Data structure for all muscle groups including Cardio
  const allGroups = [...MUSCLE_GROUPS, "Cardio"];
  const muscleData = {};
  allGroups.forEach(m => {
    muscleData[m] = {};
    labels.forEach((_, i) => muscleData[m][i] = 0);
  });

  // Calculate data based on mode
  sessions.forEach(s => {
    const sessionDate = new Date(s.start);
    const idx = getBreakdownIndex(sessionDate, startDate, period, labels.length, granularity);
    if (idx < 0) return;

    Object.entries(s.entries || {}).forEach(([exId, recordedSets]) => {
      const ex = DB.exercises[exId];
      const sets = LiftLogDates.completedSets(recordedSets, ex);
      if (!ex || !sets || sets.length === 0) return;

      if (ex.type === "cardio") {
        // Cardio only appears in "sets" mode, not "volume" mode
        if (mode === "sets" && !_hiddenMuscles.has("Cardio")) {
          muscleData["Cardio"][idx] += sets.length;
        }
        return;
      }

      const muscle = allGroups.includes(ex.muscle) ? ex.muscle : "Other";

      if (mode === "volume") {
        // Volume = weight × reps
        let volume = 0;
        sets.forEach(set => {
          const loadMode = typeof LiftLogExerciseLoad !== 'undefined' ? LiftLogExerciseLoad.resolveSetMode(set, ex) : set.loadType || (ex.isAssisted ? 'assisted' : 'external');
          if (loadMode === 'bodyweight') return;
          if (set.w && set.r) {
            volume += convertWeight(parseFloat(set.w)) * parseInt(set.r);
          }
        });

        if (!_hiddenMuscles.has(muscle)) {
          muscleData[muscle][idx] += volume;
        }
      } else {
        // Sets mode - count number of sets
        if (!_hiddenMuscles.has(muscle)) {
          muscleData[muscle][idx] += sets.length;
        }
      }
    });
  });

  // Use roundTo=10 for sets mode, 100 for volume mode
  const roundTo = mode === "sets" ? 10 : 100;
  drawHiResStackedBarChart(ctx, w, h, labels, muscleData, allGroups, textColor, isDark, roundTo);

  // Render clickable legend styled like tabs
  const legendContainer = $("#breakdownLegend");
  const focusedLegend = legendContainer.contains?.(document.activeElement) ? document.activeElement.textContent : null;
  legendContainer.innerHTML = "";

  // Add "All" button first
  const allBtn = document.createElement("button");
  const allSelected = _hiddenMuscles.size === 0;
  allBtn.className = `legend-tab ${allSelected ? "active" : "inactive"}`;
  allBtn.textContent = "All";
  allBtn.setAttribute?.("aria-pressed", String(allSelected));
  allBtn.style.borderColor = isDark ? "#fff" : "#000";
  if (allSelected) {
    allBtn.style.background = isDark ? "#fff" : "#000";
    allBtn.style.color = isDark ? "#000" : "#fff";
  }
  allBtn.onclick = () => {
    if (_hiddenMuscles.size === 0) {
      // Hide all
      allGroups.forEach(m => _hiddenMuscles.add(m));
    } else {
      // Show all
      _hiddenMuscles.clear();
    }
    renderBreakdownChart();
  };
  legendContainer.appendChild(allBtn);

  // Add individual muscle tabs
  allGroups.forEach(muscle => {
    // Check if muscle has any data across the period
    const hasData = Object.values(muscleData[muscle] || {}).some(v => v > 0);
    // Always show if it has data OR if it's currently hidden (so user can re-enable)
    if (!hasData && !_hiddenMuscles.has(muscle)) return;

    const color = MUSCLE_COLORS[muscle] || "#999";
    const isHidden = _hiddenMuscles.has(muscle);

    const tab = document.createElement("button");
    tab.className = `legend-tab ${isHidden ? "inactive" : "active"}`;
    tab.textContent = muscle;
    tab.setAttribute?.("aria-pressed", String(!isHidden));
    tab.style.borderColor = isDark ? "#fff" : "#111";
    if (!isHidden) {
      tab.style.background = color;
      tab.style.color = "#000";
    } else {
      // For inactive state in dark mode
      if (isDark) {
        tab.style.color = "#fff";
      }
    }
    tab.onclick = () => {
      if (_hiddenMuscles.has(muscle)) {
        _hiddenMuscles.delete(muscle);
      } else {
        _hiddenMuscles.add(muscle);
      }
      renderBreakdownChart();
    };
    legendContainer.appendChild(tab);
  });

  if (focusedLegend) {
    [...legendContainer.querySelectorAll("button")].find(button => button.textContent === focusedLegend)?.focus({ preventScroll: true });
  }

  // Assistance remains the raw logged machine load; do not invent historical net loads.
  const hasSpecialLoad = mode === "volume" && sessions.some(session => Object.entries(session.entries || {}).some(([id, sets]) =>
    LiftLogDates.completedSets(sets, DB.exercises[id]).some(set =>
      (typeof LiftLogExerciseLoad !== 'undefined' ? LiftLogExerciseLoad.resolveSetMode(set, DB.exercises[id]) : set.loadType || (DB.exercises[id]?.isAssisted ? 'assisted' : 'external')) !== 'external')));
  $("#breakdownCardio").textContent = hasSpecialLoad ? "Raw weight × reps, including assistance and added weight. Bodyweight estimates stay separate." : "";
}

function getBreakdownIndex(date, startDate, period, maxLabels, granularity = "daily") {
  return LiftLogDates.breakdownIndex(date, startDate, period, maxLabels, granularity);
}

function drawHiResBarChart(ctx, w, h, labels, values, color, textColor, isDark) {
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  ctx.clearRect(0, 0, w, h);

  const maxVal = Math.max(...values) || 100;
  // Round max to nearest 100
  const roundedMax = Math.ceil(maxVal / 100) * 100 || 100;

  const barWidth = chartW / labels.length * 0.7;
  const gap = chartW / labels.length * 0.15;

  // Y axis with rounded values
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillStyle = textColor;
  ctx.textAlign = "right";

  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = (roundedMax / steps) * i;
    const y = padding.top + chartH - (i / steps) * chartH;
    ctx.fillText(formatAxisValue(val), padding.left - 8, y + 4);
    ctx.strokeStyle = LiftLogTheme.chartColors().grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }

  // Bars
  ctx.fillStyle = color;
  values.forEach((val, i) => {
    const x = padding.left + gap + i * (chartW / labels.length);
    const barH = (val / roundedMax) * chartH;
    const y = padding.top + chartH - barH;
    ctx.fillRect(x, y, barWidth, barH);
  });

  // X labels
  ctx.textAlign = "center";
  ctx.fillStyle = textColor;
  const step = labels.length > 15 ? Math.ceil(labels.length / 8) : 1;
  const xLabels = labels.flatMap((label, i) => i % step === 0 || i === labels.length - 1 ? [{
    x: padding.left + gap + barWidth / 2 + i * (chartW / labels.length), label,
    width: ctx.measureText?.(label)?.width ?? label.length * 6
  }] : []);
  LiftLogChartMotion.spacedAxisLabels(xLabels).forEach(item => ctx.fillText(item.label, item.x, h - padding.bottom + 15));
}

function updateBreakdownDataSummary(canvas, labels, muscleData, groups, totals) {
  canvas.setAttribute("role", "img");
  const mode = $("#breakdownMode").value;
  const label = $("#breakdownPeriodLabel").textContent;
  const unit = mode === "sets" ? "sets" : `${getWeightUnit()} × reps`;
  canvas.setAttribute("aria-label", `Workout breakdown, ${label}, ${unit}. Tap a bar for its values, or use arrow keys and Enter. Escape dismisses the values. A data table follows the chart for screen readers.`);
  let details = document.getElementById("breakdownDataSummary");
  if (!details) {
    details = document.createElement("div"); details.id = "breakdownDataSummary"; details.className = "chart-sr-only";
    const body = document.createElement("div"); body.className = "chart-data-scroll";
    details.append(body); canvas.parentElement.insertAdjacentElement("afterend", details);
  }
  details.hidden = false;
  const body = details.querySelector(".chart-data-scroll");
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = `${label} · ${unit} · primary muscle`;
  table.appendChild(caption);
  const visibleGroups = groups.filter(group => !_hiddenMuscles.has(group) && labels.some((_, i) => (muscleData[group]?.[i] || 0) > 0));
  const head = document.createElement("thead"), headRow = document.createElement("tr");
  ["Period", ...visibleGroups, "Total"].forEach(text => { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = text; headRow.appendChild(cell); });
  head.appendChild(headRow); table.appendChild(head);
  const rows = document.createElement("tbody");
  labels.forEach((day, i) => {
    const row = document.createElement("tr"), title = document.createElement("th"); title.scope = "row"; title.textContent = day; row.appendChild(title);
    [...visibleGroups.map(group => muscleData[group]?.[i] || 0), totals[i]].forEach(value => { const cell = document.createElement("td"); cell.textContent = Number(value.toFixed(2)).toLocaleString(); row.appendChild(cell); });
    rows.appendChild(row);
  });
  table.appendChild(rows); body.replaceChildren(table);
}

function drawHiResStackedBarChart(ctx, w, h, labels, muscleData, groups, textColor, isDark, roundTo = 100) {
  const canvas = ctx.canvas || $("#breakdownChart");
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const { width: chartW, height: chartH } = LiftLogChartMotion.plotGeometry(w, h, padding);
  const totals = labels.map((_, i) => groups.reduce((sum, muscle) => sum + (_hiddenMuscles.has(muscle) ? 0 : muscleData[muscle]?.[i] || 0), 0));
  const roundedMax = Math.ceil((Math.max(...totals) || roundTo) / roundTo) * roundTo || roundTo;
  const barWidth = chartW / labels.length * 0.7, gap = chartW / labels.length * 0.15;
  const target = labels.flatMap((label, index) => groups.map(muscle => ({
    key: `${index}:${muscle}`, delayIndex: index,
    value: (_hiddenMuscles.has(muscle) ? 0 : muscleData[muscle]?.[index] || 0) / roundedMax * chartH
  })));
  updateBreakdownDataSummary(canvas, labels, muscleData, groups, totals);
  const unit = $("#breakdownMode").value === "sets" ? "sets" : `${getWeightUnit()} × reps`;
  updateChartInspection(canvas, labels.map((label, i) => ({
    x: padding.left + gap + i * chartW / labels.length, y: padding.top + chartH - totals[i] / roundedMax * chartH,
    width: barWidth, height: totals[i] / roundedMax * chartH,
    label: `${label} · ${Number(totals[i].toFixed(2)).toLocaleString()} ${unit}\n${groups.filter(group => !_hiddenMuscles.has(group) && muscleData[group]?.[i] > 0).map(group => `${group} ${Number(muscleData[group][i].toFixed(2)).toLocaleString()}`).join(' · ')}`
  })).filter(item => item.height > 0));
  // Period structure changes get a short entrance. Legend/filter updates keep
  // the currently drawn stack and transition directly to the latest values.
  const signature = labels.join("|");
  const entrance = canvas._liftlogBarSignature !== signature;
  canvas._liftlogBarSignature = signature;
  _chartAnimator.animate(canvas, target, (heights, finished) => {
    canvas.dataset.chartAnimating = String(!finished);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px -apple-system, sans-serif"; ctx.fillStyle = textColor; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + chartH - i / 5 * chartH;
      ctx.fillText(formatAxisValue(roundedMax / 5 * i), padding.left - 8, y + 4);
      ctx.strokeStyle = LiftLogTheme.chartColors().grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(w - padding.right, y); ctx.stroke();
    }
    labels.forEach((_, i) => {
      const x = padding.left + gap + i * chartW / labels.length;
      let currentY = padding.top + chartH;
      const stack = heights.slice(i * groups.length, (i + 1) * groups.length);
      const topGroup = stack.findLastIndex(height => height > 0.01);
      groups.forEach((muscle, groupIndex) => {
        const height = stack[groupIndex];
        if (height <= 0.01) return;
        ctx.fillStyle = MUSCLE_COLORS[muscle] || "#999";
        if (groupIndex === topGroup && typeof ctx.roundRect === "function") {
          const radius = Math.min(5, barWidth / 2, height / 2);
          ctx.beginPath(); ctx.roundRect(x, currentY - height, barWidth, height, [radius, radius, 0, 0]); ctx.fill();
        } else { ctx.fillRect(x, currentY - height, barWidth, height); }
        currentY -= height;
      });
    });
    ctx.textAlign = "center"; ctx.fillStyle = textColor;
    const step = labels.length > 15 ? Math.ceil(labels.length / 8) : 1;
    const xLabels = labels.flatMap((label, i) => i % step === 0 || i === labels.length - 1 ? [{
      x: padding.left + gap + barWidth / 2 + i * chartW / labels.length, label,
      width: ctx.measureText?.(label)?.width ?? label.length * 6
    }] : []);
    LiftLogChartMotion.spacedAxisLabels(xLabels).forEach(item => ctx.fillText(item.label, item.x, h - padding.bottom + 15));
  }, { cascade: entrance, reset: entrance, duration: 380, stagger: 24 });
}

// Breakdown chart controls
$("#breakdownPeriod").addEventListener("change", () => {
  _breakdownOffset = 0; // Reset to current period when changing type
  const period = $("#breakdownPeriod").value;
  const granularitySelect = $("#breakdownGranularity");

  // Show granularity selector for month and year views
  if (period === "month") {
    granularitySelect.classList.remove("hidden");
    // Set options for month: daily/weekly
    granularitySelect.innerHTML = `
      <option value="daily">Daily</option>
      <option value="weekly">Weekly</option>
    `;
  } else if (period === "year") {
    granularitySelect.classList.remove("hidden");
    // Set options for year: weekly/monthly
    granularitySelect.innerHTML = `
      <option value="weekly">Weekly</option>
      <option value="monthly">Monthly</option>
    `;
  } else {
    granularitySelect.classList.add("hidden");
  }
  renderBreakdownChart();
});
$("#breakdownGranularity").addEventListener("change", renderBreakdownChart);
$("#breakdownMode").addEventListener("change", renderBreakdownChart);

// Period navigation
$("#btnPrevBreakdown").addEventListener("click", () => {
  _breakdownOffset--;
  renderBreakdownChart();
});
$("#btnNextBreakdown").addEventListener("click", () => {
  _breakdownOffset++;
  renderBreakdownChart();
});

// Startup waits for a validated, durable store before enabling editing.
async function initializeApp() {
  // Editor choices are static and must also exist after recovering a corrupt store.
  populateSelects();
  try {
    applySnapshot(await STORE.open(DEFAULT_DB));
    loadSettings(); migrateExerciseCategories();
    let initialTab = "dashboard";
    try {
      const returnTab = sessionStorage.getItem("liftlog_update_tab");
      sessionStorage.removeItem("liftlog_update_tab");
      if (["dashboard", "workout", "exercises", "history", "stats", "settings"].includes(returnTab)) initialTab = returnTab;
    } catch (_) {}
    $(`.tab[data-tab='${initialTab}']`).click();
    updateOfflineStatus();
  } catch (error) { storageFailure(error); }
  LiftLogUpdates.configure({
    canReload: canUpdate,
    prepareForUpdate: async () => {
      if (!canUpdate()) return false;
      clearActiveDrag();
      UPDATE_LOCK = true; updateSaveStatus();
      try { sessionStorage.setItem("liftlog_update_tab", $(".tab.active").dataset.tab); } catch (_) {}
      return canUpdate();
    },
    cancelUpdate: () => {
      UPDATE_LOCK = false; updateSaveStatus();
      try { sessionStorage.removeItem("liftlog_update_tab"); } catch (_) {}
    },
    onStatus: receiveOfflineStatus
  });
}
// Offline app installation is independent of workout saves.
let OFFLINE_SETUP = {state: "checking", stage: "checking", offlineReady: false};
let OFFLINE_STARTED_AT = 0, OFFLINE_CLOCK = null;
function receiveOfflineStatus(status) {
  if (status.state === "checking" && OFFLINE_SETUP.state !== "checking") OFFLINE_STARTED_AT = Date.now();
  if (!OFFLINE_STARTED_AT) OFFLINE_STARTED_AT = Date.now();
  OFFLINE_SETUP = {...status};
  const notice = $("#updateStatus");
  const failed = ["failed", "error", "unavailable"].includes(status.state) && !status.offlineReady;
  const visible = ["waiting", "updating"].includes(status.state) || failed;
  notice.textContent = failed ? "Offline setup needs attention. Open Settings to retry." : visible ? status.detail : "";
  notice.hidden = !visible;
  updateReliabilityStrip();
  const busy = ["checking", "downloading", "caching", "verifying", "activating"].includes(status.stage) && !["failed", "deferred", "offline", "unavailable", "waiting", "current"].includes(status.state);
  if (busy && !OFFLINE_CLOCK) OFFLINE_CLOCK = setInterval(updateOfflineStatus, 1000);
  if (!busy && OFFLINE_CLOCK) { clearInterval(OFFLINE_CLOCK); OFFLINE_CLOCK = null; }
  updateOfflineStatus();
}
function updateOfflineStatus() {
  const status = OFFLINE_SETUP;
  const offline = !navigator.onLine;
  const ready = status.offlineReady === true;
  const failed = ["failed", "error", "deferred", "offline", "unavailable"].includes(status.state);
  const waiting = status.state === "waiting";
  const busy = !failed && !waiting && status.state !== "current";
  const title = $("#offlineStatus"), detail = $("#offlineProgressDetail"), progress = $("#offlineProgress"), retry = $("#btnRetryOffline");
  $("#offlineHelp").hidden = ready;
  if (ready && offline) title.textContent = "Offline app ready. You can log without an internet connection.";
  else if (ready && failed) title.textContent = "Offline app ready. The latest update could not be downloaded.";
  else if (waiting) title.textContent = ready ? "Offline app ready. An update will open after your workout and edits are finished." : "Download complete. Finish your current workout and any open edits, then close other LiftLog windows to complete setup.";
  else if (offline) title.textContent = "Offline access is not ready. Reconnect to finish the download.";
  else if (failed) {
    const reasons = {storage: "There was not enough available browser storage, or the browser could not save the app.", timeout: "The download took too long.", network: "The download was interrupted.", http: "The app server could not provide an app file.", mime: "An app file could not be verified.", hash: "The app changed during download.", registration: "The browser could not start offline setup.", control: "The downloaded app could not take over this window.", unsupported: "This browser cannot install offline access here."};
    title.textContent = "Offline access is not ready. " + (reasons[status.errorCode] || "The app download did not finish.");
  } else if (ready && status.state === "current") title.textContent = "Offline app ready.";
  else {
    const stages = {checking: "Checking the app files…", downloading: "Downloading the app…", caching: "Saving the app for offline use…", verifying: "Verifying the offline app…", activating: "Finishing offline setup…", ready: "Offline app ready."};
    title.textContent = stages[status.stage] || "Preparing offline access…";
  }
  progress.hidden = !busy || offline;
  const count = Number.isFinite(status.completed) && Number.isFinite(status.total) && status.total > 0;
  if (count) { progress.max = status.total; progress.value = Math.min(status.completed, status.total); }
  else progress.removeAttribute("value");
  const parts = [];
  if (busy && !offline) {
    if (count) parts.push(`${status.completed} of ${status.total} files in this step`);
    if (Number.isFinite(status.bytes) && status.bytes > 0) parts.push(`${Math.round(status.bytes / 1024)} KB received`);
    if (OFFLINE_STARTED_AT) parts.push(`${Math.max(0, Math.floor((Date.now() - OFFLINE_STARTED_AT) / 1000))} seconds elapsed`);
  } else if (failed && !offline) parts.push("Offline setup does not change your workout entries. Retry while online.");
  detail.textContent = parts.join(" · "); detail.hidden = !detail.textContent;
  retry.hidden = !failed && !(!ready && !busy && !waiting);
  retry.disabled = offline || status.retryable === false;
}
$("#btnRetryOffline").addEventListener("click", () => { void LiftLogUpdates.check(); });
STORE.subscribe(() => {
  EXTERNAL_CHANGE = true;
  refreshSavedData();
});
$("#btnExportRecovery").addEventListener("click", async () => {
  try {
    const recovery = await STORE.exportRecovery();
    recovery.unsaved = {version: 1, data: DB, draft: ACTIVE_SESSION};
    downloadJSON(recovery, `liftlog_recovery_${Date.now()}.json`);
    showNotice("Recovery exported with saved copies and the edits still in this window.");
  } catch (error) { showNotice(`Recovery export failed: ${error.message}`, "error"); }
});
// Also expose recovery when there is no storage error, for restore/reset rollback.
const recoveryButton = document.createElement("button");
recoveryButton.className = "btn-white full mt-2"; recoveryButton.textContent = "EXPORT RECOVERY";
recoveryButton.addEventListener("click", () => $("#btnExportRecovery").click());
$("#dataContent").appendChild(recoveryButton);
// Restore/reset rollback is available without downloading or editing recovery JSON.
const previousSaveButton = document.createElement("button");
previousSaveButton.id = "btnRestorePreviousSave";
previousSaveButton.className = "btn-white full mt-2";
previousSaveButton.textContent = "RESTORE PREVIOUS SAVE";
let RESTORING_PREVIOUS_SAVE = false;
previousSaveButton.addEventListener("click", async () => {
  if (RESTORING_PREVIOUS_SAVE || COMMITTING) return;
  RESTORING_PREVIOUS_SAVE = true; previousSaveButton.disabled = true;
  let committed = false, ownsCommitLock = false;
  try {
    if (!await flushSaves()) return;
    const revision = STORAGE_REVISION;
    const recovery = await STORE.exportRecovery();
    const records = (recovery.recovery || []).slice().reverse();
    const previous = records.find(item => item.kind === "before-restore" && item.state);
    const migration = records.find(item => item.kind === "legacy-migration" && item.raw);
    const originalRaw = migration ? migration.raw : recovery.legacyRaw;
    if (!previous && !originalRaw) {
      showNotice("No previous save is available yet. LiftLog keeps a recovery copy before you restore a backup or reset your data.");
      return;
    }
    const backup = previous ? { version: 1, data: previous.state.db, draft: previous.state.draft || null } : JSON.parse(originalRaw);
    const validated = STORE.parseBackupEnvelope(backup);
    const savedAt = previous && Number.isFinite(Date.parse(previous.at)) ? new Date(previous.at).toLocaleString("en-GB") : null;
    const source = previous ? `the copy kept before your restore or reset${savedAt ? ` on ${savedAt}` : ""}` : "your original data from before the storage upgrade";
    if (!await askConfirm("Restore previous save?", `Replace current data with ${source}: ${validated.db.sessions.length} workouts, ${Object.keys(validated.db.exercises).length} exercises and ${Object.keys(validated.db.templates).length} routines${validated.draft ? ", plus an unfinished workout" : ""}? Your current saved data will be kept as another recovery copy, so you can reverse this action.`)) return;
    COMMITTING = true; ownsCommitLock = true; updateSaveStatus();
    const result = await STORE.restore(backup, revision);
    committed = true;
    applySnapshot(result); stopTimer(); loadSettings();
    $(".tab[data-tab='dashboard']").click();
    showNotice(validated.draft ? "Previous save restored, including your unfinished workout. Your newer data is kept in recovery." : "Previous save restored. Your newer data is kept in recovery; Restore previous save can bring it back.");
  } catch (error) {
    showNotice(committed ? `Your previous save was restored, but the screen could not refresh. Reload LiftLog. ${error.message}` : `Previous save was not restored: ${error.message} Your saved data has not been replaced.`, "error");
  } finally {
    if (ownsCommitLock) COMMITTING = false;
    RESTORING_PREVIOUS_SAVE = false; previousSaveButton.disabled = false; updateSaveStatus();
    LiftLogUpdates.notifySafe();
  }
});
$("#dataContent").appendChild(previousSaveButton);
// End restore/reset rollback controls.
const dataActions = document.createElement('div');
dataActions.id = 'dataActions';
while ($("#dataContent").firstChild) dataActions.appendChild($("#dataContent").firstChild);
$("#dataContent").appendChild(dataActions);
$("#btnRetrySave").addEventListener("click", async () => {
  if (!STORE_READY) { await initializeApp(); return; }
  await SAVE_QUEUE;
  STORAGE_ERROR = null; QUEUED_DB = copyState(BASE_DB); QUEUED_DRAFT = copyState(BASE_DRAFT);
  updateSaveStatus();
  if (await flushSaves()) showNotice("Your changes are saved.");
});
$("#btnReloadSaved").addEventListener("click", async () => {
  if (!await askConfirm("Load saved data?", "This replaces the edits in this window with the last successful save. Export recovery first if you want to keep unsaved edits.")) return;
  if (!STORE_READY) { await initializeApp(); return; }
  await SAVE_QUEUE;
  await refreshSavedData(true);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { saveDB(); saveDraft(); }
  else { if (EXTERNAL_CHANGE) refreshSavedData(); updateOfflineStatus(); }
});
window.addEventListener("pagehide", () => { saveDB(); saveDraft(); });
window.addEventListener("beforeunload", event => {
  if (PENDING_SAVES || STORAGE_ERROR) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("online", updateOfflineStatus);
window.addEventListener("offline", updateOfflineStatus);
// Modal close and blur can make a pending update safe. Delay until current handlers finish.
document.addEventListener("click", () => setTimeout(() => LiftLogUpdates.notifySafe(), 0));
document.addEventListener("focusout", () => setTimeout(() => LiftLogUpdates.notifySafe(), 0));
function updateRecapLinks() {
  const months = LiftLogRecaps.availableMonths(DB);
  $("#btnLatestRecap").disabled = !months.length;
  $("#recapMonthLabel").textContent = months.length ? LiftLogRecaps.displayMonth(months[0])
    : 'Your first review will appear after a month with completed workouts ends.';
  $("#btnRecapArchive").hidden = !months.length;
}

async function editCompletedWorkout(id) {
  if (!STORE_READY || STORAGE_ERROR || COMMITTING || UPDATE_LOCK) return;
  const session = DB.sessions.find(item => item.id === id);
  if (!session) return;
  LiftLogHistoryEditor.open(session, {
    getExercises: () => DB.exercises, unit: getWeightUnit(), confirm: askConfirm,
    openExercisePicker, scrollLock: LOGGER_SCROLL_LOCK,
    saveSession: async (next, baseline) => {
      if (COMMITTING || UPDATE_LOCK || STORAGE_ERROR || !STORE_READY) return {ok: false, error: 'Your changes could not be saved. Try again.'};
      COMMITTING = true; updateSaveStatus();
      let committed = false;
      try {
        if (!await flushSaves()) return {ok: false, error: 'Your changes could not be saved. Try again.'};
        const result = await STORE.editSession(next, baseline, {epoch: STORAGE_EPOCH});
        committed = true;
        applySnapshot(result);
        renderHistory(); renderDashboard(); updateRecapLinks();
        return {ok: true};
      } catch (error) {
        if (committed) {
          showNotice('Your workout was saved. Reload LiftLog to refresh the screen.', 'error');
          return {ok: true};
        }
        return {ok: false, error: error.message};
      }
      finally { COMMITTING = false; updateSaveStatus(); LiftLogUpdates.notifySafe(); }
    },
    onClose: () => LiftLogUpdates.notifySafe()
  });
}

LiftLogRecaps.configure({
  getDB: () => DB, getUnit: getWeightUnit, formatWeight: value => String(convertWeight(value)),
  muscleColors: MUSCLE_COLORS, assetBase: './assets/recap/', scrollLock: LOGGER_SCROLL_LOCK,
  onOpenChange: () => LiftLogUpdates.notifySafe()
});
$("#btnLatestRecap").addEventListener('click', () => LiftLogRecaps.open());
$("#btnRecapArchive").addEventListener('click', () => LiftLogRecaps.openArchive());
initializeApp();
