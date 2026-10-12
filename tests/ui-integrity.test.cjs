const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dates = require('../dates.js');
const logging = require('../logging.js');
const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness(db) {
  const calls = [];
  const ctx = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} received ${value}`);
      calls.push({ method: key, args });
    };
  } });
  function element() {
    let html = '';
    return {
      children: [], value: '', style: {}, textContent: '', dataset: {},
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; this.children = []; this.value = ''; },
      get options() { return this.children; },
      appendChild(child) { this.children.push(child); if (!this.value && child.value) this.value = child.value; },
      addEventListener() {}, querySelector: () => element(), querySelectorAll: () => [],
      classList: { contains: () => false, toggle() {} },
      getBoundingClientRect: () => ({ width: 400, height: 260 }), getContext: () => ctx
    };
  }
  const nodes = {};
  const $ = selector => nodes[selector] || (nodes[selector] = element());
  const sandbox = {
    LiftLogTheme: require('./helpers/theme-runtime.cjs')(), LiftLogUpdates: {notifySafe() {}}, DB: db, LiftLogDates: dates, LiftLogLogging: logging, LiftLogExerciseLoad: require('../exercise-load.js'), $, document: { createElement: element, querySelector: $, body: element() },
    window: { devicePixelRatio: 1 }, _libraryFilter: 'All', _exerciseHistoryExpanded: false, MUSCLE_COLORS: {},
    getWeightUnit: () => db.user.useLbs ? 'lbs' : 'kg', convertWeight: value => db.user.useLbs ? Number((Number(value) * 2.20462).toFixed(1)) : Number(value),
    findLastSessionWithExercise: id => logging.findLast(id, db.exercises[id], db.sessions),
    getLatestBodyweight: () => db.bodyweight.at(-1)?.kg,
    renderLibraryTabs() {}, renderTemplates() {}, drawBodyweightChart() {}, renderBodyweightEntries() {}, updateBodyweightUnitLabel() {},
    renderBreakdownChart() {}, formatAxisValue: value => String(value)
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('// --- MODAL WORKFLOW HELPERS ---'), source.indexOf('// --- TABS & NAVIGATION ---')), sandbox);
  vm.runInContext(section('function escapeHTML(', 'function showNotice('), sandbox);
  const html = node => node.innerHTML + node.children.map(html).join('');
  return { sandbox, nodes, calls, $, html };
}

function database() {
  return { user: { useLbs: false }, exercises: {}, sessions: [], bodyweight: [] };
}

test('exercise library treats imported muscle/metric/name strings as text and shows zero-weight sets', () => {
  const db = database();
  const attack = '<img src=x onerror="bad()">';
  db.exercises.pushup = { id: 'pushup', name: `Pushup ${attack}`, type: 'strength', muscle: attack };
  db.exercises.run = { id: 'run', name: 'Run', type: 'cardio', cardioMetric: attack };
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', order: ['pushup', 'run'], entries: {
    pushup: [{ w: 0, r: 12 }], run: [{ time: '5.5', dist: '1.5' }]
  } }];
  const h = harness(db);
  vm.runInContext(section('function renderExerciseLibrary()', '// Populate Dropdowns'), h.sandbox);
  h.sandbox.renderExerciseLibrary();
  const output = h.html(h.$('#exerciseList'));
  assert.doesNotMatch(output, /<img/);
  assert.match(output, /&lt;img/);
  assert.match(output, /0kg × 12/);
  assert.match(output, /5\.5m \/ 1\.5&lt;img/);
});

test('stats selection refreshes names/additions and retains historical archived lifts and valid selection', () => {
  const db = database();
  db.exercises.bench = { id: 'bench', name: 'Bench', type: 'strength' };
  db.exercises.old = { id: 'old', name: 'Old lift', type: 'strength', archived: true };
  db.exercises.unused = { id: 'unused', name: 'Unused archived lift', type: 'strength', archived: true };
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', entries: { old: [{ w: '20', r: '8' }] } }];
  const h = harness(db);
  h.sandbox.updateStatsChart = () => {};
  vm.runInContext(section('function renderStats()', 'function updateStatsChart()'), h.sandbox);
  h.sandbox.renderStats();
  const select = h.$('#statExSelect');
  assert.deepEqual(select.options.map(option => option.value), ['bench', 'old']);
  select.value = 'old';
  db.exercises.bench.name = 'Renamed bench';
  db.exercises.squat = { id: 'squat', name: 'Squat', type: 'strength' };
  h.sandbox.renderStats();
  assert.equal(select.value, 'old');
  assert.deepEqual(select.options.map(option => option.textContent), ['Renamed bench', 'Old lift (archived)', 'Squat']);
  select.value = 'bench';
  db.exercises.bench.archived = true;
  h.sandbox.renderStats();
  assert.equal(select.value, 'old', 'removed selection falls back to an available exercise');
});

test('history shows recorded assistance independently of current bodyweight and preserves archived metadata', () => {
  const db = database();
  db.exercises.pullup = { id: 'pullup', name: 'Assisted pullup', type: 'strength', isAssisted: true, archived: true };
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', order: ['pullup'], entries: { pullup: [{ w: '30', r: '8' }] }, exerciseNotes: { pullup: '<em>Note</em>' } }];
  db.bodyweight = [{ date: '2026-10-01T12:00:00Z', kg: 80 }];
  const before = JSON.stringify(db);
  const h = harness(db);
  vm.runInContext(section('function renderHistory()', 'async function deleteWorkout('), h.sandbox);
  h.sandbox.renderHistory();
  const original = h.html(h.$('#historyLog'));
  assert.match(original, /30kg assistance × 8/);
  assert.doesNotMatch(original, /50\.0kg eff/);
  assert.match(original, /Assisted pullup/);
  assert.match(original, /&lt;em&gt;Note&lt;\/em&gt;/);
  assert.equal(JSON.stringify(db), before);
  db.bodyweight.push({ date: '2026-10-11T12:00:00Z', kg: 90 });
  h.sandbox.renderHistory();
  assert.equal(h.html(h.$('#historyLog')), original);
  db.user.useLbs = true;
  h.sandbox.renderHistory();
  assert.match(h.html(h.$('#historyLog')), /66\.1lbs assistance × 8/);
});

test('stats history escapes imported cardio units and single-point charts never draw invalid coordinates', () => {
  const db = database();
  db.exercises.run = { id: 'run', name: 'Run', type: 'cardio', cardioMetric: '<img src=x>' };
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', entries: { run: [{ time: '10', dist: '1.5' }] } }];
  const h = harness(db);
  h.$('#statExSelect').value = 'run';
  h.$('#statChartType').value = 'maxWeight';
  vm.runInContext(section('function updateStatsChart()', '// --- EXPORT / IMPORT ---'), h.sandbox);
  h.sandbox.updateStatsChart();
  assert.doesNotMatch(h.$('#exerciseHistory').innerHTML, /<img/);
  assert.match(h.$('#exerciseHistory').innerHTML, /1\.5&lt;img/);
  assert.ok(h.calls.some(call => call.method === 'fillText' && call.args[0] === 'Need more data for chart'));
  db.exercises.run = { id: 'run', name: 'Bench', type: 'strength' };
  db.sessions[0].entries.run = [{ w: '60', r: '8' }];
  h.sandbox.updateStatsChart();
  assert.ok(h.calls.every(call => call.args.every(value => typeof value !== 'number' || Number.isFinite(value))));
});

test('shared weight formatters round only displayed kilograms and leave stored canonical values unchanged', () => {
  const db = database();
  const kg = String(100 / 2.20462);
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', entries: { bench: [{ w: kg, r: '8' }] } }];
  const before = JSON.stringify(db);
  const h = harness(db);
  h.sandbox.KG_TO_LBS = 2.20462;
  vm.runInContext(section('function convertWeight(', '// Format Y-axis'), h.sandbox);
  vm.runInContext(section('function formatWeight(', 'function formatWeightValue('), h.sandbox);
  assert.equal(h.sandbox.convertWeight(kg), 45.36);
  assert.equal(h.sandbox.formatWeight(kg), '45.36 kg');
  assert.equal(JSON.stringify(db), before);
  db.user.useLbs = true;
  assert.equal(h.sandbox.convertWeight(kg), 100);
});

test('History filters legacy blank/planned rows without rewriting the stored workout', () => {
  const db = database();
  db.exercises.real = { id: 'real', name: 'Real lift', type: 'strength' };
  db.exercises.blank = { id: 'blank', name: 'Blank lift', type: 'strength' };
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', order: ['real', 'blank'], entries: {
    real: [{ w: '20', r: '8' }, { w: '90', r: '8', completed: false }, { w: '', r: '' }],
    blank: [{ w: '', r: '' }]
  } }];
  const before = JSON.stringify(db);
  const h = harness(db);
  vm.runInContext(section('function renderHistory()', 'async function deleteWorkout('), h.sandbox);
  h.sandbox.renderHistory();
  const output = h.html(h.$('#historyLog'));
  assert.match(output, /class="history-summary-meta">1 exercise<\/span>/);
  assert.match(output, /20kg × 8/);
  assert.doesNotMatch(output, /90kg|Blank lift/);
  assert.equal(JSON.stringify(db), before);
});

function parseCSV(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(value); value = ''; }
    else if (!quoted && char === '\r' && text[i + 1] === '\n') {
      row.push(value); rows.push(row); row = []; value = ''; i++;
    } else value += char;
  }
  row.push(value); rows.push(row);
  return rows;
}

test('CSV round-trips punctuation/newlines/zero weight in kg regardless of display units', () => {
  const db = database();
  db.user.useLbs = true;
  const name = 'Press, "paused" & strict\nvariation';
  db.exercises.bench = { id: 'bench', name, type: 'strength' };
  db.sessions = [{ id: 'session', start: '2026-10-01T12:00:00Z', templateName: 'Push, A',
    order: ['bench'], notes: 'Set one\nSet two', exerciseNotes: { bench: 'Keep "steady"' },
    entries: { bench: [{ w: 0, r: 12 }, { w: 62.5, r: 8 }] } }];
  db.bodyweight = [{ date: '2026-10-01T12:00:00Z', kg: 80 }];
  const before = JSON.stringify(db);
  const h = harness(db);
  vm.runInContext(section('function csvCell(', '$("#btnExportCSV").addEventListener'), h.sandbox);
  const output = h.sandbox.exportCSV();
  const rows = parseCSV(output);
  assert.equal(rows[0][4], 'Weight (kg)');
  assert.equal(rows[1].length, 15);
  assert.equal(rows[1][1], 'Push, A');
  assert.equal(rows[1][2], name);
  assert.equal(rows[1][4], '0');
  assert.equal(rows[2][4], '62.5');
  assert.equal(rows[1][9], 'Set one\nSet two');
  assert.equal(rows[1][10], 'Keep "steady"');
  assert.equal(rows.at(-1)[1], '80');
  assert.doesNotMatch(output, /&amp;|undefined/);
  assert.equal(JSON.stringify(db), before);
  assert.equal(h.sandbox.csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
});

test('actual Save/Close remain correct when the persistence adapter replaces ACTIVE_SESSION copies', async () => {
  const db = database();
  db.exercises.bench = { id: 'bench', name: 'Bench', type: 'strength' };
  const h = harness(db);
  const clone = value => JSON.parse(JSON.stringify(value));
  let snapshot = { db, draft: { id: 'active', start: '2026-10-01T12:00:00Z', order: ['bench'], entries: {}, logDrafts: {}, exerciseNotes: {} }, revision: 1, epoch: 1 };
  h.sandbox.LiftLogStorage = {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    async saveDraft(edited) { await Promise.resolve(); snapshot = { ...snapshot, draft: clone(edited), revision: snapshot.revision + 1 }; return clone(snapshot); }
  };
  h.sandbox.renderActiveSession = () => {};
  h.sandbox.setTimeout = setTimeout;
  h.sandbox.clearTimeout = clearTimeout;
  const inputA = { value: '100', focus() {} }, inputB = { value: '', focus() {} };
  const row = { _sourceRow: {}, querySelector: selector => selector === '.input-val-1' ? inputA : inputB };
  h.sandbox.$$ = selector => selector === '#logRows .log-row' ? [row] : [inputA, inputB];
  h.$('#logModal').classList.add = () => {};
  h.sandbox.initialSnapshot = clone(snapshot);
  vm.runInContext(source.slice(0, source.indexOf('// --- DOM HELPERS ---')), h.sandbox);
  vm.runInContext(section('let CURRENT_LOG_EX = null;', '// --- TEMPLATES ---'), h.sandbox);
  vm.runInContext("applySnapshot(initialSnapshot); CURRENT_LOG_EX = 'bench'; CURRENT_LOG_UNIT = 'lbs'; globalThis.originalDraft = ACTIVE_SESSION;", h.sandbox);
  h.$('#logNotes').value = 'Unfinished note';
  await h.sandbox.closeLogger();
  assert.equal(snapshot.draft.logDrafts.bench.rows[0].a, '100');
  assert.equal(snapshot.draft.entries.bench, undefined);
  assert.equal(vm.runInContext('ACTIVE_SESSION !== originalDraft', h.sandbox), true);
  vm.runInContext("CURRENT_LOG_EX = 'bench'; CURRENT_LOG_UNIT = 'lbs';", h.sandbox);
  inputB.value = '8';
  h.$('#logNotes').value = 'Saved note';
  await h.sandbox.saveLog();
  assert.equal(snapshot.draft.logDrafts.bench, undefined);
  assert.equal(snapshot.draft.exerciseNotes.bench, 'Saved note');
  assert.equal(logging.displayWeight(snapshot.draft.entries.bench[0].w, 'lbs'), 100);
  assert.equal(vm.runInContext('ACTIVE_SESSION.exerciseNotes.bench', h.sandbox), 'Saved note');
});

test('CSV preserves raw assistance and exports only saved bodyweight estimates',()=>{
  const db=database();db.exercises.dip={id:'dip',name:'Assisted dip',type:'strength',isAssisted:true,loadType:'weighted'};
  db.sessions=[{id:'one',start:'2026-10-01T12:00:00Z',order:['dip'],entries:{dip:[{w:18,r:8},{w:18,r:8,loadType:'assisted',bodyweightKg:80,bodyweightDate:'2026-09-30'},{w:10,r:8,loadType:'weighted',bodyweightKg:80,bodyweightDate:'2026-09-30'}]}}];
  db.bodyweight=[{date:'2026-10-12',kg:100}];const h=harness(db);vm.runInContext(section('function csvCell(', '$("#btnExportCSV").addEventListener'),h.sandbox);const rows=parseCSV(h.sandbox.exportCSV());
  assert.equal(rows[1][4],'18');assert.equal(rows[1][11],'assisted');assert.equal(rows[1][14],'');
  assert.equal(rows[2][4],'18');assert.equal(rows[2][12],'80');assert.equal(rows[2][14],'62');assert.equal(rows[3][14],'90');
});
