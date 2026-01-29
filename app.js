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
}

// --- DASHBOARD ---
function renderDashboard() {
  drawBodyweightChart();
  renderCalendar();
  $("#bwInput").value = "";
}

$("#btnLogBW").addEventListener("click", () => {
  const kg = parseFloat($("#bwInput").value);
  if (!kg) return;
  DB.bodyweight.push({ date: new Date().toISOString(), kg });
  DB.bodyweight.sort((a,b) => new Date(a.date) - new Date(b.date));
  saveDB();
  drawBodyweightChart();
  $("#bwInput").value = "";
});

function drawBodyweightChart() {
  const ctx = $("#bwChart").getContext("2d");
  const data = DB.bodyweight.slice(-14); // Last 14 entries
  if (data.length < 2) {
    ctx.clearRect(0,0,300,150);
    ctx.font = "14px monospace";
    ctx.fillText("Log more data to see chart", 50, 75);
    return;
  }
  
  const labels = data.map(d => new Date(d.date).getDate());
  const values = data.map(d => d.kg);
  simpleLineChart(ctx, labels, values, "#FF3333");
}

function renderCalendar() {
  const grid = $("#calendarGrid");
  grid.innerHTML = "";
  
  // Last 28 days
  const today = new Date();
  for (let i = 27; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const iso = d.toISOString().split("T")[0];
    
    const div = document.createElement("div");
    div.className = "cal-day";
    div.textContent = d.getDate();
    if (i === 0) div.classList.add("today");
    
    // Check if workout existed
    const hasWorkout = DB.sessions.some(s => s.start.startsWith(iso));
    if (hasWorkout) div.classList.add("active");
    
    grid.appendChild(div);
  }
}

// --- EXERCISES ---
const MUSCLE_GROUPS = ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Quads", "Hamstrings", "Glutes", "Core", "Cardio", "Other"];

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
  const container = $("#exerciseList");
  container.innerHTML = "";
  
  const filter = $("#filterMuscle").value;
  const search = $("#searchEx").value.toLowerCase();
  
  const list = Object.values(DB.exercises).sort((a,b) => a.name.localeCompare(b.name));
  
  list.forEach(ex => {
    if (filter && ex.muscle !== filter) return;
    if (search && !ex.name.toLowerCase().includes(search)) return;
    
    const div = document.createElement("div");
    div.className = `ex-item ex-cat-${ex.muscle || 'Other'}`;
    div.innerHTML = `
      <span>${ex.name} <span class="muscle-tag">${ex.muscle || 'Gen'}</span></span>
      <button class="btn-ghost icon-btn" onclick="editExercise('${ex.id}')">✎</button>
    `;
    container.appendChild(div);
  });
}

// Populate Dropdowns
function populateSelects() {
  const muscles = $("#newExMuscle");
  const filter = $("#filterMuscle");
  
  [muscles, filter].forEach(sel => {
    if(!sel) return;
    sel.innerHTML = sel === filter ? '<option value="">All Muscles</option>' : '';
    MUSCLE_GROUPS.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      sel.appendChild(opt);
    });
  });
  
  $("#newExEquip").innerHTML = `
    <option value="barbell">Barbell</option>
    <option value="dumbbell">Dumbbell</option>
    <option value="machine">Machine</option>
    <option value="cable">Cable</option>
    <option value="bodyweight">Bodyweight</option>
  `;
}

$("#btnShowAddEx").addEventListener("click", () => {
  // Reset form for new exercise
  EDITING_EXERCISE_ID = null;
  $("#exModalTitle").textContent = "NEW EXERCISE";
  $("#newExName").value = "";
  $("#newExType").value = "strength";
  $("#newExMuscle").value = MUSCLE_GROUPS[0];
  $("#newExEquip").value = "barbell";
  $("#newExInc").value = "2.5";
  $("#strengthOptions").classList.remove("hidden");
  $("#addExModal").showModal();
});

$("#btnCloseExModal").addEventListener("click", () => {
  EDITING_EXERCISE_ID = null;
  $("#addExModal").close();
});

$("#newExType").addEventListener("change", (e) => {
   if(e.target.value === 'cardio') $("#strengthOptions").classList.add("hidden");
   else $("#strengthOptions").classList.remove("hidden");
});

let EDITING_EXERCISE_ID = null;

$("#btnSaveEx").addEventListener("click", () => {
  const name = $("#newExName").value.trim();
  if (!name) return;

  const type = $("#newExType").value;
  const exerciseData = {
    name,
    type,
    muscle: $("#newExMuscle").value,
    equip: $("#newExEquip").value,
    increment: parseFloat($("#newExInc").value) || 2.5
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
  $("#addExModal").close();
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

  // Show/hide strength options based on type
  if (ex.type === 'cardio') {
    $("#strengthOptions").classList.add("hidden");
  } else {
    $("#strengthOptions").classList.remove("hidden");
  }

  $("#addExModal").showModal();
}

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
  if (!tId) return alert("Select a template");
  startWorkout(DB.templates[tId]);
});

function startWorkout(template = null) {
  if (ACTIVE_SESSION && !confirm("Overwrite current workout?")) return;
  
  ACTIVE_SESSION = {
    id: uid(),
    start: new Date().toISOString(),
    entries: {}, // exId -> []
    order: [] // list of exIds to maintain order
  };
  
  if (template) {
    template.exercises.forEach(item => {
      ACTIVE_SESSION.order.push(item.exId);
      // Pre-fill planned sets? For now just adding exercise to list
    });
  }
  
  saveDB(); // Persist active state (could save to separate 'active' key)
  renderWorkoutTab();
}

function renderActiveSession() {
  const list = $("#activeExerciseList");
  list.innerHTML = "";
  
  ACTIVE_SESSION.order.forEach((exId, idx) => {
    const ex = DB.exercises[exId];
    if (!ex) return;
    const sets = ACTIVE_SESSION.entries[exId] || [];
    const isDone = sets.length > 0;
    
    const div = document.createElement("div");
    div.className = "neo-card bg-white mb-2 p-2";
    div.innerHTML = `
      <div class="row">
        <strong>${ex.name}</strong>
        <button class="btn-ghost" onclick="openLogger('${exId}')">${isDone ? 'EDIT' : 'LOG'}</button>
      </div>
      <div class="muted small">${sets.length} sets logged</div>
      `;
    list.appendChild(div);
  });
}

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
    headers.querySelector(".h-val-2").textContent = "KM";
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
    if (lastSession) {
      $("#prevSessionInfo").textContent = `Last time: ${new Date(lastSession.date).toLocaleDateString()} (${lastSession.sets.length} sets)`;
      // Add rows for each set done last time
      lastSession.sets.forEach(s => addLogRow(ex, s, true));
    } else {
      $("#prevSessionInfo").textContent = "No history available.";
      addLogRow(ex);
    }
  } else {
    $("#prevSessionInfo").textContent = "Editing current session.";
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
    <input class="neo-input input-val-1 ${ghostClass}" type="number" step="${ex.increment || 1}" inputmode="decimal" ${valueStr1}>
    <input class="neo-input input-val-2 ${ghostClass}" type="number" inputmode="numeric" ${valueStr2}>
    <button class="btn-ghost text-red remove-row">✕</button>
  `;

  // Remove ghost class on input and filter non-numeric
  row.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("input", (e) => {
        inp.classList.remove("ghost-val");
        // Strip non-numeric characters (allow decimal point for weight)
        e.target.value = e.target.value.replace(/[^0-9.]/g, '');
      });
  });

  row.querySelector(".remove-row").addEventListener("click", () => row.remove());
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
            <span>${t.name} (${t.exercises.length} ex)</span>
            <button class="btn-ghost small text-red" onclick="deleteTemplate('${t.id}')">DEL</button>
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

// --- HISTORY & STATS ---
function renderHistory() {
  const cont = $("#historyLog");
  cont.innerHTML = "";
  
  DB.sessions.forEach(sess => {
    const div = document.createElement("div");
    div.className = "history-entry";
    
    const date = new Date(sess.start).toDateString();
    
    let details = "";
    (sess.order || []).forEach(exId => {
       const sets = sess.entries[exId];
       if(!sets) return;
       const exName = DB.exercises[exId]?.name || "Unknown";
       let badges = sets.map(s => {
           if(s.w) return `<span class="set-tag">${s.w}kg × ${s.r}</span>`;
           if(s.time) return `<span class="set-tag">${s.time}m / ${s.dist}km</span>`;
           return "";
       }).join("");
       details += `<div class="history-detail"><strong>${exName}</strong><br>${badges}</div>`;
    });
    
    div.innerHTML = `
      <div class="history-date">${date}</div>
      <div class="muted small">${(sess.order||[]).length} Exercises</div>
      ${details}
    `;
    cont.appendChild(div);
  });
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
    if(!exId) return;
    
    // Extract history
    const history = [];
    DB.sessions.slice().reverse().forEach(s => {
        if(s.entries && s.entries[exId]) {
            // Calculate 1RM estimate or max volume
            const bestSet = s.entries[exId].reduce((prev, curr) => {
                const w = parseFloat(curr.w || 0);
                return w > prev ? w : prev;
            }, 0);
            if(bestSet > 0) history.push({ date: s.start, val: bestSet });
        }
    });
    
    const ctx = $("#progChart").getContext("2d");
    if(history.length < 2) {
        // clear
        ctx.clearRect(0,0,300,150);
        return;
    }
    
    simpleLineChart(ctx, history.map((_,i)=>i), history.map(h=>h.val), "#000");
}

// --- EXPORT / IMPORT ---
const DATA_VERSION = 1;

$("#btnExportCSV").addEventListener("click", () => {
    let csv = "Date,Exercise,Set,Weight/Time,Reps/Dist\n";
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
function openExercisePicker(cb) {
    _pickerCallback = cb;
    $("#pickerModal").classList.remove("hidden");
    renderPickerList();
}

$("#pickerSearch").addEventListener("input", renderPickerList);

function renderPickerList() {
    const q = $("#pickerSearch").value.toLowerCase();
    const div = $("#pickerList");
    div.innerHTML = "";
    Object.values(DB.exercises).forEach(ex => {
        if(!ex.name.toLowerCase().includes(q)) return;
        const btn = document.createElement("div");
        btn.className = "picker-item";
        btn.textContent = ex.name;
        btn.onclick = () => {
            if(_pickerCallback) _pickerCallback(ex.id);
            $("#pickerModal").classList.add("hidden");
        };
        div.appendChild(btn);
    });
}

$("#pickerClose").addEventListener("click", () => $("#pickerModal").classList.add("hidden"));

// Theme Toggle
$("#btnTheme").addEventListener("click", () => {
   DB.user.theme = DB.user.theme === "light" ? "dark" : "light";
   document.body.className = `theme-${DB.user.theme}`;
   saveDB();
});

// Settings Modal
$("#btnSettings").addEventListener("click", () => {
  $("#settingsBodyweight").value = DB.user.bodyweight || "";
  $("#settingsModal").showModal();
});

$("#btnCloseSettings").addEventListener("click", () => {
  $("#settingsModal").close();
});

$("#btnSaveSettings").addEventListener("click", () => {
  const bw = parseFloat($("#settingsBodyweight").value);
  if (bw && bw > 0) {
    DB.user.bodyweight = bw;
  } else {
    delete DB.user.bodyweight;
  }
  saveDB();
  $("#settingsModal").close();
});

// Initialization
migrateExerciseCategories();
populateSelects();
renderCurrentTab("dashboard");
