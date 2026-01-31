/**
 * LIFTLOG ULTRA - Neobrutalist Edition
 * 2026 Refactor
 */

const DB_KEY = "liftlog_ultra_v1";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --- DEFAULT DATA & MIGRATION ---
const DEFAULT_DB = {
  user: { theme: "light", increment: 2.5 },
  exercises: {}, // id -> {id, name, type, muscle, equip, increment}
  templates: {}, // id -> {id, name, exercises: [{exId, sets}]}
  sessions: [],  // [{id, start, end, name, entries: {exId: [{w, r, note, type}] } }]
  bodyweight: [], // [{date, kg}]
  goals: {}
};

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
    // Confirm if leaving workout tab with active session
    const currentTab = $(".tab.active")?.dataset.tab;
    if (currentTab === "workout" && ACTIVE_SESSION && btn.dataset.tab !== "workout") {
      if (!confirm("You have an active workout. Leave this tab?")) {
        return;
      }
    }

    $$(".tab").forEach(b => b.classList.remove("active"));
    $$(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    renderCurrentTab(btn.dataset.tab);
  });
});

// Warn before closing page with active workout
window.addEventListener("beforeunload", (e) => {
  if (ACTIVE_SESSION) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function renderCurrentTab(tab) {
  if (tab === "dashboard") renderDashboard();
  if (tab === "workout") renderWorkoutTab();
  if (tab === "exercises") renderExerciseLibrary();
  if (tab === "history") renderHistory();
  if (tab === "stats") renderStats();
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
  const kg = parseFloat($("#bwInput").value);
  if (!kg) return;
  DB.bodyweight.push({ date: new Date().toISOString(), kg });
  DB.bodyweight.sort((a,b) => new Date(a.date) - new Date(b.date));
  saveDB();
  drawBodyweightChart();
  renderBodyweightEntries();
  $("#bwInput").value = "";
});

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

  recent.forEach((entry, idx) => {
    const actualIdx = DB.bodyweight.length - 1 - idx;
    const date = new Date(entry.date);
    const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });

    const div = document.createElement("div");
    div.className = "bw-entry";
    div.innerHTML = `
      <span>${dateStr}</span>
      <span>${entry.kg} kg</span>
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
  const ctx = $("#bwChart").getContext("2d");
  const data = DB.bodyweight.slice(-14); // Last 14 entries

  // Reset canvas
  ctx.canvas.width = ctx.canvas.offsetWidth;
  ctx.canvas.height = ctx.canvas.offsetHeight;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

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

  const padding = { top: 20, right: 20, bottom: 40, left: 45 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  const values = data.map(d => d.kg);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  // Round to nice 5kg intervals
  const minVal = Math.floor(dataMin / 5) * 5 - 5;
  const maxVal = Math.ceil(dataMax / 5) * 5 + 5;
  const range = maxVal - minVal;
  const stepSize = 5;
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
  data.forEach((d, i) => {
    const x = padding.left + (i / (data.length - 1)) * chartW;
    const y = padding.top + chartH - ((d.kg - minVal) / range) * chartH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw dots
  ctx.fillStyle = "#FF3333";
  data.forEach((d, i) => {
    const x = padding.left + (i / (data.length - 1)) * chartW;
    const y = padding.top + chartH - ((d.kg - minVal) / range) * chartH;
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

// Helper to determine if text should be dark or light based on background
function getContrastTextColor(hexColor) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  // Calculate luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000" : "#fff";
}

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
    (sess.order || []).forEach(exId => {
      const ex = DB.exercises[exId];
      const sets = sess.entries[exId];
      if (!ex || !sets || sets.length === 0) return;

      // Get muscle group and color
      const category = ex.type === 'cardio' ? 'Cardio' : (ex.muscle || 'Other');
      const color = MUSCLE_COLORS[category] || '#999';

      const setsHtml = sets.map(s => {
        if (s.w) return `<span class="set-tag">${s.w}kg × ${s.r}</span>`;
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
      const sets = lastSession.sets.map(s => {
        if (s.w) return `${s.w}kg × ${s.r}`;
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
      tab.style.color = getContrastTextColor(color);
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
    cardioTab.style.color = getContrastTextColor(cardioColor);
  }
  cardioTab.onclick = () => { _libraryFilter = "Cardio"; renderLibraryTabs(); renderExerciseLibrary(); };
  container.appendChild(cardioTab);
}

// Library search listener
$("#searchEx").addEventListener("input", renderExerciseLibrary);

$("#btnShowAddEx").addEventListener("click", () => {
  // Reset form for new exercise
  EDITING_EXERCISE_ID = null;
  $("#exModalTitle").textContent = "NEW EXERCISE";
  $("#newExName").value = "";
  $("#newExType").value = "strength";
  $("#newExMuscle").value = MUSCLE_GROUPS[0];
  $("#newExEquip").value = "barbell";
  $("#newExInc").value = "2.5";
  $("#newExCardioMetric").value = "";
  $("#newExAssisted").checked = false;
  $("#strengthOptions").classList.remove("hidden");
  $("#cardioOptions").classList.add("hidden");
  $("#muscleSelectWrapper").classList.remove("hidden");
  $("#btnDeleteEx").classList.add("hidden"); // Hide delete for new exercise
  $("#addExModal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
});

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
  const exerciseData = {
    name,
    type,
    muscle: type === 'cardio' ? null : $("#newExMuscle").value,
    equip: type === 'cardio' ? null : $("#newExEquip").value,
    increment: type === 'cardio' ? null : (parseFloat($("#newExInc").value) || 2.5),
    cardioMetric: type === 'cardio' ? ($("#newExCardioMetric").value.trim() || 'km') : null,
    isAssisted: type === 'strength' ? $("#newExAssisted").checked : false
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
  $("#newExAssisted").checked = ex.isAssisted || false;

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
    const timeStr = `${m}:${s}`;
    // Update both timer displays
    $("#workoutTimer").textContent = timeStr;
    $("#workoutTimerMini").textContent = timeStr;
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
  if (!tId) return alert("Select a template");
  startWorkout(DB.templates[tId]);
});

function startWorkout(template = null) {
  if (ACTIVE_SESSION && !confirm("Overwrite current workout?")) return;

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

  // Headers based on type
  const headers = $("#logHeaders");
  if (ex.type === 'cardio') {
    headers.querySelector(".h-val-1").textContent = "MINS";
    headers.querySelector(".h-val-2").textContent = (ex.cardioMetric || 'KM').toUpperCase();
  } else if (ex.isAssisted) {
    headers.querySelector(".h-val-1").textContent = "ASSIST";
    headers.querySelector(".h-val-2").textContent = "REPS";
  } else {
    headers.querySelector(".h-val-1").textContent = "KG";
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
      const lowerWeight = bestSet.w;
      const higherWeight = bestSet.w + increment;

      // Suggestion: same weight = more reps, more weight = same/fewer reps
      let suggestion = "";
      if (bestSet.r >= 12) {
        suggestion = `<strong>Try: ${higherWeight}kg for 8-10 reps</strong> (time to increase!)`;
      } else if (bestSet.r >= 8) {
        suggestion = `<strong>Try: ${lowerWeight}-${higherWeight}kg for ${bestSet.r}-${bestSet.r + 2} reps</strong>`;
      } else {
        suggestion = `<strong>Try: ${lowerWeight}kg for ${bestSet.r + 1}-${bestSet.r + 3} reps</strong> (build reps first)`;
      }

      const dateStr = new Date(lastSession.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      $("#prevSessionInfo").innerHTML = `
        <div class="muted small">Last: ${dateStr} — Best set: ${bestSet.w}kg × ${bestSet.r}</div>
        <div class="suggestion">${suggestion}</div>
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
    const name = prompt("Name this template:");
    if(!name) return;
    const tId = uid();
    const exercises = ACTIVE_SESSION.order.map(id => ({ exId: id }));
    DB.templates[tId] = { id: tId, name, exercises };
    saveDB();
    alert("Template saved.");
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
    if(!confirm("Delete template?")) return;
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
  $("#templateBuilderTitle").textContent = "CREATE TEMPLATE";
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
  $("#templateBuilderTitle").textContent = "EDIT TEMPLATE";
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
  $("#templateBuilderModal").classList.add("hidden");
  document.body.style.overflow = "";
});

// Close template builder when clicking outside
$("#templateBuilderModal").addEventListener("click", (e) => {
  if (e.target === $("#templateBuilderModal")) {
    $("#templateBuilderModal").classList.add("hidden");
    document.body.style.overflow = "";
  }
});

$("#btnSaveTemplateBuilder").addEventListener("click", () => {
  const name = $("#templateBuilderName").value.trim();
  if (!name) {
    alert("Please enter a template name");
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
         let badges = sets.map(s => {
             if(s.w) {
               if (ex?.isAssisted && bw) {
                 const effective = bw - parseFloat(s.w);
                 return `<span class="set-tag">${effective}kg eff × ${s.r}</span>`;
               }
               return `<span class="set-tag">${s.w}kg × ${s.r}</span>`;
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

      div.innerHTML = `
        <div class="row">
          <div class="history-date">${date}${durationStr ? ` <span class="muted small">(${durationStr})</span>` : ''}</div>
          <button class="btn-ghost small text-red" onclick="deleteWorkout(${idx})">DELETE</button>
        </div>
        <div class="history-meta">${templateBadge} · ${loggedExerciseCount} ${exerciseWord}</div>
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
        sel.addEventListener("change", updateStatsChart);
    }
    updateStatsChart();
}

function updateStatsChart() {
    const exId = $("#statExSelect").value;
    const ctx = $("#progChart").getContext("2d");

    // Reset canvas
    ctx.canvas.width = ctx.canvas.offsetWidth;
    ctx.canvas.height = ctx.canvas.offsetHeight;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

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

    // Extract history - calculate total volume (weight × reps)
    // Sessions are stored newest-first, so iterate in order for chart (oldest to newest)
    // but keep a separate array for display (newest first)
    const historyForChart = [];
    const historyForDisplay = [];
    DB.sessions.forEach(s => {
        if(s.entries && s.entries[exId] && s.entries[exId].length > 0) {
            let totalVolume = 0;
            const sets = s.entries[exId];
            sets.forEach(set => {
                const weight = parseFloat(set.w || 0);
                const reps = parseInt(set.r || 0);
                totalVolume += weight * reps;
            });
            historyForDisplay.push({ date: s.start, volume: totalVolume, sets: sets });
        }
    });
    // Chart needs oldest-first, display needs newest-first
    const history = historyForDisplay.slice().reverse();

    // Render history list (newest first)
    if (historyContainer) {
        if (historyForDisplay.length === 0) {
            historyContainer.innerHTML = '<p class="muted">No history for this exercise yet.</p>';
        } else {
            let html = '<h3 class="mb-2">LIFT HISTORY</h3>';
            historyForDisplay.slice(0, 3).forEach(h => {
                const date = new Date(h.date);
                const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
                const setsHtml = h.sets.map(s => {
                    if (s.w) return `<span class="set-tag">${s.w}kg × ${s.r}</span>`;
                    if (s.time) return `<span class="set-tag">${s.time}m / ${s.dist}${ex?.cardioMetric || 'km'}</span>`;
                    return '';
                }).join('');
                html += `<div class="ex-history-item"><strong>${dateStr}</strong> ${setsHtml}</div>`;
            });
            if (historyForDisplay.length > 3) {
                html += `<p class="muted small">+ ${historyForDisplay.length - 3} more sessions</p>`;
            }
            historyContainer.innerHTML = html;
        }
    }

    if(history.length < 2 || history.every(h => h.volume === 0)) {
        ctx.clearRect(0, 0, w, h);
        ctx.font = "14px -apple-system, sans-serif";
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.fillText("Need more data for chart", w / 2, h / 2);
        return;
    }

    const padding = { top: 20, right: 20, bottom: 40, left: 55 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    const volumes = history.map(h => h.volume);
    const dataMin = Math.min(...volumes);
    const dataMax = Math.max(...volumes);

    // Round to nice intervals
    const range = dataMax - dataMin || 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(range)));
    const stepSize = magnitude > 100 ? Math.ceil(range / 4 / magnitude) * magnitude : Math.ceil(range / 4 / 50) * 50 || 100;

    const minVal = Math.floor(dataMin / stepSize) * stepSize;
    const maxVal = Math.ceil(dataMax / stepSize) * stepSize + stepSize;
    const finalRange = maxVal - minVal;

    ctx.clearRect(0, 0, w, h);

    // Y axis labels (volume)
    ctx.font = "10px -apple-system, sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    const numSteps = Math.min(5, Math.ceil(finalRange / stepSize));
    for (let i = 0; i <= numSteps; i++) {
        const val = minVal + (i * stepSize);
        if (val > maxVal) break;
        const y = padding.top + chartH - ((val - minVal) / finalRange) * chartH;
        ctx.fillText(val.toLocaleString(), padding.left - 8, y + 4);
        ctx.strokeStyle = isDark ? "#333" : "#ddd";
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
            ctx.fillText(label, x, ctx.canvas.height - padding.bottom + 20);
        }
    });

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = "#1a1a1a";
    if (isDark) ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    history.forEach((h, i) => {
        const x = padding.left + (i / (history.length - 1)) * chartW;
        const y = padding.top + chartH - ((h.volume - minVal) / finalRange) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw dots
    ctx.fillStyle = ctx.strokeStyle;
    history.forEach((h, i) => {
        const x = padding.left + (i / (history.length - 1)) * chartW;
        const y = padding.top + chartH - ((h.volume - minVal) / finalRange) * chartH;
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
            tab.style.color = getContrastTextColor(color);
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
        cardioTab.style.color = getContrastTextColor(cardioColor);
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

    if (filtered.length === 0) {
        div.innerHTML = '<p class="muted" style="padding: 10px;">No exercises found</p>';
        return;
    }

    filtered.forEach(ex => {
        const btn = document.createElement("div");
        const colorClass = ex.type === "cardio" ? "Cardio" : (ex.muscle || 'Other');
        btn.className = `picker-item ex-cat-${colorClass}`;
        btn.textContent = ex.name;
        btn.onclick = () => {
            if(_pickerCallback) _pickerCallback(ex.id);
            $("#pickerModal").classList.add("hidden");
        };
        div.appendChild(btn);
    });
}

$("#pickerClose").addEventListener("click", () => {
  $("#pickerModal").classList.add("hidden");
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
});

// Timer Toggle - Expand from minimal bar to full card
$("#btnToggleTimerExpand").addEventListener("click", () => {
  $("#timerBarMinimal").classList.add("hidden");
  $("#timerCardFull").classList.remove("hidden");
});

// Timer Toggle - Collapse from full card to minimal bar
$("#btnToggleTimerCollapse").addEventListener("click", () => {
  $("#timerCardFull").classList.add("hidden");
  $("#timerBarMinimal").classList.remove("hidden");
});

// Both finish buttons do the same thing
$("#btnFinishWorkoutMini").addEventListener("click", () => {
  $("#btnFinishWorkout").click();
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

// Initialization
migrateExerciseCategories();
populateSelects();
renderCurrentTab("dashboard");
