const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const LiftLogDates = require('../dates.js');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.className = ''; this._html = ''; this.selected = new Map(); this.open = false; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = value; this.children = []; this.selected.clear(); }
  appendChild(child) { this.children.push(child); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(type, fn) { this.events[type] = fn; }
  querySelectorAll(selector) {
    const [tag, className] = selector.split('.');
    return this.children.flatMap(node => [
      ...((!tag || node.tagName === tag) && (!className || node.className.split(' ').includes(className)) ? [node] : []),
      ...node.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector)[0];
    if (found) return found;
    if (!this.selected.has(selector)) this.selected.set(selector, new Element('button'));
    return this.selected.get(selector);
  }
}

function database() {
  return { exercises: {
    bench: { id: 'bench', name: 'Bench <script>', type: 'strength', muscle: 'Chest' },
    bike: { id: 'bike', name: 'Bike', type: 'cardio', cardioMetric: 'km' }
  }, sessions: [
    { id: 'older', templateName: 'Chest & Arms', start: '2026-09-10T09:00:00Z', end: '2026-09-10T10:03:00Z',
      entries: { bench: [{ w: 60, r: 8, note: 'Slow <lower>' }] }, exerciseNotes: { bench: '<exercise note>' }, notes: '<workout note>' },
    { id: 'newest', templateName: '<Routine>', start: '2026-10-11T09:00:00Z', end: '2026-10-11T09:22:00Z',
      entries: { bike: [{ time: 22, dist: 5.5 }], bench: [{ w: 60, r: '' }] } },
    { id: 'middle', start: '2026-09-22T10:00:00Z', end: '2026-09-22T10:30:00Z', entries: { bench: [{ w: 0, r: 10 }] } }
  ] };
}

function historyHarness({ db = database(), confirm = async () => true } = {}) {
  const container = new Element(), edits = [], nodes = new Map([['#historyLog', container]]);
  const $ = key => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); };
  let writes = 0, dashboardRenders = 0;
  const context = vm.createContext({ DB: db, $, LiftLogDates, LiftLogLogging: require('../logging.js'), MUSCLE_COLORS: { Chest: '#E57373' },
    document: { createElement: tag => new Element(tag) }, getWeightUnit: () => 'kg', convertWeight: value => value,
    editCompletedWorkout: id => edits.push(id), askConfirm: confirm,
    saveDB: async () => { writes++; return true; }, renderDashboard: () => { dashboardRenders++; } });
  vm.runInContext(section('function escapeHTML(', 'function showNotice('), context);
  vm.runInContext(section('function renderHistory()', '// --- STATS CHART (Canvas) ---'), context);
  return { context, container, db, edits, render: () => context.renderHistory(),
    get writes() { return writes; }, get dashboardRenders() { return dashboardRenders; } };
}

test('History starts as collapsed, rounded month groups with nested native workout summaries', () => {
  const h = historyHarness(), before = JSON.stringify(h.db); h.render();
  const months = h.container.querySelectorAll('details.history-month');
  assert.deepEqual(months.map(node => node.dataset.month), ['2026-10', '2026-09']);
  assert.ok(months.every(node => !node.open && node.children[0].tagName === 'summary'));
  assert.match(months[0].children[0].innerHTML, /1 workout</);
  assert.match(months[1].children[0].innerHTML, /2 workouts</);
  const workouts = h.container.querySelectorAll('details.history-workout');
  assert.deepEqual(workouts.map(node => node.dataset.session), ['newest', 'middle', 'older']);
  assert.ok(workouts.every(node => !node.open && node.children[0].tagName === 'summary'));
  assert.match(workouts[0].children[0].innerHTML, /&lt;Routine&gt;/);
  assert.match(workouts[0].children[0].innerHTML, /22m · 1 exercise/);
  assert.match(workouts[1].children[0].innerHTML, /Freestyle/);
  assert.match(workouts[2].children[0].innerHTML, /1h 3m · 1 exercise/);
  assert.doesNotMatch(workouts[2].children[0].innerHTML, /EDIT|DELETE|workout note|Slow/);
  const details = workouts[2].children[1];
  assert.match(details.innerHTML, /60kg × 8/);
  assert.match(details.innerHTML, /Slow &lt;lower&gt;/);
  assert.match(details.innerHTML, /&lt;exercise note&gt;/);
  assert.match(details.innerHTML, /&lt;workout note&gt;/);
  assert.doesNotMatch(details.innerHTML, /<script>|<exercise note>|<workout note>/);
  assert.match(details.innerHTML, /EDIT WORKOUT/);
  assert.equal(JSON.stringify(h.db), before, 'Rendering cannot sort or change durable records.');
});

test('History preserves open months and workouts across re-renders while new workouts stay collapsed', () => {
  const h = historyHarness(); h.render();
  h.container.querySelectorAll('details.history-month')[1].open = true;
  h.container.querySelectorAll('details.history-workout')[2].open = true;
  h.db.sessions.push({ ...clone(h.db.sessions[0]), id: 'added', start: '2026-09-30T09:00:00Z', end: '2026-09-30T10:00:00Z' });
  h.render();
  assert.deepEqual(h.container.querySelectorAll('details.history-month').filter(node => node.open).map(node => node.dataset.month), ['2026-09']);
  assert.deepEqual(h.container.querySelectorAll('details.history-workout').filter(node => node.open).map(node => node.dataset.session), ['older']);
  const older = h.container.querySelectorAll('details.history-workout').find(node => node.dataset.session === 'older');
  older.children[1].querySelector('.history-edit').events.click();
  assert.deepEqual(h.edits, ['older']);
});

test('Delete targets the captured workout ID after an asynchronous confirmation even if order changes', async () => {
  let answer;
  const h = historyHarness({ confirm: () => new Promise(resolve => { answer = resolve; }) }); h.render();
  const target = h.container.querySelectorAll('details.history-workout').find(node => node.dataset.session === 'older');
  const pending = target.children[1].querySelector('.history-delete').events.click();
  h.db.sessions.unshift({ ...clone(h.db.sessions[0]), id: 'arrived' });
  answer(true); await pending;
  assert.deepEqual(h.db.sessions.map(session => session.id), ['arrived', 'newest', 'middle']);
  assert.equal(h.writes, 1); assert.equal(h.dashboardRenders, 1);
});

test('cancelling Delete preserves every workout and makes no storage write', async () => {
  const h = historyHarness({ confirm: async () => false }); const before = clone(h.db);
  await h.context.deleteWorkout('older');
  assert.deepEqual(h.db, before); assert.equal(h.writes, 0);
});

test('routine management lives exclusively in Library while Start Workout keeps Freestyle and routine cards', () => {
  const workout = html.slice(html.indexOf('<section id="tab-workout"'), html.indexOf('<section id="tab-exercises"'));
  const library = html.slice(html.indexOf('<section id="tab-exercises"'), html.indexOf('<section id="tab-history"'));
  assert.match(workout, /id="btnStartEmpty"/); assert.match(workout, /id="routineStartCards"/);
  assert.doesNotMatch(workout, /id="templateList"|id="btnNewTemplate"|MY ROUTINES/);
  for (const id of ['btnLibraryExercises', 'btnLibraryRoutines', 'libraryExercisesPanel', 'libraryRoutinesPanel', 'templateList', 'btnNewTemplate']) assert.match(library, new RegExp(`id="${id}"`));
  assert.match(html, /data-tab="exercises">LIBRARY<\/button>/);
  assert.match(library, /aria-controls="libraryRoutinesPanel"/);
  assert.match(library, /id="libraryRoutinesPanel"[^>]*hidden/);
});

test('Library switch exposes exactly one panel and renders current routines without resetting existing data', () => {
  const nodes = new Map(), renders = [];
  const $ = key => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); };
  const context = vm.createContext({ $, renderTemplates: () => renders.push('routines'), renderExerciseLibrary: () => renders.push('exercises') });
  vm.runInContext(section('function showLibraryView(', '// Helper to get latest bodyweight'), context);
  $('#btnLibraryRoutines').events.click();
  assert.equal($('#libraryExercisesPanel').hidden, true); assert.equal($('#libraryRoutinesPanel').hidden, false);
  assert.equal($('#btnLibraryRoutines').attrs['aria-pressed'], 'true');
  assert.equal($('#btnLibraryExercises').attrs['aria-pressed'], 'false');
  $('#btnLibraryExercises').events.click();
  assert.equal($('#libraryExercisesPanel').hidden, false); assert.equal($('#libraryRoutinesPanel').hidden, true);
  assert.deepEqual(renders, ['routines', 'exercises']);
});

function librarySwitchHarness() {
  const nodes = new Map(), focusCalls = [], document = { activeElement: null };
  const $ = key => {
    if (!nodes.has(key)) {
      const node = new Element();
      node.contains = target => node.children.includes(target);
      node.focus = options => { focusCalls.push({ key, options }); document.activeElement = node; };
      nodes.set(key, node);
    }
    return nodes.get(key);
  };
  const context = vm.createContext({ $, document, renderTemplates() {}, renderExerciseLibrary() {} });
  vm.runInContext(section('function showLibraryView(', '// Helper to get latest bodyweight'), context);
  return { $, document, focusCalls, context };
}

test('rapid Library reversals synchronously keep the selected button, panel and pill target in agreement', () => {
  const h = librarySwitchHarness();
  for (let index = 0; index < 101; index++) {
    const routines = index % 2 === 0;
    h.$(routines ? '#btnLibraryRoutines' : '#btnLibraryExercises').events.click();
    assert.equal(h.$('#librarySwitch').dataset.view, routines ? 'routines' : 'exercises');
    assert.equal(h.$('#libraryExercisesPanel').hidden, routines);
    assert.equal(h.$('#libraryRoutinesPanel').hidden, !routines);
    assert.equal(h.$('#btnLibraryExercises').attrs['aria-pressed'], String(!routines));
    assert.equal(h.$('#btnLibraryRoutines').attrs['aria-pressed'], String(routines));
  }
  assert.equal(h.focusCalls.length, 0, 'ordinary switching does not force focus or scroll');
});

test('Library arrows and Home/End move focus without scrolling; hiding a focused panel returns focus to its switch', () => {
  const h = librarySwitchHarness(), search = new Element('input');
  h.$('#libraryExercisesPanel').children.push(search); h.document.activeElement = search;
  h.$('#btnLibraryRoutines').events.click();
  assert.equal(h.document.activeElement, h.$('#btnLibraryRoutines'));
  assert.equal(h.focusCalls.at(-1).options.preventScroll, true);
  for (const [button, key, expected] of [
    ['Routines', 'ArrowLeft', 'exercises'], ['Exercises', 'ArrowRight', 'routines'],
    ['Routines', 'Home', 'exercises'], ['Exercises', 'End', 'routines'], ['Routines', 'ArrowRight', 'exercises']
  ]) {
    let prevented = false;
    h.$(`#btnLibrary${button}`).events.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.$('#librarySwitch').dataset.view, expected);
    assert.equal(h.document.activeElement, h.$(expected === 'routines' ? '#btnLibraryRoutines' : '#btnLibraryExercises'));
    assert.equal(h.focusCalls.at(-1).options.preventScroll, true);
  }
  h.$('#btnLibraryExercises').events.keydown({ key: 'ArrowRight', ctrlKey: true, preventDefault() { assert.fail('modified browser shortcuts stay available'); } });
  assert.equal(h.$('#librarySwitch').dataset.view, 'exercises');
});

test('editor keeps the Save action outside the scrolling fields and explains raw machine assistance', () => {
  const editor = html.slice(html.indexOf('<div id="addExModal"'), html.indexOf('<div id="templateBuilderModal"'));
  assert.match(editor, /role="dialog" aria-modal="true" aria-labelledby="exModalTitle"/);
  assert.match(editor, /aria-label="Close exercise editor"/);
  assert.match(editor, /class="exercise-field">Equipment/);
  assert.match(editor, /id="muscleSelectWrapper" class="exercise-field">Muscle/);
  assert.doesNotMatch(editor, /Primary muscle|>Equip </);
  const footer = editor.slice(editor.indexOf('<footer'));
  assert.match(footer, /id="btnSaveEx" class="btn-red full"/);
  assert.match(footer, /id="btnDeleteEx"/);
  assert.match(editor, /id="newExLoadType"/);
  assert.match(source, /Enter machine assistance\. The estimate is workout bodyweight minus assistance/);
  const editorCode = section('function openNewExerciseModal(', '// --- WORKOUT LOGGING ---');
  assert.doesNotMatch(editorCode, /getLatestBodyweight|DB\.bodyweight/);
});

test('History labels raw assistance, added weight and reps-only sets individually without reinterpreting legacy rows', () => {
  const db=database(); db.exercises.bench.loadType='weighted'; db.exercises.bench.isAssisted=true;
  db.sessions=[{id:'mixed',start:'2026-10-12',entries:{bench:[
    {w:18,r:8}, {w:10,r:8,loadType:'weighted',bodyweightKg:80,bodyweightDate:'2026-10-12'},
    {w:0,r:8,loadType:'bodyweight',bodyweightKg:80,bodyweightDate:'2026-10-12'}
  ]}}];
  const h=historyHarness({db}); const before=clone(db); h.render();
  const body=h.container.querySelectorAll('details.history-workout')[0].children[1].innerHTML;
  assert.match(body,/18kg assistance × 8/); assert.match(body,/10kg added × 8/); assert.match(body,/Bodyweight × 8/);
  assert.match(body,/≈ 90kg estimated load/); assert.match(body,/≈ 80kg estimated load/);
  assert.doesNotMatch(body,/62kg/); assert.deepEqual(db,before);
});
