/***************
 * LiftLog MVP
 * Offline-first, localStorage DB, PWA
 ***************/

const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const LS_KEY = "liftlog_db_v1";

const $ = (sel) => document.querySelector(sel);

function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function todayISO() { return new Date().toISOString().slice(0,10); }
function prettyDate(iso){
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday:"short", year:"numeric", month:"short", day:"numeric" });
}

function loadDB(){
  const raw = localStorage.getItem(LS_KEY);
  if (raw) return JSON.parse(raw);
  const db = {
    exercises: {}, // id -> {id,name,equip,repMin,repMax,incKg}
    routine: Object.fromEntries(DAYS.map(d => [d, []])), // day -> [exerciseId,...]
    sessions: [] // {id,date,day,entries:{ exerciseId: [ {w,r}, ... ] }}
  };
  saveDB(db);
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

$("#todayDay").value = DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1]; // JS: Sun=0
$("#routineDay").value = $("#todayDay").value;

/***************
 * Exercises
 ***************/
function defaultIncForEquip(equip){
  if (equip === "barbell") return 2.5;
  if (equip === "dumbbell") return 2.0;
  if (equip === "machine" || equip === "cable") return 1.0;
  if (equip === "bodyweight") return 0;
  return 1.0;
}

$("#exEquip").addEventListener("change", ()=>{
  $("#exInc").value = defaultIncForEquip($("#exEquip").value);
});

$("#btnAddExercise").addEventListener("click", ()=>{
  const name = $("#exName").value.trim();
  if (!name) return alert("Give the exercise a name.");
  const equip = $("#exEquip").value;
  const repMin = parseInt($("#exRepMin").value,10) || 8;
  const repMax = parseInt($("#exRepMax").value,10) || 12;
  const incKg = parseFloat($("#exInc").value) || defaultIncForEquip(equip);

  const id = uid();
  DB.exercises[id] = { id, name, equip, repMin, repMax, incKg };
  saveDB(DB);

  $("#exName").value = "";
  renderAll();
});

function deleteExercise(id){
  if (!confirm("Delete this exercise? It will also disappear from your routine (history stays).")) return;
  delete DB.exercises[id];
  // remove from routine
  DAYS.forEach(d=>{
    DB.routine[d] = DB.routine[d].filter(x=>x!==id);
  });
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

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/***************
 * Routine
 ***************/
$("#btnAddToDay").addEventListener("click", ()=>{
  const day = $("#routineDay").value;
  const exIds = Object.keys(DB.exercises);
  if (exIds.length === 0) return alert("Add exercises first.");

  // Simple prompt picker (no fancy UI)
  const list = exIds.map((id,i)=>`${i+1}. ${DB.exercises[id].name}`).join("\n");
  const pick = prompt(`Type the number to add:\n\n${list}`);
  if (!pick) return;
  const idx = parseInt(pick,10)-1;
  if (Number.isNaN(idx) || idx<0 || idx>=exIds.length) return alert("Invalid choice.");
  DB.routine[day].push(exIds[idx]);
  saveDB(DB);
  renderAll();
});

function removeFromDay(day, exId){
  DB.routine[day] = DB.routine[day].filter(x=>x!==exId);
  saveDB(DB);
  renderAll();
}

function renderRoutine(){
  const day = $("#routineDay").value;
  const ul = $("#routineList");
  const ids = DB.routine[day] || [];

  if (ids.length === 0){
    ul.innerHTML = `<li class="li"><div class="muted">Nothing planned for ${day}. Tap “Add exercise”.</div></li>`;
    return;
  }

  ul.innerHTML = "";
  ids.forEach((exId, index)=>{
    const ex = DB.exercises[exId] || { name:"(deleted exercise)", equip:"" };
    const li = document.createElement("li");
    li.className = "li drag";
    li.draggable = true;
    li.dataset.exId = exId;
    li.dataset.index = String(index);
    li.innerHTML = `
      <div class="left">
        <div><strong>${escapeHtml(ex.name)}</strong></div>
        <div class="badge">${escapeHtml(ex.equip)} • ${ex.repMin ?? ""}${ex.repMax ? "–"+ex.repMax : ""}</div>
      </div>
      <button class="smallbtn" data-rm="${exId}">🗑️</button>
    `;
    ul.appendChild(li);
  });

  ul.querySelectorAll("[data-rm]").forEach(btn=>{
    btn.addEventListener("click", ()=>removeFromDay(day, btn.dataset.rm));
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
let ACTIVE_SESSION = null; // {id,date,day,entries:{}}

$("#btnStart").addEventListener("click", ()=>{
  const day = $("#todayDay").value;
  const planned = DB.routine[day] || [];
  if (planned.length === 0) return alert(`Nothing planned for ${day}. Add exercises in Routine.`);

  ACTIVE_SESSION = { id: uid(), date: todayISO(), day, entries: {} };
  $("#todayWorkout").classList.remove("hidden");
  renderTodayWorkout();
});

function renderToday(){
  const day = $("#todayDay").value;
  $("#todayTitle").textContent = `Today — ${day}`;
  const planned = DB.routine[day] || [];
  if (planned.length === 0){
    $("#todayEmpty").innerHTML = `<div><strong>No plan for ${day}</strong></div><div class="muted">Go to Routine tab and add exercises for this day.</div>`;
    $("#todayWorkout").classList.add("hidden");
  } else {
    $("#todayEmpty").innerHTML = `<div><strong>${planned.length} exercises planned</strong></div><div class="muted">Start workout, then tap an exercise to log sets.</div>`;
  }
}

function renderTodayWorkout(){
  const box = $("#todayWorkout");
  if (!ACTIVE_SESSION){
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  const planned = DB.routine[ACTIVE_SESSION.day] || [];
  box.innerHTML = `
    <div class="row">
      <div>
        <div><strong>Workout in progress</strong></div>
        <div class="muted">${prettyDate(ACTIVE_SESSION.date)} • ${ACTIVE_SESSION.day}</div>
      </div>
      <button id="btnFinish" class="primary">Finish</button>
    </div>
    <ul id="workoutList" class="list"></ul>
  `;
  const ul = box.querySelector("#workoutList");

  planned.forEach(exId=>{
    const ex = DB.exercises[exId] || { name:"(deleted exercise)", equip:"", repMin:8, repMax:12, incKg:2.5 };
    const count = (ACTIVE_SESSION.entries[exId] || []).length;
    const li = document.createElement("li");
    li.className = "li";
    li.innerHTML = `
      <div class="left">
        <div><strong>${escapeHtml(ex.name)}</strong> <span class="pill">${escapeHtml(ex.equip)}</span></div>
        <div class="badge">Target reps: ${ex.repMin}–${ex.repMax} • Logged sets: ${count}</div>
      </div>
      <button class="smallbtn" data-log="${exId}">Log</button>
    `;
    ul.appendChild(li);
  });

  box.querySelectorAll("[data-log]").forEach(btn=>{
    btn.addEventListener("click", ()=>openLogModal(btn.dataset.log));
  });

  box.querySelector("#btnFinish").addEventListener("click", finishWorkout);
}

function finishWorkout(){
  if (!ACTIVE_SESSION) return;
  // Only save if at least one set logged
  const didAnything = Object.values(ACTIVE_SESSION.entries).some(arr => (arr||[]).length > 0);
  if (!didAnything){
    if (!confirm("No sets logged. Discard this workout?")) return;
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

$("#btnCloseModal").addEventListener("click", closeModal);
$("#btnAddSet").addEventListener("click", ()=>addSetRow());
$("#btnSaveSets").addEventListener("click", saveModalSets);

function openLogModal(exId){
  if (!ACTIVE_SESSION) return;
  MODAL_EX_ID = exId;
  const ex = DB.exercises[exId] || { name:"(deleted exercise)", equip:"", repMin:8, repMax:12, incKg:2.5 };

  $("#modalTitle").textContent = ex.name;

  // Last time
  const last = findLastExerciseEntry(exId);
  if (!last){
    $("#lastTime").innerHTML = `<strong>Last time:</strong> <span class="muted">No history yet.</span>`;
  } else {
    const sets = last.sets.map((s,i)=>`Set ${i+1}: ${s.w} kg × ${s.r}`).join("<br/>");
    $("#lastTime").innerHTML = `<strong>Last time (${prettyDate(last.date)}):</strong><br/>${sets}`;
  }

  // Suggestion
  const suggestion = computeSuggestion(exId, last);
  $("#suggestion").innerHTML = `
    <div class="row">
      <div>
        <div><strong>Suggestion</strong></div>
        <div class="muted">${suggestion.explain}</div>
      </div>
      <div class="pill">${suggestion.weightText}</div>
    </div>
  `;

  // Pre-fill sets from current session (or copy last)
  $("#setsContainer").innerHTML = "";
  const current = ACTIVE_SESSION.entries[exId] || [];
  if (current.length > 0){
    current.forEach(s=>addSetRow(s.w, s.r));
  } else if (last && last.sets.length > 0){
    // copy last time as a starting point
    last.sets.forEach(s=>addSetRow(s.w, s.r));
  } else {
    addSetRow(suggestion.weight, ex.repMin);
    addSetRow(suggestion.weight, ex.repMin);
    addSetRow(suggestion.weight, ex.repMin);
  }

  $("#modal").classList.remove("hidden");
}

function closeModal(){
  MODAL_EX_ID = null;
  $("#modal").classList.add("hidden");
}

function addSetRow(w="", r=""){
  const wrap = document.createElement("div");
  wrap.className = "setrow";
  wrap.innerHTML = `
    <input class="setW" inputmode="decimal" placeholder="kg" value="${w ?? ""}">
    <input class="setR" inputmode="numeric" placeholder="reps" value="${r ?? ""}">
    <button class="smallbtn btnDel">✕</button>
  `;
  wrap.querySelector(".btnDel").addEventListener("click", ()=>wrap.remove());
  $("#setsContainer").appendChild(wrap);
}

function saveModalSets(){
  if (!ACTIVE_SESSION || !MODAL_EX_ID) return;
  const rows = Array.from(document.querySelectorAll("#setsContainer .setrow"));
  const sets = rows.map(row=>{
    const w = parseFloat(row.querySelector(".setW").value);
    const r = parseInt(row.querySelector(".setR").value,10);
    if (Number.isNaN(w) || Number.isNaN(r)) return null;
    return { w, r };
  }).filter(Boolean);

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

function computeSuggestion(exId, last){
  const ex = DB.exercises[exId] || { repMin:8, repMax:12, incKg:2.5, equip:"other" };

  // If no history: pick 0 for bodyweight, else blank (user decides)
  if (!last){
    const w = ex.equip === "bodyweight" ? 0 : "";
    return {
      weight: w,
      weightText: w === "" ? "Pick a weight" : `${w} kg`,
      explain: `Target ${ex.repMin}–${ex.repMax} reps. Add reps first, then weight when you hit the top.`
    };
  }

  // best set = highest reps; if tie, pick heavier
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

function roundToIncrement(val, inc){
  if (!inc || inc <= 0) return val;
  // round to nearest increment
  return Math.round(val / inc) * inc;
}

function renderHistory(){
  const wrap = $("#historyList");
  if (DB.sessions.length === 0){
    wrap.innerHTML = `<div class="card mutedbox"><strong>No workouts saved yet.</strong><div class="muted">Start one from Today.</div></div>`;
    return;
  }
  wrap.innerHTML = DB.sessions.slice(0,30).map(sess=>{
    const exCount = Object.keys(sess.entries || {}).length;
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
  // basic validation
  if (!next || typeof next !== "object" || !next.exercises || !next.routine || !next.sessions){
    return alert("That doesn't look like a LiftLog backup file.");
  }
  DB = next;
  saveDB(DB);
  alert("Imported.");
  renderAll();
  e.target.value = "";
});

/***************
 * Render all
 ***************/
$("#todayDay").addEventListener("change", ()=>renderAll());
$("#routineDay").addEventListener("change", ()=>renderAll());

function renderAll(){
  renderToday();
  renderTodayWorkout();
  renderRoutine();
  renderExerciseTable();
  renderHistory();
}

renderAll();
