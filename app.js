/***************
 * LiftLog MVP v2
 * Offline-first, localStorage DB, PWA
 * Now supports:
 * - Freestyle workouts (no plan required)
 * - Add exercises mid-workout
 * - Planned sets per exercise (routine + workout)
 * - No forced set entry when opening Log
 * - Modal hide bug fixed via CSS
 * - [NEW] Save active workout as future routine
 ***************/

const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const LS_KEY = "liftlog_db_v2";

const $ = (sel) => document.querySelector(sel);

function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function todayISO() { return new Date().toISOString().slice(0,10); }
function prettyDate(iso){
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday:"short", year:"numeric", month:"short", day:"numeric" });
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function defaultIncForEquip(equip){
  if (equip === "barbell") return 2.5;
  if (equip === "dumbbell") return 2.0;
  if (equip === "machine" || equip === "cable") return 1.0;
  if (equip === "bodyweight") return 0;
  return 1.0;
}

function normalizeRoutineDay(arr){
  // v1: ["exId","exId"]
  // v2: [{exId, sets}]
  if (!Array.isArray(arr)) return [];
  if (arr.length === 0) return [];
  if (typeof arr[0] === "string"){
    return arr.map(exId => ({ exId, sets: 3 }));
  }
  // if already objects
  return arr
    .filter(x => x && typeof x === "object" && x.exId)
    .map(x => ({ exId: x.exId, sets: Number.isFinite(+x.sets) ? +x.sets : 3 }));
}

function migrateDB(db){
  if (!db || typeof db !== "object") return null;

  // Ensure base structure
  db.exercises = db.exercises || {};
  db.routine = db.routine || Object.fromEntries(DAYS.map(d => [d, []]));
  db.sessions = Array.isArray(db.sessions) ? db.sessions : [];

  // Normalize routine days
  for (const d of DAYS){
    db.routine[d] = normalizeRoutineDay(db.routine[d]);
  }

  // Sessions: add order if missing
  db.sessions = db.sessions.map(sess => {
    if (!sess || typeof sess !== "object") return sess;
    sess.entries = sess.entries || {};
    if (!Array.isArray(sess.order)){
      // best-effort: infer from stored entries keys
      const keys = Object.keys(sess.entries);
      sess.order = keys.map(exId => ({ exId, sets: 0 }));
    } else {
      sess.order = normalizeRoutineDay(sess.order);
    }
    return sess;
  });

  return db;
}

function loadDB(){
  const raw = localStorage.getItem(LS_KEY) || localStorage.getItem("liftlog_db_v1");
  if (raw){
    const parsed = JSON.parse(raw);
    const migrated = migrateDB(parsed);
    localStorage.setItem(LS_KEY, JSON.stringify(migrated));
    return migrated;
  }
  const db = {
    exercises: {}, // id -> {id,name,equip,repMin,repMax,incKg}
    routine: Object.fromEntries(DAYS.map(d => [d, []])), // day -> [{exId, sets}]
    sessions: [] // {id,date,day,order:[{exId,sets}], entries:{ exId:[{w,r}], ... }}
  };
  localStorage.setItem(LS_KEY, JSON.stringify(db));
  return db;
}
function saveDB(db){ localStorage.setItem(LS_KEY, JSON.stringify(db)); }

let DB = loadDB();

/***************
 * Tabs
 ***************/
document.querySelectorAll(".tab").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    renderAll();
  });
});

/***************
 * Populate selects
 ***************/
function fillDaySelect(selId){
  const sel = $(selId);
  sel.innerHTML = "";
  DAYS.forEach(d=>{
    const o = document.createElement("option");
    o.value = d; o.textContent = d;
    sel.appendChild(o);
  });
}
fillDaySelect("#todayDay");
fillDaySelect("#routineDay");

// Default selected day: today
$("#todayDay").value = DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
$("#routineDay").value = $("#todayDay").value;

/***************
 * Exercises
 ***************/
$("#exEquip").addEventListener("change", ()=>{
  $("#exInc").value = defaultIncForEquip($("#exEquip").value);
});

$("#btnAddExercise").addEventListener("click", ()=>{
  const name = $("#exName").value.trim();
  if (!name) return alert("Give the exercise a name.");
  const equip = $("#exEquip").value;
  const repMin = parseInt($("#exRepMin").value,10) || 8;
  const repMax = parseInt($("#exRepMax").value,10) || 12;
  const incKg = parseFloat($("#exInc").value);
  const finalInc = Number.isFinite(incKg) ? incKg : defaultIncForEquip(equip);

  const id = uid();
  DB.exercises[id] = { id, name, equip, repMin, repMax, incKg: finalInc };
  saveDB(DB);

  $("#exName").value = "";
  renderAll();
});

function deleteExercise(id){
  if (!confirm("Delete this exercise? It will also disappear from your routine (history stays).")) return;
  delete DB.exercises[id];
  // remove from routine
  for (const d of DAYS){
    DB.routine[d] = DB.routine[d].filter(x => x.exId !== id);
  }
  saveDB(DB);
  renderAll();
}

function renderExerciseTable(){
  const container = $("#exerciseTable");
  const ids = Object.keys(DB.exercises);
  if (ids.length === 0){
    container.innerHTML = `<div class="muted">No exercises yet. Add a few above.</div>`;
    return;
  }
  const rows = ids
    .map(id => DB.exercises[id])
    .sort((a,b)=>a.name.localeCompare(b.name))
    .map(ex => `
      <tr>
        <td>${escapeHtml(ex.name)}</td>
        <td><span class="pill">${escapeHtml(ex.equip)}</span></td>
        <td>${ex.repMin}–${ex.repMax}</td>
        <td>${ex.incKg}</td>
        <td><button class="smallbtn" data-del="${ex.id}">🗑️</button></td>
      </tr>
    `).join("");

  container.innerHTML = `
    <table class="table">
      <thead><tr><th>Name</th><th>Equip</th><th>Reps</th><th>Inc (kg)</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  container.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>deleteExercise(btn.dataset.del));
  });
}

/***************
 * Pickers
 ***************/
function sortedExerciseList(){
  return Object.values(DB.exercises).sort((a,b)=>a.name.localeCompare(b.name));
}

function pickExercisePrompt(){
  const list = sortedExerciseList();
  if (list.length === 0){
    alert("Add exercises first (Exercises tab).");
    return null;
  }
  const lines = list.map((ex,i)=>`${i+1}. ${ex.name} (${ex.equip})`).join("\n");
  const pick = prompt(`Type the number:\n\n${lines}`);
  if (!pick) return null;
  const idx = parseInt(pick,10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= list.length){
    alert("Invalid choice.");
    return null;
  }
  return list[idx].id;
}

function promptPlannedSets(defaultSets = 3){
  const raw = prompt(`Planned working sets? (default ${defaultSets})`, String(defaultSets));
  if (raw === null) return null;
  const n = parseInt(raw,10);
  if (Number.isNaN(n) || n < 0) return defaultSets;
  return n;
}

/***************
 * Routine
 ***************/
$("#btnAddToDay").addEventListener("click", ()=>{
  const day = $("#routineDay").value;
  const exId = pickExercisePrompt();
  if (!exId) return;

  const sets = promptPlannedSets(3);
  if (sets === null) return;

  DB.routine[day].push({ exId, sets });
  saveDB(DB);
  renderAll();
});

function removeFromDay(day, exId){
  DB.routine[day] = DB.routine[day].filter(x=>x.exId!==exId);
  saveDB(DB);
  renderAll();
}

function updateRoutineSets(day, exId, sets){
  const item = DB.routine[day].find(x=>x.exId===exId);
  if (!item) return;
  item.sets = sets;
  saveDB(DB);
}

function renderRoutine(){
  const day = $("#routineDay").value;
  const ul = $("#routineList");
  const items = DB.routine[day] || [];

  if (items.length === 0){
    ul.innerHTML = `<li class="li"><div class="muted">Nothing planned for ${day}. Tap “Add exercise”.</div></li>`;
    return;
  }

  ul.innerHTML = "";
  items.forEach((it, index)=>{
    const ex = DB.exercises[it.exId] || { name:"(deleted exercise)", equip:"", repMin:8, repMax:12 };
    const li = document.createElement("li");
    li.className = "li drag";
    li.draggable = true;
    li.dataset.exId = it.exId;
    li.dataset.index = String(index);
    li.innerHTML = `
      <div class="left">
        <div><strong>${escapeHtml(ex.name)}</strong></div>
        <div class="badge">${escapeHtml(ex.equip)} • ${ex.repMin ?? ""}${ex.repMax ? "–"+ex.repMax : ""} reps</div>
      </div>
      <div class="inline">
        <label style="margin:0;color:var(--muted);font-size:12px;">Sets
          <input type="number" min="0" class="routineSets" value="${Number.isFinite(+it.sets) ? +it.sets : 3}">
        </label>
        <button class="smallbtn" data-rm="${it.exId}">🗑️</button>
      </div>
    `;
    ul.appendChild(li);
  });

  ul.querySelectorAll("[data-rm]").forEach(btn=>{
    btn.addEventListener("click", ()=>removeFromDay(day, btn.dataset.rm));
  });

  ul.querySelectorAll(".routineSets").forEach((inp, i)=>{
    inp.addEventListener("change", ()=>{
      const n = parseInt(inp.value,10);
      const sets = (Number.isNaN(n) || n < 0) ? 0 : n;
      inp.value = String(sets);
      const exId = items[i].exId;
      updateRoutineSets(day, exId, sets);
    });
  });

  // Drag & drop reorder
  let dragIndex = null;
  ul.querySelectorAll(".drag").forEach(li=>{
    li.addEventListener("dragstart", (e)=>{
      dragIndex = parseInt(li.dataset.index,10);
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    li.addEventListener("drop", (e)=>{
      e.preventDefault();
      const dropIndex = parseInt(li.dataset.index,10);
      if (dragIndex === null || dropIndex === dragIndex) return;

      const arr = DB.routine[day];
      const [moved] = arr.splice(dragIndex,1);
      arr.splice(dropIndex,0,moved);
      DB.routine[day] = arr;
      saveDB(DB);
      dragIndex = null;
      renderAll();
    });
  });
}

/***************
 * Today + Workout logging
 ***************/
let ACTIVE_SESSION = null; // {id,date,day,order:[{exId,sets}], entries:{}}

$("#btnStart").addEventListener("click", ()=>{
  const day = $("#todayDay").value;
  const planned = DB.routine[day] || [];

  if (planned.length === 0){
    const ok = confirm(`No plan for ${day}.\n\nStart a freestyle workout and add exercises as you go?`);
    if (!ok) return;
    ACTIVE_SESSION = { id: uid(), date: todayISO(), day, order: [], entries: {} };
  } else {
    // copy routine into workout order
    ACTIVE_SESSION = {
      id: uid(),
      date: todayISO(),
      day,
      order: planned.map(it => ({ exId: it.exId, sets: Number.isFinite(+it.sets) ? +it.sets : 3 })),
      entries: {}
    };
  }

  $("#todayWorkout").classList.remove("hidden");
  renderTodayWorkout();
});

function renderToday(){
  const day = $("#todayDay").value;
  $("#todayTitle").textContent = `Today — ${day}`;

  const planned = DB.routine[day] || [];

  if (ACTIVE_SESSION){
    $("#todayHint").textContent = "Workout in progress.";
  } else if (planned.length === 0){
    $("#todayHint").textContent = "No plan today — start freestyle and add exercises when you want.";
  } else {
    $("#todayHint").textContent = `${planned.length} exercises planned.`;
  }

  if (!ACTIVE_SESSION && planned.length === 0){
    $("#todayEmpty").innerHTML = `
      <div><strong>No plan for ${day}</strong></div>
      <div class="muted">You can still Start Workout to run freestyle, then “+ Add exercise”.</div>
    `;
    $("#todayWorkout").classList.add("hidden");
  } else if (!ACTIVE_SESSION && planned.length > 0){
    $("#todayEmpty").innerHTML = `
      <div><strong>${planned.length} exercises planned</strong></div>
      <div class="muted">Start workout, then tap an exercise to log sets.</div>
    `;
    $("#todayWorkout").classList.add("hidden");
  } else {
    $("#todayEmpty").innerHTML = "";
  }
}

function addExerciseToActiveSession(){
  if (!ACTIVE_SESSION) return;
  const exId = pickExercisePrompt();
  if (!exId) return;

  if (ACTIVE_SESSION.order.some(x => x.exId === exId)){
    alert("That exercise is already in this workout.");
    return;
  }

  const sets = promptPlannedSets(3);
  if (sets === null) return;

  ACTIVE_SESSION.order.push({ exId, sets });
  renderTodayWorkout();
}

function updateActivePlannedSets(exId, sets){
  if (!ACTIVE_SESSION) return;
  const item = ACTIVE_SESSION.order.find(x => x.exId === exId);
  if (!item) return;
  item.sets = sets;
}

// *** NEW FUNCTION: Save current workout as future routine ***
function saveActiveAsRoutine() {
  if (!ACTIVE_SESSION) return;
  const day = ACTIVE_SESSION.day;
  
  // Confirm before overwriting
  const confirmed = confirm(
    `Save this workout as your default routine for ${day}?\n\n` +
    `Future ${day} workouts will start with these exercises in this order.`
  );
  if (!confirmed) return;

  // Create a clean copy of the current order (exId and sets)
  const newRoutine = ACTIVE_SESSION.order.map(item => ({
    exId: item.exId,
    sets: item.sets // Preserves the planned sets you adjusted during the workout
  }));

  // Update the DB
  DB.routine[day] = newRoutine;
  saveDB(DB);
  
  // Update UI to reflect changes
  renderAll();
  
  alert(`Saved! This is now your default plan for ${day}.`);
}

function renderTodayWorkout(){
  const box = $("#todayWorkout");
  if (!ACTIVE_SESSION){
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }

  box.innerHTML = `
    <div class="row">
      <div>
        <div><strong>Workout in progress</strong></div>
        <div class="muted">${prettyDate(ACTIVE_SESSION.date)} • ${escapeHtml(ACTIVE_SESSION.day)}</div>
      </div>
      <div class="row gap">
        <button id="btnAddExerciseToWorkout" class="ghost">+ Add exercise</button>
        <button id="btnFinish" class="primary">Finish</button>
      </div>
    </div>
    <hr class="hr">
    <div class="muted">Drag to reorder. Tap “Log” to enter sets (no sets are required).</div>
    <ul id="workoutList" class="list"></ul>
    
    <div class="row" style="margin-top:15px; justify-content:center;">
      <button id="btnSaveRoutine" class="ghost" style="width:100%; color:var(--accent); border-color:var(--border);">
        Save as ${ACTIVE_SESSION.day} Routine
      </button>
    </div>
  `;

  box.querySelector("#btnAddExerciseToWorkout").addEventListener("click", addExerciseToActiveSession);
  box.querySelector("#btnFinish").addEventListener("click", finishWorkout);
  
  // *** BIND THE NEW LISTENER ***
  box.querySelector("#btnSaveRoutine").addEventListener("click", saveActiveAsRoutine);

  const ul = box.querySelector("#workoutList");
  const items = ACTIVE_SESSION.order;

  if (items.length === 0){
    ul.innerHTML = `<li class="li"><div class="muted">No exercises yet. Tap “+ Add exercise”.</div></li>`;
    return;
  }

  ul.innerHTML = "";
  items.forEach((it, index)=>{
    const ex = DB.exercises[it.exId] || { name:"(deleted exercise)", equip:"", repMin:8, repMax:12, incKg:2.5 };
    const logged = (ACTIVE_SESSION.entries[it.exId] || []).length;
    const plannedSets = Number.isFinite(+it.sets) ? +it.sets : 0;

    const li = document.createElement("li");
    li.className = "li drag";
    li.draggable = true;
    li.dataset.exId = it.exId;
    li.dataset.index = String(index);

    li.innerHTML = `
      <div class="left">
        <div><strong>${escapeHtml(ex.name)}</strong> <span class="pill">${escapeHtml(ex.equip)}</span></div>
        <div class="badge">Target reps: ${ex.repMin}–${ex.repMax} • Planned sets: ${plannedSets} • Logged: ${logged}</div>
      </div>
      <div class="inline">
        <label style="margin:0;color:var(--muted);font-size:12px;">Sets
          <input type="number" min="0" class="workoutSets" value="${plannedSets}">
        </label>
        <button class="smallbtn" data-log="${it.exId}">Log</button>
      </div>
    `;
    ul.appendChild(li);
  });

  // planned sets inputs
  ul.querySelectorAll(".workoutSets").forEach((inp, i)=>{
    inp.addEventListener("change", ()=>{
      const n = parseInt(inp.value,10);
      const sets = (Number.isNaN(n) || n < 0) ? 0 : n;
      inp.value = String(sets);
      const exId = items[i].exId;
      updateActivePlannedSets(exId, sets);
    });
  });

  // log buttons
  ul.querySelectorAll("[data-log]").forEach(btn=>{
    btn.addEventListener("click", ()=>openLogModal(btn.dataset.log));
  });

  // Drag & drop reorder within active workout
  let dragIndex = null;
  ul.querySelectorAll(".drag").forEach(li=>{
    li.addEventListener("dragstart", (e)=>{
      dragIndex = parseInt(li.dataset.index,10);
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    li.addEventListener("drop", (e)=>{
      e.preventDefault();
      const dropIndex = parseInt(li.dataset.index,10);
      if (dragIndex === null || dropIndex === dragIndex) return;

      const arr = ACTIVE_SESSION.order;
      const [moved] = arr.splice(dragIndex,1);
      arr.splice(dropIndex,0,moved);
      ACTIVE_SESSION.order = arr;
      dragIndex = null;
      renderTodayWorkout();
    });
  });
}

function finishWorkout(){
  if (!ACTIVE_SESSION) return;

  const didAnything = Object.values(ACTIVE_SESSION.entries).some(arr => (arr||[]).length > 0);
  if (!didAnything){
    const ok = confirm("No sets logged. Discard this workout?");
    if (!ok) return;
    ACTIVE_SESSION = null;
    renderAll();
    return;
  }

  DB.sessions.unshift(ACTIVE_SESSION);
  saveDB(DB);
  ACTIVE_SESSION = null;
  alert("Workout saved.");
  renderAll();
}

/***************
 * Modal logger
 ***************/
let MODAL_EX_ID = null;
let MODAL_LAST = null;
let MODAL_SUGGESTED_WEIGHT = "";

$("#btnCloseModal").addEventListener("click", closeModal);
$("#btnAddSet").addEventListener("click", ()=>addSetRow());
$("#btnSaveSets").addEventListener("click", saveModalSets);
$("#btnCopyLast").addEventListener("click", copyLastToModal);
$("#btnAdd3").addEventListener("click", addThreeSets);

function openLogModal(exId){
  if (!ACTIVE_SESSION) return;
  MODAL_EX_ID = exId;

  const ex = DB.exercises[exId] || { name:"(deleted exercise)", equip:"", repMin:8, repMax:12, incKg:2.5 };
  $("#modalTitle").textContent = ex.name;

  // planned sets from active session order
  const item = ACTIVE_SESSION.order.find(x => x.exId === exId);
  $("#plannedSets").value = item ? String(Number.isFinite(+item.sets) ? +item.sets : 0) : "0";

  // Last time
  MODAL_LAST = findLastExerciseEntry(exId);
  if (!MODAL_LAST){
    $("#lastTime").innerHTML = `<strong>Last time:</strong> <span class="muted">No history yet.</span>`;
  } else {
    const sets = MODAL_LAST.sets.map((s,i)=>`Set ${i+1}: ${s.w} kg × ${s.r}`).join("<br/>");
    $("#lastTime").innerHTML = `<strong>Last time (${prettyDate(MODAL_LAST.date)}):</strong><br/>${sets}`;
  }

  // Suggestion
  const suggestion = computeSuggestion(exId, MODAL_LAST);
  MODAL_SUGGESTED_WEIGHT = suggestion.weight;
  $("#suggestion").innerHTML = `
    <div class="row">
      <div>
        <div><strong>Suggestion</strong></div>
        <div class="muted">${suggestion.explain}</div>
      </div>
      <div class="pill">${suggestion.weightText}</div>
    </div>
  `;

  // Sets UI: DO NOT pre-fill unless sets already logged in this session
  $("#setsContainer").innerHTML = "";
  const current = ACTIVE_SESSION.entries[exId] || [];
  if (current.length > 0){
    current.forEach(s=>addSetRow(s.w, s.r));
  } else {
    // leave empty by default (your request)
    // user can press + Set or Copy last time
  }

  $("#modal").classList.remove("hidden");
}

function closeModal(){
  MODAL_EX_ID = null;
  MODAL_LAST = null;
  MODAL_SUGGESTED_WEIGHT = "";
  $("#modal").classList.add("hidden");
}

function addSetRow(w, r){
  const ex = DB.exercises[MODAL_EX_ID] || { repMin:8 };
  const suggestedW = (w !== undefined) ? w : (typeof MODAL_SUGGESTED_WEIGHT === "number" ? MODAL_SUGGESTED_WEIGHT : "");
  const suggestedR = (r !== undefined) ? r : ex.repMin;

  const wrap = document.createElement("div");
  wrap.className = "setrow";
  wrap.innerHTML = `
    <input class="setW" inputmode="decimal" placeholder="kg" value="${suggestedW ?? ""}">
    <input class="setR" inputmode="numeric" placeholder="reps" value="${suggestedR ?? ""}">
    <button class="smallbtn btnDel">✕</button>
  `;
  wrap.querySelector(".btnDel").addEventListener("click", ()=>wrap.remove());
  $("#setsContainer").appendChild(wrap);
}

function copyLastToModal(){
  if (!MODAL_LAST || !MODAL_LAST.sets) return alert("No last session to copy.");
  $("#setsContainer").innerHTML = "";
  MODAL_LAST.sets.forEach(s => addSetRow(s.w, s.r));
}

function addThreeSets(){
  const ex = DB.exercises[MODAL_EX_ID] || { repMin:8 };
  addSetRow(undefined, ex.repMin);
  addSetRow(undefined, ex.repMin);
  addSetRow(undefined, ex.repMin);
}

function saveModalSets(){
  if (!ACTIVE_SESSION || !MODAL_EX_ID) return;

  // planned sets update
  const ps = parseInt($("#plannedSets").value, 10);
  const plannedSets = (Number.isNaN(ps) || ps < 0) ? 0 : ps;
  $("#plannedSets").value = String(plannedSets);
  updateActivePlannedSets(MODAL_EX_ID, plannedSets);

  // read sets
  const rows = Array.from(document.querySelectorAll("#setsContainer .setrow"));
  const sets = rows.map(row=>{
    const w = parseFloat(row.querySelector(".setW").value);
    const r = parseInt(row.querySelector(".setR").value,10);
    if (Number.isNaN(w) || Number.isNaN(r)) return null;
    return { w, r };
  }).filter(Boolean);

  // allow empty sets (your request)
  ACTIVE_SESSION.entries[MODAL_EX_ID] = sets;

  renderTodayWorkout();
  closeModal();
}

/***************
 * History + helper lookups
 ***************/
function findLastExerciseEntry(exId){
  for (const sess of DB.sessions){
    const sets = (sess.entries && sess.entries[exId]) ? sess.entries[exId] : null;
    if (sets && sets.length) return { date: sess.date, sets };
  }
  return null;
}

function roundToIncrement(val, inc){
  if (!inc || inc <= 0) return val;
  return Math.round(val / inc) * inc;
}

function computeSuggestion(exId, last){
  const ex = DB.exercises[exId] || { repMin:8, repMax:12, incKg:2.5, equip:"other" };

  if (!last){
    const w = ex.equip === "bodyweight" ? 0 : "";
    return {
      weight: w,
      weightText: w === "" ? "Pick a weight" : `${w} kg`,
      explain: `Target ${ex.repMin}–${ex.repMax} reps. Add reps first, then weight when you hit the top.`
    };
  }

  // best set = highest reps; if tie, heavier
  const best = last.sets.reduce((a,b)=>{
    if (b.r > a.r) return b;
    if (b.r === a.r && b.w > a.w) return b;
    return a;
  }, last.sets[0]);

  let nextW = best.w;
  let explain = `Last best set: ${best.w} kg × ${best.r}. Target ${ex.repMin}–${ex.repMax}.`;

  if (best.r >= ex.repMax){
    nextW = roundToIncrement(best.w + ex.incKg, ex.incKg);
    explain += ` You hit the top of the range — go up by ${ex.incKg} kg.`;
  } else if (best.r < ex.repMin){
    nextW = roundToIncrement(best.w - ex.incKg, ex.incKg);
    explain += ` Below the range — drop by ${ex.incKg} kg.`;
  } else {
    explain += ` Stay at the same weight and try to add reps.`;
  }

  return {
    weight: nextW,
    weightText: `${nextW} kg`,
    explain
  };
}

function renderHistory(){
  const wrap = $("#historyList");
  if (DB.sessions.length === 0){
    wrap.innerHTML = `<div class="card mutedbox"><strong>No workouts saved yet.</strong><div class="muted">Start one from Today.</div></div>`;
    return;
  }
  wrap.innerHTML = DB.sessions.slice(0,30).map(sess=>{
    const exCount = (sess.order || []).length;
    const setCount = Object.values(sess.entries || {}).reduce((n,arr)=>n + (arr?.length||0), 0);
    return `
      <div class="card">
        <div class="row">
          <div>
            <div><strong>${prettyDate(sess.date)}</strong> <span class="pill">${escapeHtml(sess.day || "")}</span></div>
            <div class="muted">${exCount} exercises • ${setCount} sets</div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/***************
 * Export / Import
 ***************/
$("#btnExport").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liftlog-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("#fileImport").addEventListener("change", async (e)=>{
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const next = JSON.parse(text);

  if (!next || typeof next !== "object" || !next.exercises || !next.routine || !next.sessions){
    return alert("That doesn't look like a LiftLog backup file.");
  }

  DB = migrateDB(next);
  saveDB(DB);
  alert("Imported.");
  renderAll();
  e.target.value = "";
});

/***************
 * Wire up day select changes
 ***************/
$("#todayDay").addEventListener("change", ()=>renderAll());
$("#routineDay").addEventListener("change", ()=>renderAll());

/***************
 * Render all
 ***************/
function renderAll(){
  renderToday();
  renderTodayWorkout();
  renderRoutine();
  renderExerciseTable();
  renderHistory();
}

renderAll();
