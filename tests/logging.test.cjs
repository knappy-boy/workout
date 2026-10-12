const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const logging = require('../logging.js');
const dates = require('../dates.js');
const strength = { type: 'strength' };
const cardio = { type: 'cardio', cardioMetric: 'km' };

test('100 lb is stored as kg and displayed as 100 lb, rather than converted twice', () => {
  const result = logging.parseRows(strength, [{ a: '100', b: '8' }], 'lbs');
  assert.equal(result.error, null);
  assert.ok(Math.abs(Number(result.entries[0].w) - 45.3592909436) < 0.000001);
  assert.equal(logging.rowsFromSets(strength, result.entries, 'lbs')[0].a, '100');
});

test('kilogram fields keep conversion decimals readable without changing the stored value', () => {
  const result = logging.parseRows(strength, [{ a: '100', b: '8' }], 'lbs');
  const rows = logging.rowsFromSets(strength, result.entries, 'kg');
  assert.equal(rows[0].a, '45.36');
  assert.deepEqual(logging.parseRows(strength, rows, 'kg').entries, result.entries);
});

test('editing old string/numeric weights repeatedly in pounds preserves exact kg and metadata', () => {
  let sets = [{ w: '62.5', r: '8', note: 'Pause', type: 'working' }, { w: 35.125, r: 6, custom: { source: 'legacy' } }];
  const original = JSON.stringify(sets);
  for (let i = 0; i < 100; i++) {
    const rows = logging.rowsFromSets(strength, sets, 'lbs');
    sets = logging.parseRows(strength, rows, 'lbs').entries;
  }
  assert.equal(JSON.stringify(sets), original);
});

test('changed weight converts once while a reps-only edit retains original canonical kg', () => {
  const row = logging.rowsFromSets(strength, [{ w: '62.5', r: '8' }], 'lbs')[0];
  row.b = '9';
  assert.deepEqual(logging.parseRows(strength, [row], 'lbs').entries, [{ w: '62.5', r: '9' }]);
  row.a = '140';
  const changed = logging.parseRows(strength, [row], 'lbs').entries[0];
  assert.ok(Math.abs(Number(changed.w) - 140 / 2.20462) < 1e-10);
});

test('blank rows remain unlogged and explicit zero weight supports bodyweight sets', () => {
  assert.deepEqual(logging.parseRows(strength, [{ a: '', b: '' }, { a: ' ', b: '' }], 'kg').entries, []);
  assert.deepEqual(logging.parseRows(strength, [{ a: '0', b: '12' }], 'kg').entries, [{ w: '0', r: '12' }]);
});

test('adding a strength row repeats only the last current weight, leaving reps uncompleted', () => {
  const rows = [{ a: '40', b: '8' }, { a: '60.5', b: '7', originalSet: { w: '60', r: '8', note: 'Old' } }];
  const before = JSON.stringify(rows);
  const next = logging.nextRow(strength, rows);
  assert.deepEqual(next, { a: '60.5', b: '' });
  assert.equal(JSON.stringify(rows), before);
  assert.match(logging.parseRows(strength, [next], 'kg').error, /enter weight and reps/);
  assert.deepEqual(logging.nextRow(strength, [...rows, next]), next);
  next.b = '6';
  assert.deepEqual(logging.parseRows(strength, [next], 'kg').entries, [{ w: '60.5', r: '6' }]);
});

test('next row respects edited and blank current weights and keeps cardio blank', () => {
  assert.deepEqual(logging.nextRow(strength, []), { a: '', b: '' });
  assert.deepEqual(logging.nextRow(strength, [{ a: '60.5', b: '8' }, { a: '', b: '' }]), { a: '', b: '' });
  assert.deepEqual(logging.nextRow(strength, [{ a: '0', b: '10' }]), { a: '0', b: '' });
  assert.deepEqual(logging.nextRow(strength, [{ a: '60,5', b: '' }]), { a: '60,5', b: '' });
  assert.deepEqual(logging.nextRow(cardio, [{ a: '12.5', b: '1.2' }]), { a: '', b: '' });
});

test('copying only weight from an old pounds set preserves kg precision but not old metadata', () => {
  const previous = logging.rowsFromSets(strength, [{ w: '62.5', r: '8', completed: true, note: 'Old' }], 'lbs')[0];
  const next = logging.nextRow(strength, [previous]);
  assert.equal(next.a, '137.8');
  next.b = '6';
  assert.deepEqual(logging.parseRows(strength, [next], 'lbs').entries, [{ w: '62.5', r: '6' }]);
  previous.a = '140';
  const edited = { ...logging.nextRow(strength, [previous]), b: '5' };
  assert.ok(Math.abs(Number(logging.parseRows(strength, [edited], 'lbs').entries[0].w) - 140 / 2.20462) < 1e-10);
});

test('Copy Last keeps strength weights and set count but clears every rep and prior-workout metadata', () => {
  for (const mode of ['external', 'assisted', 'weighted', 'bodyweight']) {
    const exercise = {type: 'strength', loadType: mode};
    const sets = [{w: mode === 'bodyweight' ? 0 : '62.5', r: '8', loadType: mode, bodyweightKg: 75,
      bodyweightDate: '2026-04-01', bodyweightSourceId: 'old', note: 'Old note', completed: true},
      {w: mode === 'bodyweight' ? 0 : 60, r: 6, loadType: mode}];
    const before = JSON.stringify(sets), rows = logging.rowsForCopy(exercise, sets, 'lbs');
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.b === '' && row.loadType === mode));
    assert.ok(rows.every(row => !row.originalSet && !row.bodyweightKg && !row.note && !row.completed));
    assert.equal(rows[0].a, mode === 'bodyweight' ? '' : '137.8');
    rows[0].b = '7'; rows[1].b = '5';
    const next = logging.parseRows(exercise, rows, 'lbs', {snapshotNew: true, bodyweightSnapshot: {kg: 80, date: '2026-10-12'}});
    assert.equal(next.error, null); assert.equal(next.entries[0].r, '7');
    assert.equal(next.entries[0].w, mode === 'bodyweight' ? 0 : '62.5');
    if (mode !== 'external') { assert.equal(next.entries[0].bodyweightKg, 80); assert.equal(next.entries[0].bodyweightDate, '2026-10-12'); }
    assert.equal(JSON.stringify(sets), before);
  }
  assert.deepEqual(logging.rowsForCopy(cardio, [{time: '12.5', dist: '1.5', note: 'Old'}], 'kg'), [{a: '12.5', b: '1.5'}]);
});

test('swap planning preserves source work and exercises already in the workout without duplicating them', () => {
  const session = {order: ['squat', 'bench', 'row'], entries: {}, exerciseNotes: {}, logDrafts: {bench: {rows: [{a: '', b: ''}], notes: ''}}};
  assert.deepEqual(logging.planExerciseSwap(session, 'bench', 'press'), {order: ['squat', 'press', 'row'], keepSource: false, alreadyPresent: false});
  session.logDrafts.bench.rows[0].a = '62.5';
  assert.deepEqual(logging.planExerciseSwap(session, 'bench', 'press'), {order: ['squat', 'bench', 'press', 'row'], keepSource: true, alreadyPresent: false});
  assert.deepEqual(logging.planExerciseSwap(session, 'bench', 'row'), {order: session.order, keepSource: true, alreadyPresent: true});
  assert.deepEqual(session.order, ['squat', 'bench', 'row']);
  assert.equal(logging.planExerciseSwap(session, 'missing', 'press'), null);
});

function styleStub(initial = {}) {
  const values = new Map(Object.entries(initial).map(([name, value]) => [name, { value, priority: '' }]));
  return {
    getPropertyValue: name => values.get(name)?.value || '',
    getPropertyPriority: name => values.get(name)?.priority || '',
    setProperty: (name, value, priority = '') => values.set(name, { value, priority }),
    removeProperty: name => values.delete(name)
  };
}

test('body remains fixed through nested modal locks and returns to its original scroll position and styles', () => {
  const body = styleStub({ position: 'relative', width: '80%', overflow: 'hidden' });
  body.setProperty('top', '2px', 'important');
  const html = styleStub({ 'scroll-behavior': 'smooth' });
  const scrolls = [];
  const win = { scrollX: 3, scrollY: 420, scrollTo: (x, y) => {
    assert.equal(body.getPropertyValue('position'), 'relative');
    assert.equal(html.getPropertyValue('scroll-behavior'), 'auto');
    scrolls.push([x, y]);
  } };
  const lock = logging.createScrollLock(win, { body: { style: body }, documentElement: { style: html } });
  lock.acquire('logger');
  assert.equal(body.getPropertyValue('position'), 'fixed');
  assert.equal(body.getPropertyValue('top'), '-420px');
  assert.equal(body.getPropertyValue('left'), '-3px');
  assert.equal(html.getPropertyValue('overflow'), 'hidden');
  win.scrollY = 0;
  lock.acquire('logger');
  lock.acquire('confirmation');
  lock.release('logger');
  assert.equal(body.getPropertyValue('position'), 'fixed');
  assert.deepEqual(scrolls, []);
  lock.release('unknown');
  lock.release('confirmation');
  assert.deepEqual(scrolls, [[3, 420]]);
  assert.equal(body.getPropertyValue('top'), '2px');
  assert.equal(body.getPropertyPriority('top'), 'important');
  assert.equal(body.getPropertyValue('left'), '');
  assert.equal(body.getPropertyValue('width'), '80%');
  assert.equal(body.getPropertyValue('overflow'), 'hidden');
  assert.equal(html.getPropertyValue('overflow'), '');
  assert.equal(html.getPropertyValue('scroll-behavior'), 'smooth');
  lock.release('confirmation');
  assert.equal(scrolls.length, 1);
});

test('partial and invalid strength inputs reject the whole save rather than inventing data', () => {
  for (const row of [
    { a: '20', b: '' }, { a: '', b: '8' }, { a: '-10', b: '8' }, { a: '10', b: '-1' },
    { a: '20', b: '0' }, { a: '20', b: '1.5' }, { a: '20a', b: '8' },
    { a: '2e2', b: '8' }, { a: '1.2.3', b: '8' }, { a: 'Infinity', b: '8' }, { a: '.', b: '8' }
  ]) {
    const parsed = logging.parseRows(strength, [{ a: '10', b: '5' }, row], 'kg');
    assert.match(parsed.error, /^Set 2:/);
    assert.equal(parsed.row, 1);
    assert.deepEqual(parsed.entries, []);
  }
});

test('cardio preserves decimal distance and time, accepts decimal comma and explicit zero', () => {
  assert.deepEqual(logging.parseRows(cardio, [{ a: '12.5', b: '1.5' }], 'kg').entries, [{ time: '12.5', dist: '1.5' }]);
  assert.deepEqual(logging.parseRows(cardio, [{ a: '12,5', b: '1,5' }], 'kg').entries, [{ time: '12.5', dist: '1.5' }]);
  assert.deepEqual(logging.parseRows(cardio, [{ a: '10', b: '0' }], 'kg').entries, [{ time: '10', dist: '0' }]);
  assert.deepEqual(logging.parseRows(cardio, [{ a: '0', b: '2' }], 'kg').entries, [{ time: '0', dist: '2' }]);
  for (const row of [{ a: '0', b: '0' }, { a: '10', b: '' }, { a: '-1', b: '2' }, { a: '5', b: '1.2.3' }]) {
    assert.ok(logging.parseRows(cardio, [row], 'kg').error);
  }
});

test('same routine is preferred over a newer workout, with changed order noted', () => {
  const sessions = [
    { id: 'new', start: '2026-10-09T12:00:00Z', templateId: 'b', entries: { bench: [{ w: '100', r: '8' }] }, order: ['bench'] },
    { id: 'oldest', start: '2026-09-01T12:00:00Z', templateId: 'a', entries: { bench: [{ w: '50', r: '8' }] }, order: ['bench'] },
    { id: 'same', start: '2026-10-02T12:00:00Z', templateId: 'a', entries: { bench: [{ w: '60', r: '8' }] }, order: ['squat', 'bench'] }
  ];
  const before = JSON.stringify(sessions);
  const last = logging.findLast('bench', strength, sessions, { id: 'active', templateId: 'a', order: ['bench'] });
  assert.equal(last.session.id, 'same');
  assert.equal(last.sameRoutine, true);
  assert.equal(last.orderChanged, true);
  assert.equal(JSON.stringify(sessions), before);
});

test('history fallback is explicit, ignores empty/planned sets, and chooses newest actual record', () => {
  const sessions = [
    { id: 'old', start: '2026-09-01', templateId: 'other', entries: { bench: [{ w: '50', r: '8' }] } },
    { id: 'blank', start: '2026-10-10', templateId: 'a', entries: { bench: [{ w: '', r: '' }] } },
    { id: 'planned', start: '2026-10-09', templateId: 'a', entries: { bench: [{ w: '50', r: '8', completed: false }] } },
    { id: 'actual', start: '2026-10-02', templateId: 'other', entries: { bench: [{ w: '60', r: '8' }] } }
  ];
  const last = logging.findLast('bench', strength, sessions, { templateId: 'a', order: ['bench'] });
  assert.equal(last.session.id, 'actual');
  assert.equal(last.sameRoutine, false);
  assert.equal(logging.findLast('missing', strength, sessions), null);
});

test('freestyle context prefers freestyle and detects different preceding exercises at same position', () => {
  const last = logging.findLast('bench', strength, [
    { id: 'routine', start: '2026-10-10', templateId: 'a', entries: { bench: [{ w: '60', r: '8' }] }, order: ['bench'] },
    { id: 'free', start: '2026-10-01', templateId: null, entries: { bench: [{ w: '50', r: '8' }] }, order: ['squat', 'bench'] }
  ], { templateId: null, order: ['row', 'bench'] });
  assert.equal(last.session.id, 'free');
  assert.equal(last.sameRoutine, true);
  assert.equal(last.orderChanged, true);
});

test('viewing saved sets creates no unfinished-edit requirement; changed or partial inputs do', () => {
  const entries = [{ w: 62.5, r: '8', note: 'Pause' }];
  const draft = { rows: logging.rowsFromSets(strength, entries, 'lbs'), notes: 'Good', unit: 'lbs' };
  assert.equal(logging.unchangedDraft(strength, draft, entries, 'Good'), true);
  draft.rows[0].b = '';
  assert.equal(logging.unchangedDraft(strength, draft, entries, 'Good'), false);
  draft.rows[0].b = '8';
  draft.notes = 'Changed';
  assert.equal(logging.unchangedDraft(strength, draft, entries, 'Good'), false);
});

function loggerHarness({ success = true, a = '100', b = '8', exercise = strength, sourceRow = {}, mode = 'external', snapshot = null, unit = 'lbs' } = {}) {
  const app = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const code = app.slice(app.indexOf('let CURRENT_LOG_EX = null;'), app.indexOf('// --- TEMPLATES ---'));
  const classes = new Set();
  const controls = [{ value: a, hidden: mode === 'bodyweight', focus() { this.focused = true; } }, { value: b, focus() { this.focused = true; } }];
  const row = { _sourceRow: sourceRow, querySelector: selector => selector === '.input-val-1' ? controls[0] : controls[1] };
  const elements = {};
  const node = () => ({ value: '', textContent: '', handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    classList: { add: value => classes.add(value) } });
  elements['#logNotes'] = { ...node(), value: 'Keep elbow tucked' };
  const snapshots = [], renders = [];
  const sandbox = {
    LiftLogUpdates: {notifySafe() {}}, LiftLogLogging: logging, LiftLogDates: dates, LiftLogExerciseLoad: require('../exercise-load.js'),
    $: selector => elements[selector] || (elements[selector] = node()),
    $$: selector => selector === '#logRows .log-row' ? [row] : controls,
    DB: { exercises: { bench: exercise } },
    ACTIVE_SESSION: { id: 'session', bodyweightSnapshot: snapshot, entries: { bench: [{ w: '20', r: '5' }] }, exerciseNotes: { bench: 'Old note' }, logDrafts: {} },
    window: { scrollX: 0, scrollY: 0, scrollTo() {} },
    document: { body: { style: styleStub() }, documentElement: { style: styleStub() } },
    renderActiveSession(options) { renders.push(options); },
    saveDraft: async () => { snapshots.push(JSON.parse(JSON.stringify(sandbox.ACTIVE_SESSION))); return success; }
  };
  vm.createContext(sandbox);
  vm.runInContext(app.slice(app.indexOf('// --- MODAL WORKFLOW HELPERS ---'), app.indexOf('// --- TABS & NAVIGATION ---')), sandbox);
  vm.runInContext(code, sandbox);
  vm.runInContext(`CURRENT_LOG_EX = 'bench'; CURRENT_LOG_UNIT = ${JSON.stringify(unit)}; CURRENT_LOG_MODE = ${JSON.stringify(mode)};`, sandbox);
  return { sandbox, snapshots, elements, classes, controls, renders };
}

test('actual Save handler persists canonical entries and exercise notes before closing', async () => {
  const { sandbox, snapshots, classes } = loggerHarness();
  await sandbox.saveLog();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].exerciseNotes.bench, 'Keep elbow tucked');
  assert.ok(Math.abs(Number(snapshots[0].entries.bench[0].w) - 100 / 2.20462) < 1e-10);
  assert.equal(snapshots[0].logDrafts.bench, undefined);
  assert.equal(classes.has('hidden'), true);
});

test('successful set saves pass the prior completed state once; failed saves never request rail feedback', async () => {
  const first = loggerHarness();
  first.sandbox.ACTIVE_SESSION.entries = {};
  first.sandbox.ACTIVE_SESSION.order = ['bench'];
  await first.sandbox.saveLog();
  assert.deepEqual(JSON.parse(JSON.stringify(first.renders)), [{ beforeCompleted: [], savedExercise: 'bench' }]);
  const edit = loggerHarness();
  await edit.sandbox.saveLog();
  assert.deepEqual(JSON.parse(JSON.stringify(edit.renders)), [{ beforeCompleted: ['bench'], savedExercise: 'bench' }]);
  const failed = loggerHarness({ success: false });
  await failed.sandbox.saveLog();
  assert.deepEqual(failed.renders, []);
});

test('actual Save handler retains inputs and original saved sets after a storage failure', async () => {
  const { sandbox, elements, classes } = loggerHarness({ success: false });
  await sandbox.saveLog();
  assert.equal(sandbox.ACTIVE_SESSION.entries.bench[0].w, '20');
  assert.equal(sandbox.ACTIVE_SESSION.exerciseNotes.bench, 'Old note');
  assert.equal(sandbox.ACTIVE_SESSION.logDrafts.bench.rows[0].a, '100');
  assert.match(elements['#logError'].textContent, /could not be saved/);
  assert.equal(classes.has('hidden'), false);
});

test('actual Save handler rejects partial rows and does not write or close', async () => {
  const { sandbox, snapshots, elements, classes } = loggerHarness({ b: '' });
  await sandbox.saveLog();
  assert.equal(snapshots.length, 0);
  assert.match(elements['#logError'].textContent, /enter weight and reps/);
  assert.equal(classes.has('hidden'), false);
});

test('closing the logger saves incomplete raw input and notes without counting it as performed', async () => {
  const { sandbox, snapshots, classes } = loggerHarness({ a: '10.', b: '' });
  await sandbox.closeLogger();
  assert.equal(snapshots[0].logDrafts.bench.rows[0].a, '10.');
  assert.equal(snapshots[0].logDrafts.bench.rows[0].b, '');
  assert.equal(snapshots[0].logDrafts.bench.notes, 'Keep elbow tucked');
  assert.equal(snapshots[0].logDrafts.bench.unit, 'lbs');
  assert.equal(snapshots[0].entries.bench[0].w, '20');
  assert.equal(classes.has('hidden'), true);
});

test('actual plus-only Add set handler reads the current input rather than saved set history', () => {
  const { sandbox, controls, elements, snapshots } = loggerHarness();
  controls[0].value = '140.5';
  controls[1].value = '6';
  const added = [];
  sandbox.addLogRow = (exercise, row) => added.push({ exercise, row });
  elements['#btnAddRow'].handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(added)), [{ exercise: {...strength, loadType: 'external'}, row: { a: '140.5', b: '', loadType: 'external' } }]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].entries.bench[0].w, '20');
});

test('a failed Close keeps background locked while a successful Close releases it', async () => {
  const { sandbox, classes } = loggerHarness({ success: false, a: '60.5', b: '' });
  vm.runInContext("LOGGER_SCROLL_LOCK.acquire('logger')", sandbox);
  await sandbox.closeLogger();
  assert.equal(sandbox.document.body.style.getPropertyValue('position'), 'fixed');
  assert.equal(classes.has('hidden'), false);
  sandbox.saveDraft = async () => true;
  await sandbox.closeLogger();
  assert.equal(sandbox.document.body.style.getPropertyValue('position'), '');
  assert.equal(classes.has('hidden'), true);
});

test('actual Save stores reps-only bodyweight sets with the captured session weight', async () => {
  const {sandbox,snapshots}=loggerHarness({exercise:{type:'strength',loadType:'bodyweight'},mode:'bodyweight',unit:'kg',a:'',b:'8',snapshot:{kg:80,date:'2026-10-10'}});
  await sandbox.saveLog();
  assert.deepEqual(snapshots[0].entries.bench,[{w:0,r:'8',loadType:'bodyweight',bodyweightKg:80,bodyweightDate:'2026-10-10'}]);
});

test('actual bodyweight validation focuses visible reps and never writes an invalid set', async () => {
  const {sandbox,snapshots,controls}=loggerHarness({exercise:{type:'strength',loadType:'bodyweight'},mode:'bodyweight',unit:'kg',a:'',b:'1.5'});
  await sandbox.saveLog();
  assert.equal(controls[0].focused,undefined); assert.equal(controls[1].focused,true);
  assert.equal(snapshots.length,0);
});

test('actual Save does not resnapshot an old saved row after a workout bodyweight override', async () => {
  const original={w:'20',r:'8',loadType:'assisted',bodyweightKg:75,bodyweightDate:'2026-04-02',note:'old'};
  const sourceRow=logging.rowsFromSets({type:'strength'},[original],'kg')[0];
  const {sandbox,snapshots}=loggerHarness({exercise:{type:'strength',loadType:'weighted'},sourceRow,mode:'weighted',unit:'kg',a:'20',b:'9',snapshot:{kg:80,date:'2026-10-10'}});
  await sandbox.saveLog();
  assert.deepEqual(snapshots[0].entries.bench,[{...original,r:'9'}]);
});

test('the actual Copy Last icon copies weights into blank-rep rows and keeps exercise notes', async () => {
  const h = loggerHarness(), {sandbox, elements} = h;
  function element() {
    return {children: [], handlers: {}, attributes: {}, appendChild(child) {this.children.push(child);},
      setAttribute(name, value) {this.attributes[name] = value;}, addEventListener(name, callback) {this.handlers[name] = callback;}};
  }
  sandbox.document.createElement = element;
  sandbox.getWeightUnit = () => 'lbs'; sandbox.escapeHTML = String; sandbox.updateSaveStatus = () => {};
  sandbox.MUSCLE_COLORS = {Other: '#78909c'};
  elements['#logModal'].style = styleStub();
  const copySlot = element(); elements['#loggerCopySlot'] = copySlot;
  sandbox.DB.exercises.bench = {...strength, name: 'Bench'};
  sandbox.DB.templates = {};
  sandbox.DB.sessions = [{id: 'previous', start: '2026-09-01', order: ['bench'], entries: {bench: [{w: '62.5', r: '8'}, {w: 60, r: 6}]}}];
  const history = element(); elements['#prevSessionInfo'] = history;
  elements['#logHeaders'] = {querySelector: () => ({})};
  elements['#logNotes'].setAttribute = () => {};
  elements['#logModal'].classList.remove = () => {};
  const added = []; sandbox.addLogRow = (exercise, row) => {added.push(row);};
  sandbox.openLogger('bench');
  const button = copySlot.children.find(child => child.id === 'btnCopyLastSets');
  assert.equal(button.attributes['aria-label'], 'Copy last weights and set count');
  assert.match(button.innerHTML, /assets\/icons\/copy-original\.jpg/); assert.equal(button.textContent, undefined);
  sandbox.askConfirm = async () => true;
  const notes = elements['#logNotes'].value; added.length = 0;
  await button.handlers.click();
  assert.equal(added.length, 2); assert.equal(added[0].a, '137.8'); assert.equal(added[1].a, '132.3');
  assert.ok(added.every(row => row.b === '' && row.originalSet === undefined));
  assert.equal(added[0].originalKg, '62.5');
  assert.equal(elements['#logNotes'].value, notes);
});

function swapHarness({untouched = false, saveResults = [true, true], confirm = true, cardioType = false} = {}) {
  const h = loggerHarness({a: untouched ? '' : '62.5', b: '', unit: 'kg'}), {sandbox, elements} = h;
  Object.assign(sandbox, {COMMITTING: false, FINISHING: false, UPDATE_LOCK: false, STARTING: false, STORE_READY: true,
    STORAGE_ERROR: null, STORAGE_EPOCH: 1, copyState: value => JSON.parse(JSON.stringify(value)),
    LiftLogStorage: require('../storage.js'), updateSaveStatus() {}, storageFailure() { return false; }});
  sandbox.DB.exercises.bench = {id: 'bench', name: 'Bench', type: cardioType ? 'cardio' : 'strength', muscle: 'Chest'};
  sandbox.DB.exercises.press = {id: 'press', name: 'Press', type: cardioType ? 'cardio' : 'strength', muscle: 'Chest'};
  sandbox.DB.exercises.row = {id: 'row', name: 'Row', type: cardioType ? 'cardio' : 'strength', muscle: 'Chest'};
  sandbox.DB.templates = {routine: {exercises: [{exId: 'squat'}, {exId: 'bench'}, {exId: 'row'}]}};
  sandbox.DB.sessions = [{id: 'old', entries: {bench: [{w: 45, r: 8}]}}];
  sandbox.ACTIVE_SESSION.start = '2026-10-12T12:00:00Z';
  sandbox.ACTIVE_SESSION.order = ['squat', 'bench', 'row'];
  if (untouched) { sandbox.ACTIVE_SESSION.entries = {}; sandbox.ACTIVE_SESSION.exerciseNotes = {}; elements['#logNotes'].value = ''; }
  const writes = [], opens = [], confirmations = []; let picker;
  sandbox.saveDraft = async () => {
    writes.push(JSON.parse(JSON.stringify(sandbox.ACTIVE_SESSION)));
    const success = saveResults[Math.min(writes.length - 1, saveResults.length - 1)];
    if (success) sandbox.ACTIVE_SESSION = JSON.parse(JSON.stringify(sandbox.ACTIVE_SESSION));
    return success;
  };
  sandbox.openLogger = id => { opens.push(id); };
  sandbox.openExercisePicker = (choose, cancel, options) => { picker = {choose, cancel, options}; };
  sandbox.askConfirm = async (title, message) => { confirmations.push({title, message}); return confirm; };
  return {...h, writes, opens, confirmations, picker: () => picker};
}

test('actual logger swap flushes draft before opening a same-muscle picker and saves an untouched replacement in place', async () => {
  const h = swapHarness({untouched: true}), beforeDB = JSON.stringify(h.sandbox.DB);
  await h.sandbox.swapLoggerExercise();
  assert.equal(h.writes.length, 1); assert.equal(h.opens.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.picker().options)), {filter: 'Chest', title: 'SWAP EXERCISE', excludeIds: ['bench'], lockedFilter: true, allowCreate: false});
  await h.picker().choose('press');
  assert.deepEqual(h.sandbox.ACTIVE_SESSION.order, ['squat', 'press', 'row']);
  assert.equal(h.writes.length, 2); assert.deepEqual(h.writes[1].order, ['squat', 'press', 'row']);
  assert.equal(h.sandbox.ACTIVE_SESSION.logDrafts.bench, undefined);
  assert.equal(h.sandbox.ACTIVE_SESSION.entries.press, undefined);
  assert.deepEqual(h.opens, ['press']); assert.equal(h.confirmations.length, 0);
  assert.equal(JSON.stringify(h.sandbox.DB), beforeDB);
});

test('actual logger swap keeps partial input, saved sets and notes on their original exercise after confirmation', async () => {
  const h = swapHarness(); await h.sandbox.swapLoggerExercise();
  const draft = JSON.stringify(h.sandbox.ACTIVE_SESSION.logDrafts.bench);
  const savedSets = JSON.stringify(h.sandbox.ACTIVE_SESSION.entries.bench);
  await h.picker().choose('press');
  assert.deepEqual(h.sandbox.ACTIVE_SESSION.order, ['squat', 'bench', 'press', 'row']);
  assert.equal(JSON.stringify(h.sandbox.ACTIVE_SESSION.logDrafts.bench), draft);
  assert.equal(JSON.stringify(h.sandbox.ACTIVE_SESSION.entries.bench), savedSets);
  assert.equal(h.sandbox.ACTIVE_SESSION.exerciseNotes.bench, 'Old note');
  assert.equal(h.sandbox.ACTIVE_SESSION.logDrafts.bench.notes, 'Keep elbow tucked');
  assert.equal(h.sandbox.ACTIVE_SESSION.logDrafts.press, undefined);
  assert.deepEqual(h.opens, ['press']); assert.equal(h.confirmations.length, 1);
});

test('cancelling picker or preservation confirmation reopens the original logger without changing order or losing raw inputs', async () => {
  for (const cancelPicker of [true, false]) {
    const h = swapHarness({confirm: false}); await h.sandbox.swapLoggerExercise();
    const before = JSON.stringify(h.sandbox.ACTIVE_SESSION);
    if (cancelPicker) h.picker().cancel(); else await h.picker().choose('press');
    assert.equal(JSON.stringify(h.sandbox.ACTIVE_SESSION), before); assert.deepEqual(h.opens, ['bench']);
    assert.equal(h.writes.length, 1);
  }
});

test('choosing an existing workout exercise opens it without duplicate order entries or source removal', async () => {
  const h = swapHarness(); await h.sandbox.swapLoggerExercise(); const before = JSON.stringify(h.sandbox.ACTIVE_SESSION);
  await h.picker().choose('row');
  assert.equal(JSON.stringify(h.sandbox.ACTIVE_SESSION), before); assert.deepEqual(h.opens, ['row']);
  assert.equal(h.writes.length, 1); assert.equal(h.confirmations.length, 0);
});

test('swap save failures retain the logger on flush failure and roll back replacement order before reopening on commit failure', async () => {
  const flush = swapHarness({saveResults: [false]}); await flush.sandbox.swapLoggerExercise();
  assert.equal(flush.picker(), undefined); assert.equal(flush.classes.has('hidden'), false);
  assert.match(flush.elements['#logError'].textContent, /could not be saved/);
  const commit = swapHarness({untouched: true, saveResults: [true, false]}); await commit.sandbox.swapLoggerExercise();
  const before = JSON.stringify(commit.sandbox.ACTIVE_SESSION); await commit.picker().choose('press');
  assert.equal(JSON.stringify(commit.sandbox.ACTIVE_SESSION), before); assert.deepEqual(commit.opens, ['bench']);
  assert.match(commit.elements['#logError'].textContent, /swap could not be saved/);
});

test('swap rejects a different muscle, and cardio is filtered by exercise type rather than its old muscle label', async () => {
  const h = swapHarness({untouched: true}); h.sandbox.DB.exercises.press.muscle = 'Back';
  await h.sandbox.swapLoggerExercise(); await h.picker().choose('press');
  assert.deepEqual(h.opens, ['bench']); assert.equal(h.writes.length, 1);
  const cardioSwap = swapHarness({untouched: true, cardioType: true}); await cardioSwap.sandbox.swapLoggerExercise();
  assert.equal(cardioSwap.picker().options.filter, 'Cardio');
  await cardioSwap.picker().choose('press'); assert.deepEqual(cardioSwap.opens, ['press']);
});

test('a storage generation change while choosing a swap never edits or opens a replacement session', async () => {
  const h = swapHarness({untouched: true}); await h.sandbox.swapLoggerExercise();
  h.sandbox.STORAGE_EPOCH = 2; h.sandbox.ACTIVE_SESSION = {id: 'replacement', order: ['press'], start: 'later'};
  await h.picker().choose('press');
  assert.deepEqual(h.sandbox.ACTIVE_SESSION, {id: 'replacement', order: ['press'], start: 'later'});
  assert.equal(h.writes.length, 1); assert.deepEqual(h.opens, []);
});

test('neither picker nor destination logger opens before its required save settles', async () => {
  const h = swapHarness({untouched: true}); let settle;
  h.sandbox.saveDraft = () => new Promise(resolve => {settle = resolve;});
  const flushing = h.sandbox.swapLoggerExercise();
  assert.equal(h.picker(), undefined); assert.deepEqual(h.opens, []);
  assert.ok(h.controls.every(control => control.disabled));
  settle(true); await flushing;
  assert.ok(h.picker()); assert.ok(h.controls.every(control => !control.disabled));
  const selecting = h.picker().choose('press');
  assert.deepEqual(h.opens, []);
  settle(true); await selecting;
  assert.deepEqual(h.opens, ['press']);
});

function setCardHarness(exercise, mode = 'external', unit = 'kg') {
  const app = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const code = app.slice(app.indexOf('function addLogRow('), app.indexOf('$("#btnAddRow").addEventListener'));
  const rows = [], writes = [];
  const makeNode = tag => ({tag, children: [], dataset: {}, attributes: {}, handlers: {}, value: '', hidden: false,
    style: styleStub(), classList: {toggle() {}},
    setAttribute(name, value) {this.attributes[name] = value;},
    addEventListener(name, fn) {this.handlers[name] = fn;},
    prepend(node) {this.nodes ||= {}; this.nodes['log-row-mode'] = node; node.remove = () => delete this.nodes['log-row-mode'];},
    remove() {const index = rows.indexOf(this); if (index >= 0) rows.splice(index, 1);},
    set innerHTML(value) {
      this.markup = value; this.nodes = {};
      for (const match of value.matchAll(/<([a-z]+)\b[^>]*class="([^"]+)"/g)) {
        const child = makeNode(match[1]);
        for (const cls of match[2].split(' ')) this.nodes[cls] = child;
      }
    },
    querySelector(selector) {
      if (selector === '.log-field-first .log-field-name') return this.nodes?.['h-val-1'] || null;
      if (selector === '.log-field-second .log-field-name') return this.nodes?.['h-val-2'] || null;
      return this.nodes?.[selector.split(' ').at(-1).slice(1)] || null;
    }
  });
  const headers = {classList: {toggle() {}}, querySelector: () => ({})};
  const sandbox = {document: {createElement: makeNode}, LiftLogExerciseLoad: require('../exercise-load.js'),
    CURRENT_LOG_EX: 'lift', CURRENT_LOG_MODE: mode, CURRENT_LOG_UNIT: unit, LOG_SAVING: false,
    DB: {exercises: {lift: exercise}},
    $: selector => selector === '#logRows' ? {appendChild(row) {rows.push(row);}} : headers,
    $$: () => rows,
    captureLogDraft() {writes.push(rows.map(row => ({a: row.querySelector('.input-val-1').value, b: row.querySelector('.input-val-2').value})));}
  };
  vm.createContext(sandbox); vm.runInContext(code, sandbox);
  return {sandbox, rows, writes};
}

test('set cards expose the appropriate labelled fields for every load type and cardio', () => {
  for (const [mode, expected] of [['external', 'KG'], ['assisted', 'ASSISTANCE (KG)'], ['weighted', 'ADDED WEIGHT (KG)'], ['bodyweight', 'BODYWEIGHT (KG)'], ['cardio', 'MINS']]) {
    const exercise = mode === 'cardio' ? cardio : {...strength, loadType: mode};
    const h = setCardHarness(exercise, mode); h.sandbox.addLogRow(exercise, {a: mode === 'bodyweight' ? '' : '20', b: ''});
    const row = h.rows[0];
    assert.equal(row.querySelector('.log-field-first .log-field-name').textContent, expected);
    assert.equal(row.querySelector('.log-field-second .log-field-name').textContent, mode === 'cardio' ? 'KM' : 'REPS');
    assert.equal(row.querySelector('.log-field-first').hidden, mode === 'bodyweight');
    assert.equal(row.querySelector('.input-val-1').hidden, mode === 'bodyweight');
    assert.equal(row.querySelector('.input-val-2').attributes['aria-label'], mode === 'cardio' ? 'Set 1: Distance in km' : 'Set 1: Repetitions');
    assert.equal(row.querySelector('.input-val-2').value, '');
    assert.match(row.markup, /<label class="log-field log-field-first">/);
  }
});

test('removing a set card renumbers accessible controls and retains incomplete inputs in other cards', () => {
  const h = setCardHarness(strength); h.sandbox.addLogRow(strength, {a: '60.5', b: '8'});
  h.sandbox.addLogRow(strength, {a: '62.5', b: ''});
  h.rows[0].querySelector('.remove-row').handlers.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].querySelector('.index-num').textContent, 1);
  assert.equal(h.rows[0].querySelector('.remove-row').attributes['aria-label'], 'Remove set 1');
  assert.equal(h.rows[0].querySelector('.input-val-1').attributes['aria-label'], 'Set 1: Weight in kg');
  assert.deepEqual(h.writes, [[{a: '62.5', b: ''}]]);
});

test('a saved assisted card keeps its load meaning and original snapshot under a weighted exercise default', () => {
  const original = {w: '18', r: '7', loadType: 'assisted', bodyweightKg: 81.23, bodyweightDate: '2026-04-09'};
  const exercise = {...strength, loadType: 'weighted'};
  const h = setCardHarness(exercise, 'weighted');
  h.sandbox.addLogRow(exercise, logging.rowsFromSets(exercise, [original], 'kg')[0]);
  const row = h.rows[0]; row.querySelector('.input-val-2').value = '8';
  assert.equal(row.querySelector('.log-field-first .log-field-name').textContent, 'ASSISTANCE (KG)');
  const parsed = logging.parseRows(exercise, [{...row._sourceRow, a: row.querySelector('.input-val-1').value, b: row.querySelector('.input-val-2').value}], 'kg', {snapshotNew: true, bodyweightSnapshot: {kg: 90, date: '2026-10-12'}});
  assert.deepEqual(parsed.entries, [{...original, r: '8'}]);
  assert.deepEqual(original, {w: '18', r: '7', loadType: 'assisted', bodyweightKg: 81.23, bodyweightDate: '2026-04-09'});
});
