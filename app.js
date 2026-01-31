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
    includeCompound: true, // include secondary muscles in charts
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

let DB = loadDB();
let ACTIVE_SESSION = null; 
let WORKOUT_TIMER = null;

function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function loadDB() {
  const str = localStorage.getItem(DB_KEY);
  if (!str) return JSON.parse(JSON.stringify(DEFAULT_DB));

  const data = JSON.parse(str);
  // Simple migration checks
  if (!data.bodyweight) data.bodyweight = [];
  if (!data.templates) data.templates = {};
  if (!data.user) data.user = { theme: "light" };

  // Migrate user settings
  if (data.user.useLbs === undefined) data.user.useLbs = data.user.unit === "lbs" || false;
  if (data.user.showSuggestions === undefined) data.user.showSuggestions = true;
  if (data.user.includeCompound === undefined) data.user.includeCompound = true;
  if (data.user.trainingGoal === undefined) data.user.trainingGoal = "hypertrophy";
  if (data.user.bodyweight === undefined) data.user.bodyweight = null;
  delete data.user.unit; // Remove old unit setting

  // Apply theme immediately
  document.body.className = `theme-${data.user.theme}`;
  return data;
}

function saveDB() {
  localStorage.setItem(DB_KEY, JSON.stringify(DB));
}

// --- DOM HELPERS ---
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// --- TABS & NAVIGATION ---
$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach(b => b.classList.remove("active"));
    $$(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    renderCurrentTab(btn.dataset.tab);
  });
});

function renderCurrentTab(tab) {
  if (tab === "dashboard") renderDashboard();
  if (tab === "workout") renderWorkoutTab();
  if (tab === "exercises") renderExerciseLibrary();
  if (tab === "history") renderHistory();
  if (tab === "stats") renderStats();
  if (tab === "settings") renderSettings();
}

// --- DASHBOARD ---
function renderDashboard() {
  populateDashboardTemplates();
  renderRecentLogs();
  renderCalendar();
}

function renderRecentLogs() {
  const container = $("#recentLogs");
  container.innerHTML = "";

  const recentSessions = DB.sessions.slice(0, 3);

  if (recentSessions.length === 0) {
    container.innerHTML = '<p class="muted">No workouts yet. Start your first one!</p>';
    return;
  }

  recentSessions.forEach(sess => {
    const div = document.createElement("div");
    div.className = "recent-log-item";

    const date = new Date(sess.start);
    const dateStr = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const exerciseCount = (sess.order || []).length;
    const exerciseWord = exerciseCount === 1 ? 'exercise' : 'exercises';

    // Get muscle groups worked
    const muscles = new Set();
    (sess.order || []).forEach(exId => {
      const ex = DB.exercises[exId];
      if (ex && ex.muscle) muscles.add(ex.muscle);
    });

    const templateBadge = sess.templateName
      ? `<span class="template-badge">${sess.templateName}</span>`
      : '<span class="template-badge freestyle">Freestyle</span>';

    div.innerHTML = `
      <div class="recent-log-date">${dateStr}</div>
      <div class="recent-log-info">${exerciseCount} ${exerciseWord}</div>
      <div class="recent-log-meta">${templateBadge}</div>
      <div class="recent-log-muscles">${[...muscles].slice(0, 3).join(', ') || 'No data'}</div>
    `;
    container.appendChild(div);
  });
}

// Quick Start button - starts workout with optional template
$("#btnQuickStart").addEventListener("click", () => {
  const templateId = $("#dashboardTemplateSelect").value;
  if (templateId) {
    startWorkout(DB.templates[templateId]);
  } else {
    startWorkout();
  }
  $(".tab[data-tab='workout']").click();
});

function populateDashboardTemplates() {
  const sel = $("#dashboardTemplateSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">Freestyle</option>';
  Object.values(DB.templates).forEach(t => {
    sel.innerHTML += `<option value="${t.id}">${t.name}</option>`;
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

function deleteBodyweightEntry(index) {
  if (!confirm("Delete this bodyweight entry?")) return;
  DB.bodyweight.splice(index, 1);
  saveDB();
  drawBodyweightChart();
  renderBodyweightEntries();
}

function drawBodyweightChart() {
  const canvas = $("#bwChart");
  const data = DB.bodyweight.slice(-14); // Last 14 entries

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
  const textColor = isDark ? "#fff" : "#000";

  if (data.length < 2) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = "14px -apple-system, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.fillText("Log more data to see chart", w / 2, h / 2);
    return;
  }

  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  // Convert values to display unit
  const values = data.map(d => convertWeight(d.kg));
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  // Round to nice intervals (5 for kg, 10 for lbs)
  const stepSize = DB.user.useLbs ? 10 : 5;
  const minVal = Math.floor(dataMin / stepSize) * stepSize - stepSize;
  const maxVal = Math.ceil(dataMax / stepSize) * stepSize + stepSize;
  const range = maxVal - minVal;
  const numSteps = Math.ceil(range / stepSize);

  ctx.clearRect(0, 0, w, h);

  // Draw Y axis labels (weight) - nice round numbers
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillStyle = textColor;
  ctx.textAlign = "right";
  for (let i = 0; i <= numSteps; i++) {
    const val = minVal + (i * stepSize);
    if (val > maxVal) break;
    const y = padding.top + chartH - ((val - minVal) / range) * chartH;
    ctx.fillText(val.toFixed(0), padding.left - 8, y + 4);
    // Grid line
    ctx.strokeStyle = isDark ? "#333" : "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }

  // Draw X axis labels (dates)
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(data.length / 5));
  data.forEach((d, i) => {
    if (i % step === 0 || i === data.length - 1) {
      const x = padding.left + (i / (data.length - 1)) * chartW;
      const date = new Date(d.date);
      const label = `${date.getDate()}/${date.getMonth() + 1}`;
      ctx.fillText(label, x, h - padding.bottom + 20);
    }
  });

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = "#FF3333";
  ctx.lineWidth = 3;
  values.forEach((val, i) => {
    const x = padding.left + (i / (values.length - 1)) * chartW;
    const y = padding.top + chartH - ((val - minVal) / range) * chartH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw dots
  ctx.fillStyle = "#FF3333";
  values.forEach((val, i) => {
    const x = padding.left + (i / (values.length - 1)) * chartW;
    const y = padding.top + chartH - ((val - minVal) / range) * chartH;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
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
  const todayStr = today.toISOString().split("T")[0];

  // Empty cells for days before month starts
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-day empty";
    grid.appendChild(empty);
  }

  // Days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const iso = date.toISOString().split("T")[0];

    const div = document.createElement("div");
    div.className = "cal-day";

    // Check if today
    if (iso === todayStr) div.classList.add("today");

    // Find workouts on this day
    const dayWorkouts = DB.sessions.filter(s => s.start.startsWith(iso));

    if (dayWorkouts.length > 0) {
      div.classList.add("has-workout");

      // Get unique muscle groups worked (including cardio)
      const muscles = new Set();
      dayWorkouts.forEach(sess => {
        (sess.order || []).forEach(exId => {
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
      div.onclick = () => showDayDetails(iso, dayWorkouts);
    } else {
      div.innerHTML = `<span class="cal-day-num">${day}</span>`;
    }

    grid.appendChild(div);
  }
}

function showDayDetails(iso, workouts) {
  const date = new Date(iso);
  const dateStr = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $("#dayModalTitle").textContent = dateStr;

  let html = "";
  workouts.forEach(sess => {
    // Show workout notes if any
    if (sess.notes) {
      html += `<div class="history-notes" style="margin-bottom:10px;"><em>${sess.notes}</em></div>`;
    }

    (sess.order || []).forEach(exId => {
      const ex = DB.exercises[exId];
      const sets = sess.entries[exId];
      if (!ex || !sets || sets.length === 0) return;

      // Get muscle group and color
      const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
      const color = MUSCLE_COLORS[category] || '#999';

      const unit = getWeightUnit();
      const setsHtml = sets.map(s => {
        if (s.w) {
          const displayW = convertWeight(parseFloat(s.w));
          return `<span class="set-tag">${displayW}${unit} × ${s.r}</span>`;
        }
        if (s.time) return `<span class="set-tag">${s.time}m / ${s.dist}${ex.cardioMetric || 'km'}</span>`;
        return "";
      }).join("");

      html += `<div class="day-exercise"><strong>${ex.name}</strong> <span class="muscle-tag" style="background:${color}">${category}</span><div style="margin-top:8px">${setsHtml}</div></div>`;
    });
  });

  if (!html) html = '<p class="muted">No exercises recorded</p>';
  $("#dayModalContent").innerHTML = html;
  $("#dayModal").classList.remove("hidden");
  document.body.style.overflow = "hidden"; // Prevent background scroll
}

$("#btnCloseDayModal").addEventListener("click", () => {
  $("#dayModal").classList.add("hidden");
  document.body.style.overflow = ""; // Restore scroll
});

// Close day modal when clicking outside the box
$("#dayModal").addEventListener("click", (e) => {
  if (e.target === $("#dayModal")) {
    $("#dayModal").classList.add("hidden");
    document.body.style.overflow = ""; // Restore scroll
  }
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

  const container = $("#exerciseList");
  container.innerHTML = "";

  const search = $("#searchEx").value.toLowerCase();

  const allExercises = Object.values(DB.exercises);

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
    div.className = `ex-item-card ex-cat-${category}`;

    // Get last session data for this exercise
    const lastSession = findLastSessionWithExercise(ex.id);
    let historyHtml = '<div class="ex-history muted small">No history yet</div>';

    if (lastSession) {
      const date = new Date(lastSession.date);
      const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const unit = getWeightUnit();
      const sets = lastSession.sets.map(s => {
        if (s.w) {
          const displayW = convertWeight(parseFloat(s.w));
          return `${displayW}${unit} × ${s.r}`;
        }
        if (s.time) return `${s.time}m / ${s.dist}${ex.cardioMetric || 'km'}`;
        return '';
      }).filter(Boolean).join(', ');

      historyHtml = `<div class="ex-history"><span class="muted small">${dateStr}:</span> <span class="small">${sets}</span></div>`;
    }

    // Label shows "Cardio" for cardio type, muscle name for strength
    const labelText = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');

    div.innerHTML = `
      <div class="ex-item-header">
        <span class="ex-name">${ex.name} <span class="muscle-tag">${labelText}</span></span>
        <button class="btn-ghost icon-btn" onclick="editExercise('${ex.id}')">✎</button>
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
  container.innerHTML = "";

  // All tab
  const allTab = document.createElement("button");
  allTab.className = `picker-tab ${_libraryFilter === "All" ? "active" : ""}`;
  allTab.textContent = "All";
  allTab.onclick = () => { _libraryFilter = "All"; renderLibraryTabs(); renderExerciseLibrary(); };
  container.appendChild(allTab);

  // Muscle group tabs
  MUSCLE_GROUPS.forEach(muscle => {
    const tab = document.createElement("button");
    tab.className = `picker-tab ${_libraryFilter === muscle ? "active" : ""}`;
    tab.textContent = muscle;
    const color = MUSCLE_COLORS[muscle] || "#ccc";
    tab.style.borderColor = color;
    if (_libraryFilter === muscle) {
      tab.style.background = color;
      tab.style.color = "#000"; // Always black text when active
    }
    tab.onclick = () => { _libraryFilter = muscle; renderLibraryTabs(); renderExerciseLibrary(); };
    container.appendChild(tab);
  });

  // Cardio tab
  const cardioTab = document.createElement("button");
  cardioTab.className = `picker-tab ${_libraryFilter === "Cardio" ? "active" : ""}`;
  cardioTab.textContent = "Cardio";
  const cardioColor = MUSCLE_COLORS.Cardio;
  cardioTab.style.borderColor = cardioColor;
  if (_libraryFilter === "Cardio") {
    cardioTab.style.background = cardioColor;
    cardioTab.style.color = "#000";
  }
  cardioTab.onclick = () => { _libraryFilter = "Cardio"; renderLibraryTabs(); renderExerciseLibrary(); };
  container.appendChild(cardioTab);
}

// Library search listener
$("#searchEx").addEventListener("input", renderExerciseLibrary);

function openNewExerciseModal() {
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
  $("#newExAssisted").checked = false;
  $("#newExCompound").checked = false;
  _selectedSecondaryMuscles = [];
  $("#strengthOptions").classList.remove("hidden");
  $("#cardioOptions").classList.add("hidden");
  $("#muscleSelectWrapper").classList.remove("hidden");
  $("#secondaryMusclesWrapper").classList.add("hidden");
  $("#btnDeleteEx").classList.add("hidden"); // Hide delete for new exercise
  $("#addExModal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

$("#btnShowAddEx").addEventListener("click", openNewExerciseModal);

$("#btnCloseExModal").addEventListener("click", () => {
  EDITING_EXERCISE_ID = null;
  $("#addExModal").classList.add("hidden");
  document.body.style.overflow = "";
});

// Close exercise modal when clicking outside
$("#addExModal").addEventListener("click", (e) => {
  if (e.target === $("#addExModal")) {
    EDITING_EXERCISE_ID = null;
    $("#addExModal").classList.add("hidden");
    document.body.style.overflow = "";
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

$("#btnSaveEx").addEventListener("click", () => {
  const name = $("#newExName").value.trim();
  if (!name) return;

  const type = $("#newExType").value;
  const isCompound = type === 'strength' ? $("#newExCompound").checked : false;

  const exerciseData = {
    name,
    type,
    muscle: type === 'cardio' ? null : $("#newExMuscle").value,
    equip: type === 'cardio' ? null : $("#newExEquip").value,
    increment: type === 'cardio' ? null : (parseFloat($("#newExInc").value) || 2.5),
    cardioMetric: type === 'cardio' ? ($("#newExCardioMetric").value.trim() || 'km') : null,
    cardioGoal: type === 'cardio' ? $("#newExCardioGoal").value : null,
    isAssisted: type === 'strength' ? $("#newExAssisted").checked : false,
    isCompound: isCompound,
    secondaryMuscles: isCompound ? _selectedSecondaryMuscles.slice() : []
  };

  if (EDITING_EXERCISE_ID) {
    // Update existing exercise
    DB.exercises[EDITING_EXERCISE_ID] = { ...DB.exercises[EDITING_EXERCISE_ID], ...exerciseData };
  } else {
    // Create new exercise
    const id = uid();
    DB.exercises[id] = { id, ...exerciseData };
  }

  EDITING_EXERCISE_ID = null;
  _selectedSecondaryMuscles = []; // Reset
  saveDB();
  $("#addExModal").classList.add("hidden");
  document.body.style.overflow = "";
  renderExerciseLibrary();
});

function editExercise(id) {
  const ex = DB.exercises[id];
  if (!ex) return;

  EDITING_EXERCISE_ID = id;
  $("#exModalTitle").textContent = "EDIT EXERCISE";

  // Pre-populate form with existing data
  $("#newExName").value = ex.name;
  $("#newExType").value = ex.type || 'strength';
  $("#newExMuscle").value = ex.muscle || '';
  $("#newExEquip").value = ex.equip || 'barbell';
  $("#newExInc").value = ex.increment || 2.5;
  $("#newExCardioMetric").value = ex.cardioMetric || '';
  $("#newExCardioGoal").value = ex.cardioGoal || 'endurance';
  $("#newExAssisted").checked = ex.isAssisted || false;
  $("#newExCompound").checked = ex.isCompound || false;

  // Load secondary muscles
  _selectedSecondaryMuscles = ex.secondaryMuscles ? ex.secondaryMuscles.slice() : [];

  // Show/hide options based on type
  if (ex.type === 'cardio') {
    $("#strengthOptions").classList.add("hidden");
    $("#cardioOptions").classList.remove("hidden");
    $("#muscleSelectWrapper").classList.add("hidden");
  } else {
    $("#strengthOptions").classList.remove("hidden");
    $("#cardioOptions").classList.add("hidden");
    $("#muscleSelectWrapper").classList.remove("hidden");

    // Show/hide secondary muscles
    if (ex.isCompound) {
      $("#secondaryMusclesWrapper").classList.remove("hidden");
      renderSecondaryMusclesList();
    } else {
      $("#secondaryMusclesWrapper").classList.add("hidden");
    }
  }

  $("#btnDeleteEx").classList.remove("hidden"); // Show delete for existing exercise
  $("#addExModal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

$("#btnDeleteEx").addEventListener("click", () => {
  if (!EDITING_EXERCISE_ID) return;
  if (!confirm("Delete this exercise? This cannot be undone.")) return;

  delete DB.exercises[EDITING_EXERCISE_ID];
  EDITING_EXERCISE_ID = null;
  saveDB();
  $("#addExModal").classList.add("hidden");
  document.body.style.overflow = "";
  renderExerciseLibrary();
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
  if (WORKOUT_TIMER) return;
  const start = new Date(ACTIVE_SESSION.start).getTime();
  WORKOUT_TIMER = setInterval(() => {
    const diff = Math.floor((Date.now() - start) / 1000);
    const m = Math.floor(diff / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    $("#workoutTimer").textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  if (WORKOUT_TIMER) clearInterval(WORKOUT_TIMER);
  WORKOUT_TIMER = null;
}

// Starting
$("#btnStartEmpty").addEventListener("click", () => startWorkout());
$("#btnStartTemplate").addEventListener("click", () => {
  const tId = $("#templateSelect").value;
  if (!tId) return alert("Select a routine");
  startWorkout(DB.templates[tId]);
});

function startWorkout(template = null) {
  if (ACTIVE_SESSION && !confirm("Overwrite current workout?")) return;

  // Reset timer display immediately to prevent flash of old time
  $("#workoutTimer").textContent = "00:00";

  ACTIVE_SESSION = {
    id: uid(),
    start: new Date().toISOString(),
    entries: {}, // exId -> []
    order: [], // list of exIds to maintain order
    templateName: template ? template.name : null,
    templateId: template ? template.id : null
  };

  if (template) {
    template.exercises.forEach(item => {
      ACTIVE_SESSION.order.push(item.exId);
    });
  }

  saveDB();
  renderWorkoutTab();
}

// Touch drag state
let _touchDragIdx = null;
let _touchDragElement = null;
let _touchDragClone = null;
let _touchOffsetX = 0;
let _touchOffsetY = 0;

function renderActiveSession() {
  const list = $("#activeExerciseList");
  list.innerHTML = "";

  // Load workout notes
  loadWorkoutNotes();

  ACTIVE_SESSION.order.forEach((exId, idx) => {
    const ex = DB.exercises[exId];
    if (!ex) return;
    const sets = ACTIVE_SESSION.entries[exId] || [];
    const isDone = sets.length > 0;
    const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');

    const div = document.createElement("div");
    div.className = "neo-card bg-white mb-2 p-2 draggable-exercise";
    div.draggable = true;
    div.dataset.idx = idx;
    div.innerHTML = `
      <div class="row">
        <div class="drag-handle">☰</div>
        <strong class="flex-1">${ex.name} <span class="muscle-tag" style="background:${MUSCLE_COLORS[category]}">${category}</span></strong>
        <button class="btn-ghost" onclick="openLogger('${exId}')">${isDone ? 'EDIT' : 'LOG'}</button>
      </div>
      <div class="muted small">${sets.length} sets logged</div>
    `;

    const handle = div.querySelector(".drag-handle");

    // Desktop drag events
    div.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", idx);
      div.classList.add("dragging");
    });

    div.addEventListener("dragend", () => {
      div.classList.remove("dragging");
      document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });

    div.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      div.classList.add("drag-over");
    });

    div.addEventListener("dragleave", () => {
      div.classList.remove("drag-over");
    });

    div.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
      const toIdx = parseInt(div.dataset.idx);
      if (fromIdx !== toIdx) {
        const [moved] = ACTIVE_SESSION.order.splice(fromIdx, 1);
        ACTIVE_SESSION.order.splice(toIdx, 0, moved);
        renderActiveSession();
      }
      div.classList.remove("drag-over");
    });

    // Touch drag events (for mobile)
    handle.addEventListener("touchstart", (e) => {
      e.preventDefault();
      _touchDragIdx = idx;
      _touchDragElement = div;
      div.classList.add("dragging");

      // Calculate offset from touch point to element's top-left
      const rect = div.getBoundingClientRect();
      const touch = e.touches[0];
      _touchOffsetX = touch.clientX - rect.left;
      _touchOffsetY = touch.clientY - rect.top;

      // Create a visual clone that follows the finger
      _touchDragClone = div.cloneNode(true);
      _touchDragClone.classList.add("touch-drag-clone");
      _touchDragClone.style.position = "fixed";
      _touchDragClone.style.width = div.offsetWidth + "px";
      _touchDragClone.style.zIndex = "1000";
      _touchDragClone.style.pointerEvents = "none";
      _touchDragClone.style.opacity = "0.8";
      document.body.appendChild(_touchDragClone);

      // Position clone at same visual position as original
      _touchDragClone.style.left = rect.left + "px";
      _touchDragClone.style.top = rect.top + "px";
    }, { passive: false });

    list.appendChild(div);
  });
}

// Global touch move and end handlers
document.addEventListener("touchmove", (e) => {
  if (_touchDragClone === null) return;

  const touch = e.touches[0];
  // Maintain the same offset from finger to element
  _touchDragClone.style.left = (touch.clientX - _touchOffsetX) + "px";
  _touchDragClone.style.top = (touch.clientY - _touchOffsetY) + "px";

  // Find element under touch point
  _touchDragClone.style.display = "none";
  const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);
  _touchDragClone.style.display = "";

  // Clear previous highlights
  document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));

  // Find the draggable parent
  if (elementBelow) {
    const dropTarget = elementBelow.closest(".draggable-exercise");
    if (dropTarget && dropTarget !== _touchDragElement) {
      dropTarget.classList.add("drag-over");
    }
  }
}, { passive: true });

document.addEventListener("touchend", (e) => {
  if (_touchDragClone === null) return;

  // Find where we dropped
  const touch = e.changedTouches[0];
  _touchDragClone.style.display = "none";
  const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);

  if (elementBelow) {
    const dropTarget = elementBelow.closest(".draggable-exercise");
    if (dropTarget && dropTarget !== _touchDragElement) {
      const toIdx = parseInt(dropTarget.dataset.idx);
      const fromIdx = _touchDragIdx;
      if (fromIdx !== toIdx) {
        const [moved] = ACTIVE_SESSION.order.splice(fromIdx, 1);
        ACTIVE_SESSION.order.splice(toIdx, 0, moved);
        renderActiveSession();
      }
    }
  }

  // Cleanup
  if (_touchDragElement) _touchDragElement.classList.remove("dragging");
  if (_touchDragClone) _touchDragClone.remove();
  document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));

  _touchDragIdx = null;
  _touchDragElement = null;
  _touchDragClone = null;
});

$("#btnAddExToWorkout").addEventListener("click", () => {
  openExercisePicker((exId) => {
    if (!ACTIVE_SESSION.order.includes(exId)) {
      ACTIVE_SESSION.order.push(exId);
      renderActiveSession();
    }
  });
});

$("#btnFinishWorkout").addEventListener("click", () => {
  // Check if any exercises were logged
  const hasEntries = Object.values(ACTIVE_SESSION.entries).some(sets => sets && sets.length > 0);

  if (!hasEntries) {
    if (confirm("No exercises logged. Discard this workout?")) {
      ACTIVE_SESSION = null;
      renderWorkoutTab();
    }
    return;
  }

  if (!confirm("Finish and save workout?")) return;
  ACTIVE_SESSION.end = new Date().toISOString();
  DB.sessions.unshift(ACTIVE_SESSION);
  ACTIVE_SESSION = null;
  saveDB();
  renderWorkoutTab();
  // Go to history
  $(".tab[data-tab='history']").click();
});

// --- LOGGING MODAL ---
let CURRENT_LOG_EX = null;

function openLogger(exId) {
  CURRENT_LOG_EX = exId;
  const ex = DB.exercises[exId];
  $("#logModalTitle").textContent = ex.name;

  // Headers based on type and unit setting
  const headers = $("#logHeaders");
  const weightLabel = getWeightLabel();
  if (ex.type === 'cardio') {
    headers.querySelector(".h-val-1").textContent = "MINS";
    headers.querySelector(".h-val-2").textContent = (ex.cardioMetric || 'KM').toUpperCase();
  } else if (ex.isAssisted) {
    headers.querySelector(".h-val-1").textContent = "ASSIST";
    headers.querySelector(".h-val-2").textContent = "REPS";
  } else {
    headers.querySelector(".h-val-1").textContent = weightLabel;
    headers.querySelector(".h-val-2").textContent = "REPS";
  }

  const container = $("#logRows");
  container.innerHTML = "";

  // Get existing logs OR Auto-fill from history
  const currentLogs = ACTIVE_SESSION.entries[exId] || [];

  if (currentLogs.length === 0) {
    // Attempt Auto-fill
    const lastSession = findLastSessionWithExercise(exId);
    if (lastSession && ex.type !== 'cardio') {
      // Calculate smart suggestion
      const bestSet = lastSession.sets.reduce((best, s) => {
        const w = parseFloat(s.w || 0);
        const r = parseInt(s.r || 0);
        if (w > best.w || (w === best.w && r > best.r)) return { w, r };
        return best;
      }, { w: 0, r: 0 });

      const increment = ex.increment || 2.5;
      const unit = getWeightUnit();
      // Convert weights to display units
      const displayBestW = convertWeight(bestSet.w);
      const displayLowerW = displayBestW;
      const displayHigherW = convertWeight(bestSet.w + increment);

      // Adjust rep targets based on training goal
      const goal = DB.user.trainingGoal || "hypertrophy";
      const targetReps = goal === "strength" ? { low: 3, mid: 5, high: 8 } : { low: 8, mid: 10, high: 12 };

      // Suggestion: same weight = more reps, more weight = same/fewer reps
      let suggestion = "";
      if (DB.user.showSuggestions !== false) {
        if (bestSet.r >= targetReps.high) {
          suggestion = `<strong>Try: ${displayHigherW}${unit} for ${targetReps.low}-${targetReps.mid} reps</strong> (time to increase!)`;
        } else if (bestSet.r >= targetReps.mid) {
          suggestion = `<strong>Try: ${displayLowerW}-${displayHigherW}${unit} for ${bestSet.r}-${bestSet.r + 2} reps</strong>`;
        } else {
          suggestion = `<strong>Try: ${displayLowerW}${unit} for ${bestSet.r + 1}-${bestSet.r + 3} reps</strong> (build reps first)`;
        }
      }

      const dateStr = new Date(lastSession.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      $("#prevSessionInfo").innerHTML = `
        <div class="muted small">Last: ${dateStr} — Best set: ${displayBestW}${unit} × ${bestSet.r}</div>
        ${DB.user.showSuggestions !== false ? `<div class="suggestion">${suggestion}</div>` : ''}
      `;

      // Add rows for each set done last time
      lastSession.sets.forEach(s => addLogRow(ex, s, true));
    } else if (lastSession) {
      // Cardio - just show last time
      $("#prevSessionInfo").innerHTML = `<span class="muted small">Last: ${new Date(lastSession.date).toLocaleDateString()} (${lastSession.sets.length} sets)</span>`;
      lastSession.sets.forEach(s => addLogRow(ex, s, true));
    } else {
      // Show assisted info if applicable
      const bw = getLatestBodyweight();
      if (ex.isAssisted && bw) {
        $("#prevSessionInfo").innerHTML = `<span class="muted small">Your bodyweight: ${bw}kg. Log assistance and we'll calculate effective weight.</span>`;
      } else {
        $("#prevSessionInfo").innerHTML = '<span class="muted small">No history - this is your first time!</span>';
      }
      addLogRow(ex);
    }
  } else {
    $("#prevSessionInfo").innerHTML = '<span class="muted small">Editing current session</span>';
    currentLogs.forEach(s => addLogRow(ex, s, false));
  }
  
  $("#logModal").classList.remove("hidden");
}

function addLogRow(ex, data = null, isGhost = false, prevWeight = null) {
  const row = document.createElement("div");
  row.className = "log-row";

  const val1 = data ? (ex.type==='cardio' ? data.time : data.w) : "";
  const val2 = data ? (ex.type==='cardio' ? data.dist : data.r) : "";

  // Suggestion logic (Weight Increment)
  let placeholder1 = "";
  let placeholder2 = "";

  if (isGhost && data) {
    // If auto-filling from history, apply suggestion logic
    if (ex.type !== 'cardio') {
       let w = parseFloat(data.w);
       let r = parseInt(data.r);
       if (r >= 12) w += (ex.increment || 2.5); // Logic: hit max reps, inc weight
       placeholder1 = w;
       placeholder2 = r; // Maintain rep target
    } else {
        placeholder1 = data.time;
        placeholder2 = data.dist;
    }
  } else if (prevWeight) {
    // Auto-fill weight from previous set in current session
    placeholder1 = prevWeight;
  }

  let valueStr1, valueStr2;
  let ghostClass = '';

  if (data && !isGhost) {
    // Editing existing data
    valueStr1 = `value="${val1}"`;
    valueStr2 = `value="${val2}"`;
  } else if (placeholder1 || placeholder2) {
    // Show as placeholder (ghost)
    valueStr1 = placeholder1 ? `placeholder="${placeholder1}"` : '';
    valueStr2 = placeholder2 ? `placeholder="${placeholder2}"` : '';
    ghostClass = 'ghost-val';
  } else {
    valueStr1 = '';
    valueStr2 = '';
  }

  row.innerHTML = `
    <div class="text-center font-bold index-num">#</div>
    <input class="neo-input input-val-1 ${ghostClass}" type="text" inputmode="decimal" ${valueStr1}>
    <input class="neo-input input-val-2 ${ghostClass}" type="text" inputmode="numeric" ${valueStr2}>
    <button class="btn-ghost text-red remove-row">✕</button>
  `;

  // Remove ghost class on input and filter non-numeric
  const val1Input = row.querySelector(".input-val-1");
  const val2Input = row.querySelector(".input-val-2");

  val1Input.addEventListener("input", (e) => {
    val1Input.classList.remove("ghost-val");
    // Allow only digits and one decimal point for weight
    let val = e.target.value;
    // Remove anything that's not a digit or decimal
    val = val.replace(/[^0-9.]/g, '');
    // Ensure only one decimal point
    const parts = val.split('.');
    if (parts.length > 2) {
      val = parts[0] + '.' + parts.slice(1).join('');
    }
    e.target.value = val;
  });

  val2Input.addEventListener("input", (e) => {
    val2Input.classList.remove("ghost-val");
    // Only digits for reps/distance
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
  });

  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();
    renumberRows(); // Renumber remaining rows after deletion
  });
  $("#logRows").appendChild(row);
  renumberRows();
}

function renumberRows() {
  $$("#logRows .index-num").forEach((el, i) => el.textContent = i + 1);
}

$("#btnAddRow").addEventListener("click", () => {
    // Get weight from previous row to auto-fill
    const rows = $$("#logRows .log-row");
    let prevWeight = null;
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const weightInput = lastRow.querySelector(".input-val-1");
      prevWeight = weightInput.value || weightInput.placeholder;
    }
    addLogRow(DB.exercises[CURRENT_LOG_EX], null, false, prevWeight);
});

$("#btnSaveLog").addEventListener("click", () => {
  const ex = DB.exercises[CURRENT_LOG_EX];
  const rows = $$(".log-row");
  const entries = [];
  
  rows.forEach(r => {
    const v1 = r.querySelector(".input-val-1").value || r.querySelector(".input-val-1").getAttribute("placeholder");
    const v2 = r.querySelector(".input-val-2").value || r.querySelector(".input-val-2").getAttribute("placeholder");
    
    if (v1 === "" && v2 === "") return;
    
    if (ex.type === 'cardio') {
      entries.push({ time: v1, dist: v2 });
    } else {
      entries.push({ w: v1, r: v2 });
    }
  });
  
  ACTIVE_SESSION.entries[CURRENT_LOG_EX] = entries;
  $("#logModal").classList.add("hidden");
  renderActiveSession();
});

$("#logModalClose").addEventListener("click", () => $("#logModal").classList.add("hidden"));

// Helper: Find last session
function findLastSessionWithExercise(exId) {
  for (const sess of DB.sessions) {
    if (sess.entries && sess.entries[exId] && sess.entries[exId].length > 0) {
      return { date: sess.start, sets: sess.entries[exId] };
    }
  }
  return null;
}

// --- TEMPLATES ---
$("#btnSaveTemplate").addEventListener("click", () => {
    const name = prompt("Name this routine:");
    if(!name) return;
    const tId = uid();
    const exercises = ACTIVE_SESSION.order.map(id => ({ exId: id }));
    DB.templates[tId] = { id: tId, name, exercises };
    saveDB();
    alert("Routine saved.");
});

function renderTemplates() {
    const sel = $("#templateSelect");
    const list = $("#templateList");
    sel.innerHTML = '<option value="">Select Template...</option>';
    list.innerHTML = "";

    Object.values(DB.templates).forEach(t => {
        sel.innerHTML += `<option value="${t.id}">${t.name}</option>`;

        const li = document.createElement("li");
        li.innerHTML = `
            <span>${t.name}</span>
            <div>
              <button class="btn-ghost small" onclick="editTemplate('${t.id}')">EDIT</button>
              <button class="btn-ghost small text-red" onclick="deleteTemplate('${t.id}')">DEL</button>
            </div>
        `;
        list.appendChild(li);
    });
}

function deleteTemplate(id) {
    if(!confirm("Delete routine?")) return;
    delete DB.templates[id];
    saveDB();
    renderTemplates();
}

// --- TEMPLATE BUILDER ---
let _templateBuilderExercises = [];
let _editingTemplateId = null;

$("#btnNewTemplate").addEventListener("click", () => {
  _templateBuilderExercises = [];
  _editingTemplateId = null;
  $("#templateBuilderName").value = "";
  $("#templateBuilderTitle").textContent = "CREATE ROUTINE";
  renderTemplateBuilderList();
  $("#templateBuilderModal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
});

function editTemplate(id) {
  const template = DB.templates[id];
  if (!template) return;

  _editingTemplateId = id;
  _templateBuilderExercises = template.exercises.map(e => e.exId);
  $("#templateBuilderName").value = template.name;
  $("#templateBuilderTitle").textContent = "EDIT ROUTINE";
  renderTemplateBuilderList();
  $("#templateBuilderModal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

$("#btnAddExToTemplate").addEventListener("click", () => {
  // Temporarily hide the template builder so picker appears on top
  $("#templateBuilderModal").classList.add("hidden");

  openExercisePicker(
    // On select callback
    (exId) => {
      if (!_templateBuilderExercises.includes(exId)) {
        _templateBuilderExercises.push(exId);
      }
      // Reopen template builder after selection
      renderTemplateBuilderList();
      $("#templateBuilderModal").classList.remove("hidden");
    },
    // On cancel callback
    () => {
      // Reopen template builder if picker was cancelled
      renderTemplateBuilderList();
      $("#templateBuilderModal").classList.remove("hidden");
    }
  );
});

function renderTemplateBuilderList() {
  const container = $("#templateBuilderList");
  container.innerHTML = "";

  if (_templateBuilderExercises.length === 0) {
    container.innerHTML = '<div class="template-builder-empty">No exercises added yet</div>';
    return;
  }

  _templateBuilderExercises.forEach((exId, idx) => {
    const ex = DB.exercises[exId];
    if (!ex) return;

    const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
    const color = MUSCLE_COLORS[category] || '#999';

    const div = document.createElement("div");
    div.className = "template-builder-item";
    div.style.borderLeftColor = color;
    div.innerHTML = `
      <span>${ex.name} <span class="muscle-tag" style="background:${color}">${category}</span></span>
      <button class="btn-ghost small text-red" data-idx="${idx}">✕</button>
    `;
    div.querySelector("button").addEventListener("click", () => {
      _templateBuilderExercises.splice(idx, 1);
      renderTemplateBuilderList();
    });
    container.appendChild(div);
  });
}

$("#btnCloseTemplateBuilder").addEventListener("click", () => {
  // Warn if exercises have been added
  if (_templateBuilderExercises.length > 0) {
    if (!confirm("You have exercises added. Discard this routine?")) return;
  }
  $("#templateBuilderModal").classList.add("hidden");
  document.body.style.overflow = "";
});

// Close template builder when clicking outside
$("#templateBuilderModal").addEventListener("click", (e) => {
  if (e.target === $("#templateBuilderModal")) {
    // Warn if exercises have been added
    if (_templateBuilderExercises.length > 0) {
      if (!confirm("You have exercises added. Discard this routine?")) return;
    }
    $("#templateBuilderModal").classList.add("hidden");
    document.body.style.overflow = "";
  }
});

$("#btnSaveTemplateBuilder").addEventListener("click", () => {
  const name = $("#templateBuilderName").value.trim();
  if (!name) {
    alert("Please enter a routine name");
    return;
  }
  if (_templateBuilderExercises.length === 0) {
    alert("Please add at least one exercise");
    return;
  }

  const exercises = _templateBuilderExercises.map(id => ({ exId: id }));

  if (_editingTemplateId) {
    // Update existing template
    DB.templates[_editingTemplateId].name = name;
    DB.templates[_editingTemplateId].exercises = exercises;
  } else {
    // Create new template
    const tId = uid();
    DB.templates[tId] = { id: tId, name, exercises };
  }

  saveDB();
  _editingTemplateId = null;
  $("#templateBuilderModal").classList.add("hidden");
  document.body.style.overflow = "";
  renderTemplates();
});

// --- HISTORY & STATS ---
function renderHistory() {
  const cont = $("#historyLog");
  cont.innerHTML = "";

  if (DB.sessions.length === 0) {
    cont.innerHTML = '<p class="muted">No workouts recorded yet.</p>';
    return;
  }

  const bw = getLatestBodyweight();

  // Group sessions by month
  const monthGroups = {};
  DB.sessions.forEach((sess, idx) => {
    const date = new Date(sess.start);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!monthGroups[monthKey]) {
      monthGroups[monthKey] = { label: monthLabel, sessions: [] };
    }
    monthGroups[monthKey].sessions.push({ sess, idx });
  });

  // Render each month group
  const sortedMonths = Object.keys(monthGroups).sort().reverse();
  sortedMonths.forEach((monthKey, monthIdx) => {
    const group = monthGroups[monthKey];
    const isCurrentMonth = monthIdx === 0;

    const monthDiv = document.createElement("div");
    monthDiv.className = "history-month";

    const header = document.createElement("div");
    header.className = "history-month-header";
    header.innerHTML = `
      <span>${group.label} (${group.sessions.length} workouts)</span>
      <span class="month-toggle">${isCurrentMonth ? '▲' : '▼'}</span>
    `;

    const content = document.createElement("div");
    content.className = `history-month-content ${isCurrentMonth ? 'expanded' : ''}`;

    header.onclick = () => {
      content.classList.toggle('expanded');
      header.querySelector('.month-toggle').textContent = content.classList.contains('expanded') ? '▲' : '▼';
    };

    group.sessions.forEach(({ sess, idx }) => {
      const div = document.createElement("div");
      div.className = "history-entry";

      const date = new Date(sess.start).toDateString();

      // Calculate workout duration
      let durationStr = "";
      if (sess.end) {
        const startTime = new Date(sess.start).getTime();
        const endTime = new Date(sess.end).getTime();
        const durationMins = Math.round((endTime - startTime) / 60000);
        if (durationMins >= 60) {
          const hours = Math.floor(durationMins / 60);
          const mins = durationMins % 60;
          durationStr = `${hours}h ${mins}m`;
        } else {
          durationStr = `${durationMins}m`;
        }
      }

      let details = "";
      (sess.order || []).forEach(exId => {
         const sets = sess.entries[exId];
         if(!sets || sets.length === 0) return;
         const ex = DB.exercises[exId];
         const exName = ex?.name || "Unknown";
         const unit = getWeightUnit();
         let badges = sets.map(s => {
             if(s.w) {
               const displayW = convertWeight(parseFloat(s.w));
               if (ex?.isAssisted && bw) {
                 const effectiveBw = convertWeight(bw);
                 const effective = effectiveBw - displayW;
                 return `<span class="set-tag">${effective.toFixed(1)}${unit} eff × ${s.r}</span>`;
               }
               return `<span class="set-tag">${displayW}${unit} × ${s.r}</span>`;
             }
             if(s.time) {
               const metric = ex?.cardioMetric || 'km';
               return `<span class="set-tag">${s.time}m / ${s.dist}${metric}</span>`;
             }
             return "";
         }).join("");
         details += `<div class="history-detail"><strong>${exName}</strong>${ex?.isAssisted ? ' <span class="muted small">(assisted)</span>' : ''}<br>${badges}</div>`;
      });

      const templateBadge = sess.templateName
        ? `<span class="template-badge">${sess.templateName}</span>`
        : '<span class="template-badge freestyle">Freestyle</span>';

      // Count only exercises that actually have logged entries
      const loggedExerciseCount = (sess.order || []).filter(exId =>
        sess.entries[exId] && sess.entries[exId].length > 0
      ).length;
      const exerciseWord = loggedExerciseCount === 1 ? 'exercise' : 'exercises';

      const notesHtml = sess.notes ? `<div class="history-notes"><em>${sess.notes}</em></div>` : '';

      div.innerHTML = `
        <div class="row">
          <div class="history-date">${date}${durationStr ? ` <span class="muted small">(${durationStr})</span>` : ''}</div>
          <button class="btn-ghost small text-red" onclick="deleteWorkout(${idx})">DELETE</button>
        </div>
        <div class="history-meta">${templateBadge} · ${loggedExerciseCount} ${exerciseWord}</div>
        ${notesHtml}
        ${details}
      `;
      content.appendChild(div);
    });

    monthDiv.appendChild(header);
    monthDiv.appendChild(content);
    cont.appendChild(monthDiv);
  });
}

function deleteWorkout(index) {
  if (!confirm("Delete this workout? This cannot be undone.")) return;
  DB.sessions.splice(index, 1);
  saveDB();
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
    const x = padding + (i / (dataPoints.length - 1)) * (w - padding * 2);
    const y = h - padding - ((val - minVal) / (maxVal - minVal)) * (h - padding * 2);
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

    // Populate select
    const sel = $("#statExSelect");
    if(sel.options.length === 0) {
        Object.values(DB.exercises).forEach(ex => {
            const opt = document.createElement("option");
            opt.value = ex.id; opt.textContent = ex.name;
            sel.appendChild(opt);
        });
        sel.addEventListener("change", () => {
            _exerciseHistoryExpanded = false; // Reset when exercise changes
            updateStatsChart();
        });
    }
    updateStatsChart();

    // Render breakdown chart
    renderBreakdownChart();
}

function updateStatsChart() {
    const exId = $("#statExSelect").value;
    const chartType = $("#statChartType").value; // "volume" or "maxWeight"
    const canvas = $("#progChart");

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
    const textColor = isDark ? "#fff" : "#000";

    const historyContainer = $("#exerciseHistory");

    if(!exId) {
        ctx.clearRect(0, 0, w, h);
        ctx.font = "14px -apple-system, sans-serif";
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.fillText("Select an exercise", w / 2, h / 2);
        if (historyContainer) historyContainer.innerHTML = "";
        return;
    }

    const ex = DB.exercises[exId];
    const unit = getWeightUnit();

    // Extract history - calculate total volume and max weight with unit conversion
    const historyForDisplay = [];
    DB.sessions.forEach(s => {
        if(s.entries && s.entries[exId] && s.entries[exId].length > 0) {
            let totalVolume = 0;
            let maxWeight = 0;
            const sets = s.entries[exId];
            sets.forEach(set => {
                const weight = convertWeight(parseFloat(set.w || 0));
                const reps = parseInt(set.r || 0);
                totalVolume += weight * reps;
                if (weight > maxWeight) maxWeight = weight;
            });
            historyForDisplay.push({ date: s.start, volume: totalVolume, maxWeight: maxWeight, sets: sets });
        }
    });
    // Chart needs oldest-first, display needs newest-first
    const history = historyForDisplay.slice().reverse();

    // Render history list (newest first)
    if (historyContainer) {
        if (historyForDisplay.length === 0) {
            historyContainer.innerHTML = '<p class="muted">No history for this exercise yet.</p>';
        } else {
            const showAll = _exerciseHistoryExpanded;
            const itemsToShow = showAll ? historyForDisplay : historyForDisplay.slice(0, 3);
            const remaining = historyForDisplay.length - 3;

            let html = '<h3 class="mb-2">LIFT HISTORY</h3>';
            itemsToShow.forEach(h => {
                const date = new Date(h.date);
                const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
                const setsHtml = h.sets.map(s => {
                    if (s.w) {
                        const displayW = convertWeight(parseFloat(s.w));
                        return `<span class="set-tag">${displayW}${unit} × ${s.r}</span>`;
                    }
                    if (s.time) return `<span class="set-tag">${s.time}m / ${s.dist}${ex?.cardioMetric || 'km'}</span>`;
                    return '';
                }).join('');
                html += `<div class="ex-history-item"><div class="ex-history-date"><strong>${dateStr}</strong></div><div class="ex-history-sets">${setsHtml}</div></div>`;
            });

            if (remaining > 0) {
                if (showAll) {
                    html += `<button class="btn-ghost small expand-history" id="btnCollapseHistory">▲ Show less</button>`;
                } else {
                    html += `<button class="btn-ghost small expand-history" id="btnExpandHistory">▼ + ${remaining} more sessions</button>`;
                }
            }
            historyContainer.innerHTML = html;

            // Add click handlers
            const expandBtn = $("#btnExpandHistory");
            const collapseBtn = $("#btnCollapseHistory");
            if (expandBtn) {
                expandBtn.onclick = () => {
                    _exerciseHistoryExpanded = true;
                    updateStatsChart();
                };
            }
            if (collapseBtn) {
                collapseBtn.onclick = () => {
                    _exerciseHistoryExpanded = false;
                    updateStatsChart();
                };
            }
        }
    }

    // Get the data based on chart type
    const chartData = history.map(h => chartType === "maxWeight" ? h.maxWeight : h.volume);

    if(history.length < 2 || chartData.every(v => v === 0)) {
        ctx.clearRect(0, 0, w, h);
        ctx.font = "14px -apple-system, sans-serif";
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.fillText("Need more data for chart", w / 2, h / 2);
        return;
    }

    const padding = { top: 20, right: 20, bottom: 40, left: 40 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const dataMin = Math.min(...chartData);
    const dataMax = Math.max(...chartData);

    // Round to nearest 100 for clean Y-axis
    const roundedMax = Math.ceil(dataMax / 100) * 100 || 100;
    const roundedMin = Math.max(0, Math.floor(dataMin / 100) * 100 - 100);
    const finalRange = roundedMax - roundedMin;

    ctx.clearRect(0, 0, w, h);

    // Y axis labels - round to 100s
    ctx.font = "11px -apple-system, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    const numSteps = 5;
    for (let i = 0; i <= numSteps; i++) {
        const val = roundedMin + (i / numSteps) * finalRange;
        const y = padding.top + chartH - (i / numSteps) * chartH;
        ctx.fillText(Math.round(val).toLocaleString(), padding.left - 8, y + 4);
        ctx.strokeStyle = isDark ? "#333" : "#ddd";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(w - padding.right, y);
        ctx.stroke();
    }

    // X axis labels (dates)
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(history.length / 5));
    history.forEach((h, i) => {
        if (i % step === 0 || i === history.length - 1) {
            const x = padding.left + (i / (history.length - 1)) * chartW;
            const date = new Date(h.date);
            const label = `${date.getDate()}/${date.getMonth() + 1}`;
            ctx.fillText(label, x, h - padding.bottom + 20);
        }
    });

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = chartType === "maxWeight" ? "#FF3333" : "#1a1a1a";
    if (isDark && chartType !== "maxWeight") ctx.strokeStyle = "#fff";
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
    chartData.forEach((val, i) => {
        const x = padding.left + (i / (chartData.length - 1)) * chartW;
        const y = padding.top + chartH - ((val - roundedMin) / finalRange) * chartH;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
    });
}

// --- EXPORT / IMPORT ---
const DATA_VERSION = 1;

$("#btnExportCSV").addEventListener("click", () => {
    // Workout data
    let csv = "=== WORKOUT DATA ===\nDate,Exercise,Set,Weight/Time,Reps/Dist\n";
    DB.sessions.forEach(s => {
        const date = s.start.split("T")[0];
        (s.order || []).forEach(exId => {
            const exName = DB.exercises[exId]?.name || "Unknown";
            (s.entries[exId] || []).forEach((set, i) => {
                const v1 = set.w || set.time;
                const v2 = set.r || set.dist;
                csv += `${date},${exName},${i+1},${v1},${v2}\n`;
            });
        });
    });

    // Bodyweight data
    csv += "\n=== BODYWEIGHT DATA ===\nDate,Weight (kg)\n";
    DB.bodyweight.forEach(bw => {
        const date = bw.date.split("T")[0];
        csv += `${date},${bw.kg}\n`;
    });

    const blob = new Blob([csv], {type: "text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "liftlog_export.csv";
    a.click();
});

$("#btnExportJSON").addEventListener("click", () => {
    const exportData = {
        version: DATA_VERSION,
        exportedAt: new Date().toISOString(),
        data: DB
    };
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `liftlog_backup_${new Date().toISOString().split("T")[0]}.json`;
    a.click();
});

$("#fileRestore").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
        try {
            const imported = JSON.parse(evt.target.result);

            // Validate structure
            let dataToRestore;
            if (imported.version && imported.data) {
                // New format with version
                dataToRestore = imported.data;
            } else if (imported.exercises && imported.sessions) {
                // Old format (direct DB export)
                dataToRestore = imported;
            } else {
                throw new Error("Invalid backup file structure");
            }

            // Validate required fields
            if (!dataToRestore.exercises || !dataToRestore.sessions) {
                throw new Error("Missing required data fields");
            }

            if (!confirm("This will replace all your current data. Continue?")) return;

            DB = dataToRestore;
            // Ensure all required fields exist
            if (!DB.bodyweight) DB.bodyweight = [];
            if (!DB.templates) DB.templates = {};
            if (!DB.user) DB.user = { theme: "light" };

            // Sort sessions by date (newest first)
            if (DB.sessions && DB.sessions.length > 0) {
              DB.sessions.sort((a, b) => new Date(b.start) - new Date(a.start));
            }

            saveDB();
            migrateExerciseCategories();
            document.body.className = `theme-${DB.user.theme}`;
            renderCurrentTab("dashboard");
            alert("Data restored successfully!");
        } catch (err) {
            alert("Error restoring backup: " + err.message);
        }
    };
    reader.readAsText(file);
    e.target.value = ""; // Reset file input
});

// --- PICKER UTILS ---
let _pickerCallback = null;
let _pickerCancelCallback = null;
let _pickerFilter = "All";

function openExercisePicker(cb, cancelCb = null) {
    _pickerCallback = cb;
    _pickerCancelCallback = cancelCb;
    _pickerFilter = "All";
    $("#pickerSearch").value = "";
    $("#pickerModal").classList.remove("hidden");
    document.body.style.overflow = "hidden"; // Prevent background scroll
    renderPickerTabs();
    renderPickerList();
}

function renderPickerTabs() {
    const container = $("#pickerTabs");
    container.innerHTML = "";

    const allTab = document.createElement("button");
    allTab.className = `picker-tab ${_pickerFilter === "All" ? "active" : ""}`;
    allTab.textContent = "All";
    allTab.onclick = () => { _pickerFilter = "All"; renderPickerTabs(); renderPickerList(); };
    container.appendChild(allTab);

    // Add muscle groups
    MUSCLE_GROUPS.forEach(muscle => {
        const tab = document.createElement("button");
        tab.className = `picker-tab ${_pickerFilter === muscle ? "active" : ""}`;
        tab.textContent = muscle;
        const color = MUSCLE_COLORS[muscle] || "#ccc";
        tab.style.borderColor = color;
        if (_pickerFilter === muscle) {
            tab.style.background = color;
            tab.style.color = "#000";
        }
        tab.onclick = () => { _pickerFilter = muscle; renderPickerTabs(); renderPickerList(); };
        container.appendChild(tab);
    });

    // Add Cardio tab (it's a type, not a muscle)
    const cardioTab = document.createElement("button");
    cardioTab.className = `picker-tab ${_pickerFilter === "Cardio" ? "active" : ""}`;
    cardioTab.textContent = "Cardio";
    const cardioColor = MUSCLE_COLORS.Cardio;
    cardioTab.style.borderColor = cardioColor;
    if (_pickerFilter === "Cardio") {
        cardioTab.style.background = cardioColor;
        cardioTab.style.color = "#000";
    }
    cardioTab.onclick = () => { _pickerFilter = "Cardio"; renderPickerTabs(); renderPickerList(); };
    container.appendChild(cardioTab);
}

$("#pickerSearch").addEventListener("input", renderPickerList);

function renderPickerList() {
    const q = $("#pickerSearch").value.toLowerCase();
    const div = $("#pickerList");
    div.innerHTML = "";

    const filtered = Object.values(DB.exercises)
        .filter(ex => {
            // Filter by Cardio (type) or muscle group
            if (_pickerFilter === "Cardio") {
                if (ex.type !== "cardio") return false;
            } else if (_pickerFilter !== "All") {
                if (ex.muscle !== _pickerFilter) return false;
            }
            if (q && !ex.name.toLowerCase().includes(q)) return false;
            return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    // Check if no exercises exist at all
    const allExercises = Object.values(DB.exercises);
    if (allExercises.length === 0) {
        div.innerHTML = `
            <p class="muted" style="padding: 10px;">No exercises yet!</p>
            <div class="picker-item picker-create-new" id="pickerGoToExercises">+ CREATE YOUR FIRST EXERCISE</div>
        `;
        div.querySelector("#pickerGoToExercises").onclick = () => {
            $("#pickerModal").classList.add("hidden");
            openNewExerciseModal();
        };
        return;
    }

    // Show filtered exercises
    if (filtered.length === 0) {
        div.innerHTML = '<p class="muted" style="padding: 10px;">No exercises match this filter</p>';
    } else {
        filtered.forEach(ex => {
            const btn = document.createElement("div");
            const colorClass = ex.type === "cardio" ? "Cardio" : (ex.muscle || 'Other');
            btn.className = `picker-item ex-cat-${colorClass}`;
            btn.textContent = ex.name;
            btn.onclick = () => {
                if(_pickerCallback) _pickerCallback(ex.id);
                $("#pickerModal").classList.add("hidden");
                document.body.style.overflow = ""; // Restore scroll
            };
            div.appendChild(btn);
        });
    }

    // Always add option to create new exercise at the bottom
    const createBtn = document.createElement("div");
    createBtn.className = "picker-item picker-create-new";
    createBtn.textContent = "+ ADD NEW EXERCISE";
    createBtn.onclick = () => {
        $("#pickerModal").classList.add("hidden");
        openNewExerciseModal();
    };
    div.appendChild(createBtn);
}

$("#pickerClose").addEventListener("click", () => {
  $("#pickerModal").classList.add("hidden");
  document.body.style.overflow = ""; // Restore scroll
  if (_pickerCancelCallback) {
    _pickerCancelCallback();
    _pickerCancelCallback = null;
  }
});

// Theme Toggle
$("#btnTheme").addEventListener("click", () => {
   DB.user.theme = DB.user.theme === "light" ? "dark" : "light";
   document.body.className = `theme-${DB.user.theme}`;
   saveDB();
   // Re-render charts to update colors
   const activeTab = $(".tab.active")?.dataset.tab;
   if (activeTab === "stats") {
     drawBodyweightChart();
     updateStatsChart();
     renderBreakdownChart();
   } else if (activeTab === "dashboard") {
     renderCalendar();
   }
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

// Templates section collapsible toggle
$("#templatesHeader").addEventListener("click", (e) => {
  // Don't toggle if clicking the NEW button
  if (e.target.id === "btnNewTemplate") return;

  const content = $("#templatesContent");
  const icon = $("#templatesToggle");
  content.classList.toggle("collapsed");
  icon.classList.toggle("collapsed");
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
$("#dataHeader").addEventListener("click", () => {
  const content = $("#dataContent");
  const icon = $("#dataToggle");
  content.classList.toggle("collapsed");
  icon.classList.toggle("collapsed");
});

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

  // Set compound toggle
  const compoundToggle = $("#settingCompound");
  if (compoundToggle) compoundToggle.checked = DB.user.includeCompound !== false;

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

// Suggestions toggle
$("#settingSuggestions").addEventListener("change", (e) => {
  DB.user.showSuggestions = e.target.checked;
  saveDB();
});

// Compound muscles toggle
$("#settingCompound").addEventListener("change", (e) => {
  DB.user.includeCompound = e.target.checked;
  saveDB();
  renderBreakdownChart();
});

// Training goal change
$("#settingGoal").addEventListener("change", (e) => {
  DB.user.trainingGoal = e.target.value;
  saveDB();
});

// --- UNIT CONVERSION HELPERS ---
function convertWeight(kg) {
  // Convert kg value to display unit
  if (DB.user.useLbs) {
    return parseFloat((kg * KG_TO_LBS).toFixed(1));
  }
  return parseFloat(kg);
}

function formatWeight(kg) {
  // Format kg value with unit label
  if (DB.user.useLbs) {
    return (kg * KG_TO_LBS).toFixed(1) + " lbs";
  }
  return kg + " kg";
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
$("#btnFactoryReset").addEventListener("click", () => {
  const confirmation = prompt('This will delete ALL your data permanently.\n\nType "RESET" to confirm:');
  if (confirmation !== "RESET") {
    if (confirmation !== null) {
      alert('Reset cancelled. You must type "RESET" exactly to confirm.');
    }
    return;
  }

  // Clear everything
  localStorage.removeItem(DB_KEY);
  DB = JSON.parse(JSON.stringify(DEFAULT_DB));
  saveDB();

  // Reset UI
  document.body.className = "theme-light";
  ACTIVE_SESSION = null;
  stopTimer();

  alert("All data has been reset.");
  renderCurrentTab("dashboard");
});

// --- WORKOUT NOTES ---
// Save workout notes on input
$("#workoutNotes").addEventListener("input", (e) => {
  if (ACTIVE_SESSION) {
    ACTIVE_SESSION.notes = e.target.value;
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

// --- COMPOUND EXERCISES ---
// Toggle secondary muscles visibility
$("#newExCompound").addEventListener("change", (e) => {
  const wrapper = $("#secondaryMusclesWrapper");
  if (e.target.checked) {
    wrapper.classList.remove("hidden");
    renderSecondaryMusclesList();
  } else {
    wrapper.classList.add("hidden");
  }
});

let _selectedSecondaryMuscles = [];

function renderSecondaryMusclesList() {
  const container = $("#secondaryMusclesList");
  container.innerHTML = "";

  const primaryMuscle = $("#newExMuscle").value;

  MUSCLE_GROUPS.forEach(muscle => {
    // Don't show primary muscle as secondary option
    if (muscle === primaryMuscle) return;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `secondary-muscle-chip ${_selectedSecondaryMuscles.includes(muscle) ? "selected" : ""}`;
    chip.textContent = muscle;
    chip.onclick = () => {
      if (_selectedSecondaryMuscles.includes(muscle)) {
        _selectedSecondaryMuscles = _selectedSecondaryMuscles.filter(m => m !== muscle);
      } else {
        _selectedSecondaryMuscles.push(muscle);
      }
      renderSecondaryMusclesList();
    };
    container.appendChild(chip);
  });
}

// Update secondary muscles when primary changes
$("#newExMuscle").addEventListener("change", () => {
  if ($("#newExCompound").checked) {
    // Remove primary from secondary if it was selected
    const primary = $("#newExMuscle").value;
    _selectedSecondaryMuscles = _selectedSecondaryMuscles.filter(m => m !== primary);
    renderSecondaryMusclesList();
  }
});

// --- BREAKDOWN CHART ---
let _breakdownOffset = 0; // 0 = current period, -1 = previous, etc.
let _hiddenMuscles = new Set(); // Muscles hidden from chart
let _exerciseHistoryExpanded = false; // Whether to show all exercise history

function getBreakdownPeriodInfo() {
  const period = $("#breakdownPeriod").value;
  const granularity = $("#breakdownGranularity").value;
  const now = new Date();
  let startDate, endDate, labels = [], labelText;

  if (period === "week") {
    // Start of week (Sunday) offset by _breakdownOffset weeks
    const currentWeekStart = new Date(now);
    currentWeekStart.setDate(now.getDate() - now.getDay() + (_breakdownOffset * 7));
    startDate = new Date(currentWeekStart);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);

    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      labels.push(DAYS[d.getDay()]);
    }

    if (_breakdownOffset === 0) {
      labelText = "This Week";
    } else {
      const weekStart = startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const weekEnd = endDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      labelText = `${weekStart} - ${weekEnd}`;
    }

  } else if (period === "month") {
    const targetMonth = new Date(now.getFullYear(), now.getMonth() + _breakdownOffset, 1);
    startDate = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
    endDate = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0);

    const monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    labelText = `${monthNames[targetMonth.getMonth()]} ${targetMonth.getFullYear()}`;

    if (granularity === "weekly") {
      // Group by weeks within the month
      labels = ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5"];
    } else {
      // Daily view
      const daysInMonth = endDate.getDate();
      for (let i = 1; i <= daysInMonth; i++) {
        labels.push(i.toString());
      }
    }

  } else { // year
    const targetYear = now.getFullYear() + _breakdownOffset;
    startDate = new Date(targetYear, 0, 1);
    endDate = new Date(targetYear, 11, 31);
    labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    labelText = targetYear.toString();
  }

  return { startDate, endDate, labels, labelText, period, granularity };
}

function renderBreakdownChart() {
  const canvas = $("#breakdownChart");
  if (!canvas) return;

  const { startDate, endDate, labels, labelText, period, granularity } = getBreakdownPeriodInfo();
  $("#breakdownPeriodLabel").textContent = labelText;

  const mode = $("#breakdownMode").value; // "volume" or "sets"
  const isDark = document.body.classList.contains("theme-dark");
  const textColor = isDark ? "#fff" : "#000";

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
  const sessions = DB.sessions.filter(s => {
    const d = new Date(s.start);
    return d >= startDate && d <= endDate;
  });

  if (sessions.length === 0) {
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
    let idx = getBreakdownIndex(sessionDate, startDate, period, labels.length, granularity);

    Object.entries(s.entries || {}).forEach(([exId, sets]) => {
      const ex = DB.exercises[exId];
      if (!ex || !sets || sets.length === 0) return;

      if (ex.type === "cardio") {
        // Cardio only appears in "sets" mode, not "volume" mode
        if (mode === "sets" && !_hiddenMuscles.has("Cardio")) {
          muscleData["Cardio"][idx] += sets.length;
        }
        return;
      }

      const muscle = ex.muscle || "Other";

      if (mode === "volume") {
        // Volume = weight × reps
        let volume = 0;
        sets.forEach(set => {
          if (set.w && set.r) {
            volume += convertWeight(parseFloat(set.w)) * parseInt(set.r);
          }
        });

        if (!_hiddenMuscles.has(muscle)) {
          muscleData[muscle][idx] += volume;
        }

        // Secondary muscles get 50% credit if enabled
        if (DB.user.includeCompound && ex.isCompound && ex.secondaryMuscles) {
          ex.secondaryMuscles.forEach(secMuscle => {
            if (!_hiddenMuscles.has(secMuscle)) {
              muscleData[secMuscle][idx] += volume * 0.5;
            }
          });
        }
      } else {
        // Sets mode - count number of sets
        if (!_hiddenMuscles.has(muscle)) {
          muscleData[muscle][idx] += sets.length;
        }

        // Secondary muscles get credited with sets too if enabled
        if (DB.user.includeCompound && ex.isCompound && ex.secondaryMuscles) {
          ex.secondaryMuscles.forEach(secMuscle => {
            if (!_hiddenMuscles.has(secMuscle)) {
              muscleData[secMuscle][idx] += sets.length;
            }
          });
        }
      }
    });
  });

  // Use roundTo=10 for sets mode, 100 for volume mode
  const roundTo = mode === "sets" ? 10 : 100;
  drawHiResStackedBarChart(ctx, w, h, labels, muscleData, allGroups, textColor, isDark, roundTo);

  // Render clickable legend styled like tabs
  const legendContainer = $("#breakdownLegend");
  legendContainer.innerHTML = "";

  // Add "All" button first
  const allBtn = document.createElement("button");
  const allSelected = _hiddenMuscles.size === 0;
  allBtn.className = `legend-tab ${allSelected ? "active" : "inactive"}`;
  allBtn.textContent = "All";
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
    tab.style.borderColor = color;
    if (!isHidden) {
      tab.style.background = color;
      tab.style.color = "#000";
    } else {
      // For inactive state in dark mode
      if (isDark) {
        tab.style.borderColor = color;
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

  // Clear cardio summary since it's now in the chart
  $("#breakdownCardio").innerHTML = "";
}

function getBreakdownIndex(date, startDate, period, maxLabels, granularity = "daily") {
  if (period === "week") {
    const diff = Math.floor((date - startDate) / (1000 * 60 * 60 * 24));
    return Math.max(0, Math.min(6, diff));
  } else if (period === "month") {
    if (granularity === "weekly") {
      // Get week number within month (0-4)
      const dayOfMonth = date.getDate();
      return Math.min(Math.floor((dayOfMonth - 1) / 7), 4);
    }
    return Math.min(date.getDate() - 1, maxLabels - 1);
  } else {
    return date.getMonth();
  }
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
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 8, y + 4);
    ctx.strokeStyle = isDark ? "#333" : "#ddd";
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
  labels.forEach((label, i) => {
    if (i % step === 0) {
      const x = padding.left + gap + barWidth / 2 + i * (chartW / labels.length);
      ctx.fillText(label, x, h - padding.bottom + 15);
    }
  });
}

function drawHiResStackedBarChart(ctx, w, h, labels, muscleData, groups, textColor, isDark, roundTo = 100) {
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  ctx.clearRect(0, 0, w, h);

  // Calculate max stacked value (excluding hidden muscles)
  const totals = labels.map((_, i) => {
    return groups.reduce((sum, muscle) => {
      if (_hiddenMuscles.has(muscle)) return sum;
      return sum + (muscleData[muscle]?.[i] || 0);
    }, 0);
  });
  const maxVal = Math.max(...totals) || roundTo;
  // Round max to specified value (100 for volume, 10 for sets)
  const roundedMax = Math.ceil(maxVal / roundTo) * roundTo || roundTo;

  const barWidth = chartW / labels.length * 0.7;
  const gap = chartW / labels.length * 0.15;

  // Y axis
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillStyle = textColor;
  ctx.textAlign = "right";

  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = (roundedMax / steps) * i;
    const y = padding.top + chartH - (i / steps) * chartH;
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 8, y + 4);
    ctx.strokeStyle = isDark ? "#333" : "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
  }

  // Stacked bars
  labels.forEach((_, i) => {
    const x = padding.left + gap + i * (chartW / labels.length);
    let currentY = padding.top + chartH;

    groups.forEach(muscle => {
      if (_hiddenMuscles.has(muscle)) return;
      const val = muscleData[muscle]?.[i] || 0;
      if (val === 0) return;

      const color = MUSCLE_COLORS[muscle] || "#999";
      const barH = (val / roundedMax) * chartH;
      ctx.fillStyle = color;
      ctx.fillRect(x, currentY - barH, barWidth, barH);
      currentY -= barH;
    });
  });

  // X labels
  ctx.textAlign = "center";
  ctx.fillStyle = textColor;
  const step = labels.length > 15 ? Math.ceil(labels.length / 8) : 1;
  labels.forEach((label, i) => {
    if (i % step === 0) {
      const x = padding.left + gap + barWidth / 2 + i * (chartW / labels.length);
      ctx.fillText(label, x, h - padding.bottom + 15);
    }
  });
}

// Breakdown chart controls
$("#breakdownPeriod").addEventListener("change", () => {
  _breakdownOffset = 0; // Reset to current period when changing type
  // Show/hide granularity selector for month view
  const granularitySelect = $("#breakdownGranularity");
  if ($("#breakdownPeriod").value === "month") {
    granularitySelect.classList.remove("hidden");
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

// Initialization
migrateExerciseCategories();
populateSelects();
loadSettings();
renderCurrentTab("dashboard");
