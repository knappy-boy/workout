const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const logging = require('../logging.js');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Source section is available: ${start}`);
  return source.slice(from, to);
}
function style() {
  const values = new Map();
  return {
    setProperty(key, value, priority = '') { values.set(key, { value: String(value), priority }); },
    getPropertyValue: key => values.get(key)?.value || '',
    getPropertyPriority: key => values.get(key)?.priority || '',
    removeProperty: key => values.delete(key)
  };
}
function harness(options = {}) {
  const nodes = new Map(), document = { activeElement: null }, scrolls = [], writes = [], notices = [];
  class Element {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentElement = null;
      this.attrs = {}; this.dataset = {}; this.events = {}; this.style = style(); this.classes = new Set();
      this.value = ''; this.disabled = false; this.scrollTop = 0; this.scrollLeft = 0; this.textContent = '';
      this.classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        contains: name => this.classes.has(name),
        toggle: (name, force) => { const next = force ?? !this.classes.has(name); next ? this.classes.add(name) : this.classes.delete(name); return next; }
      };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    append(...children) { children.forEach(child => { this.children.push(child); child.parentElement = this; }); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
    querySelectorAll(selector) {
      const tags = selector.split(',').map(tag => tag.trim().toUpperCase());
      return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getClientRects() { return !this.isConnected || this.hidden || this.classList.contains('hidden') || (this.parentElement && !this.parentElement.getClientRects().length) ? [] : [{}]; }
    focus(opts) { if (this.disabled || !this.getClientRects().length) return; document.activeElement = this; this.focusOptions = opts; }
    addEventListener(type, callback) { this.events[type] = callback; }
    reportValidity() { this.reportedValidity = true; }
  }
  document.body = new Element('body'); document.documentElement = new Element('html');
  document.body.style.setProperty('overflow', 'auto', 'important');
  document.documentElement.style.setProperty('scroll-behavior', 'smooth');
  const $ = selector => {
    if (!nodes.has(selector)) { const node = new Element('div', selector.slice(1)); nodes.set(selector, node); document.body.append(node); }
    return nodes.get(selector);
  };
  function add(id, tag, parent) {
    const node = new Element(tag, id); nodes.set(`#${id}`, node); (parent || document.body).append(node); return node;
  }
  document.createElement = tag => new Element(tag);
  document.querySelector = selector => nodes.get(selector) || null;
  const picker = add('pickerModal', 'div'); picker.className = 'hidden';
  add('pickerTitle', 'h3', picker); add('pickerClose', 'button', picker); add('pickerSearch', 'input', picker);
  add('pickerTabs', 'div', picker); add('pickerStatus', 'span', picker); add('pickerList', 'div', picker);
  add('pickerCreate', 'button', add('pickerFooter', 'div', picker));
  const editor = add('addExModal', 'div'); editor.className = 'hidden';
  add('exModalTitle', 'h3', editor);
  for (const [id, tag] of [['btnCloseExModal', 'button'], ['newExName', 'input'], ['newExType', 'select'],
    ['newExMuscle', 'select'], ['newExEquip', 'select'], ['newExInc', 'input'], ['newExLoadType', 'select'],
    ['newExCardioMetric', 'input'], ['newExCardioGoal', 'select'], ['btnSaveEx', 'button'], ['btnDeleteEx', 'button']]) add(id, tag, editor);
  const routine = add('templateBuilderModal', 'div'); routine.className = 'hidden';
  add('btnAddExToTemplate', 'button', routine); add('btnAddExToWorkout', 'button');
  const launcher = add('launcher', 'button'); launcher.focus();
  const win = { scrollX: 3, scrollY: 240, scrollTo: (x, y) => scrolls.push([x, y]) };
  const lock = logging.createScrollLock(win, document);
  const DB = { exercises: {
    bench: { id: 'bench', name: 'Bench press', muscle: 'Chest', type: 'strength' },
    fly: { id: 'fly', name: 'Chest fly', muscle: 'Chest', type: 'strength' },
    row: { id: 'row', name: 'Cable row', muscle: 'Back', type: 'strength' },
    run: { id: 'run', name: 'Run', type: 'cardio' },
    archived: { id: 'archived', name: 'Archived bench', muscle: 'Chest', type: 'strength', archived: true }
  }, sessions: [{ id: 'past', entries: { bench: [{ w: 60, r: 8 }] } }] };
  let sequence = 0, workoutRenders = 0, routineRenders = 0;
  const context = vm.createContext({ $, document, DB, MUSCLE_GROUPS: ['Chest', 'Back', 'Other'],
    MUSCLE_COLORS: { Chest: '#E57373', Back: '#64B5F6', Other: '#78909C' },
    LiftLogExerciseLoad: require('../exercise-load.js'), LOGGER_SCROLL_LOCK: lock, uid: () => `created-${++sequence}`,
    saveDB: async () => { writes.push(clone(DB)); return options.save ? options.save() : true; },
    askConfirm: async () => true, renderExerciseLibrary() {}, showNotice: (...args) => notices.push(args),
    ACTIVE_SESSION: { id: 'active', order: ['bench'] }, renderActiveSession() { workoutRenders++; },
    _templateOpen: true, _templateBuilderExercises: [{ exId: 'bench', sets: 4 }],
    templateBuilderBlocked: () => false, routineStorageBlocked: () => false, cancelTemplateDrag() {},
    renderTemplateBuilderList() { routineRenders++; }
  });
  vm.runInContext(source.slice(source.indexOf('// --- MODAL WORKFLOW HELPERS ---'), source.indexOf('// --- TABS & NAVIGATION ---')), context);
  vm.runInContext([
    section('let _createdExerciseCallback = null;', '// --- WORKOUT LOGGING ---'),
    section('// --- PICKER UTILS ---', '// Prevent scroll chaining on all overlays'),
    section('$("#btnAddExToWorkout").addEventListener', '$("#btnFinishWorkout").addEventListener'),
    section('$("#btnAddExToTemplate").addEventListener', 'function moveTemplateExercise(')
  ].join('\n'), context);
  const fire = (id, type = 'click', extras = {}) => {
    const node = $(id), event = { target: node, preventDefault() { this.defaultPrevented = true; }, ...extras };
    return (node.events[type] || node[`on${type}`])?.(event);
  };
  const choices = () => $('#pickerList').children.filter(node => node.classList.contains('picker-choice'));
  return { $, context, document, launcher, lock, scrolls, writes, notices, fire, choices, add,
    get workoutRenders() { return workoutRenders; }, get routineRenders() { return routineRenders; },
    openOrigin(origin) {
      if (origin === 'routine') { routine.classList.remove('hidden'); lock.acquire('routine-builder'); $('#btnAddExToTemplate').focus(); fire('#btnAddExToTemplate'); }
      else { $('#btnAddExToWorkout').focus(); fire('#btnAddExToWorkout'); }
    },
    openCreate() { $('#pickerCreate').focus(); fire('#pickerCreate'); },
    key(id, key, shiftKey = false) { return fire(id, 'keydown', { key, shiftKey }); },
    locked: () => document.body.style.getPropertyValue('position') === 'fixed'
  };
}

test('picker cancellation returns to each real origin without changing exercises, routine or workout', () => {
  for (const origin of ['workout', 'routine']) {
    const h = harness(), before = clone({ db: h.context.DB, active: h.context.ACTIVE_SESSION, routine: h.context._templateBuilderExercises });
    h.openOrigin(origin); assert.equal(h.locked(), true); assert.equal(h.document.activeElement, h.$('#pickerTitle'));
    h.key('#pickerModal', 'Escape'); h.fire('#pickerClose');
    assert.deepEqual(clone({ db: h.context.DB, active: h.context.ACTIVE_SESSION, routine: h.context._templateBuilderExercises }), before);
    assert.equal(h.document.activeElement.id, origin === 'routine' ? 'btnAddExToTemplate' : 'btnAddExToWorkout');
    assert.equal(h.$('#pickerModal').classList.contains('hidden'), true);
    assert.equal(h.locked(), origin === 'routine');
    if (origin === 'routine') { assert.equal(h.routineRenders, 1); h.lock.release('routine-builder'); }
    assert.deepEqual(h.scrolls, [[3, 240]]);
    assert.equal(h.document.body.style.getPropertyValue('overflow'), 'auto');
    assert.equal(h.document.body.style.getPropertyPriority('overflow'), 'important');
    assert.equal(h.document.documentElement.style.getPropertyValue('scroll-behavior'), 'smooth');
  }
});

test('create-cancel retains search and muscle filter and keeps the original scroll lock until picker closes', () => {
  const h = harness(); h.openOrigin('workout');
  const chest = h.$('#pickerTabs').children.find(node => node.textContent === 'Chest');
  h.$('#pickerTabs').scrollLeft = 35; chest.focus(); chest.onclick();
  assert.equal(h.document.activeElement, chest); assert.equal(h.$('#pickerTabs').scrollLeft, 35);
  h.$('#pickerSearch').value = ' bench '; h.fire('#pickerSearch', 'input');
  assert.equal(h.choices().length, 1); assert.equal(h.choices()[0].children[0].textContent, 'Bench press');
  h.openCreate(); assert.equal(h.$('#pickerModal').classList.contains('hidden'), true); assert.equal(h.locked(), true);
  h.$('#newExName').value = 'Uncommitted exercise'; h.key('#addExModal', 'Escape');
  assert.equal(h.$('#pickerModal').classList.contains('hidden'), false); assert.equal(h.$('#addExModal').classList.contains('hidden'), true);
  assert.equal(h.$('#pickerSearch').value, ' bench '); assert.equal(h.$('#pickerTabs').children.find(node => node.attrs['aria-pressed'] === 'true').textContent, 'Chest');
  assert.equal(h.choices().length, 1); assert.equal(h.document.activeElement, h.$('#pickerTitle'));
  assert.equal(h.locked(), true); assert.equal(h.scrolls.length, 0); assert.equal(h.writes.length, 0);
  h.fire('#pickerClose'); assert.equal(h.locked(), false); assert.deepEqual(h.scrolls, [[3, 240]]);
  h.openOrigin('workout'); assert.equal(h.$('#pickerSearch').value, ''); assert.equal(h.choices().length, 4);
});

test('create-save routes a new exercise exactly once to the real workout or routine and preserves old history', async () => {
  for (const origin of ['workout', 'routine']) {
    const h = harness(), history = clone(h.context.DB.sessions);
    h.openOrigin(origin); h.openCreate(); h.$('#newExName').value = 'New row'; h.$('#newExMuscle').value = 'Back';
    await h.fire('#btnSaveEx');
    assert.equal(h.writes.length, 1); assert.equal(h.context.DB.exercises['created-1'].name, 'New row');
    assert.deepEqual(clone(h.context.DB.sessions), history);
    assert.equal(h.$('#pickerModal').classList.contains('hidden'), true); assert.equal(h.$('#addExModal').classList.contains('hidden'), true);
    const selected = origin === 'routine' ? h.context._templateBuilderExercises.map(item => item.exId) : h.context.ACTIVE_SESSION.order;
    assert.deepEqual([...selected], ['bench', 'created-1']);
    h.context.closeExercisePicker('created-1');
    assert.equal(origin === 'routine' ? h.routineRenders : h.workoutRenders, 1);
    assert.equal(h.locked(), origin === 'routine');
    assert.equal(h.document.activeElement.id, origin === 'routine' ? 'btnAddExToTemplate' : 'btnAddExToWorkout');
    if (origin === 'routine') h.lock.release('routine-builder');
    assert.deepEqual(h.scrolls, [[3, 240]]);
  }
});

test('pending and failed creation keep both dialogs owned; retry saves the same ID and selects it once', async () => {
  let resolve, calls = 0;
  const h = harness({ save: () => ++calls === 1 ? new Promise(done => { resolve = done; }) : true });
  h.openOrigin('routine'); h.openCreate(); h.$('#newExName').value = 'New curl';
  const pending = h.fire('#btnSaveEx'); await h.fire('#btnSaveEx'); h.key('#addExModal', 'Escape');
  assert.equal(h.writes.length, 1); assert.equal(h.$('#addExModal').classList.contains('hidden'), false); assert.equal(h.$('#btnSaveEx').disabled, true);
  assert.deepEqual(clone(h.context._templateBuilderExercises), [{ exId: 'bench', sets: 4 }]);
  resolve(false); await pending;
  assert.equal(h.locked(), true); assert.equal(h.scrolls.length, 0); assert.equal(h.$('#btnSaveEx').disabled, false);
  await h.fire('#btnSaveEx');
  assert.equal(h.writes.length, 2); assert.deepEqual(Object.keys(h.context.DB.exercises).filter(id => id.startsWith('created-')), ['created-1']);
  assert.deepEqual(clone(h.context._templateBuilderExercises), [{ exId: 'bench', sets: 4 }, { exId: 'created-1' }]);
  assert.equal(h.routineRenders, 1); assert.equal(h.locked(), true);
});

test('keyboard focus stays in the currently visible picker or create dialog and selection callbacks run once', () => {
  const h = harness(); let selected = 0, cancelled = 0;
  h.context.openExercisePicker(() => { selected++; }, () => { cancelled++; });
  h.key('#pickerModal', 'Tab'); assert.equal(h.document.activeElement, h.$('#pickerClose'));
  h.key('#pickerModal', 'Tab', true); assert.equal(h.document.activeElement, h.$('#pickerCreate'));
  h.key('#pickerModal', 'Tab'); assert.equal(h.document.activeElement, h.$('#pickerClose'));
  h.openCreate(); assert.equal(h.document.activeElement, h.$('#exModalTitle'));
  h.key('#addExModal', 'Tab'); assert.equal(h.document.activeElement, h.$('#btnCloseExModal'));
  h.key('#addExModal', 'Tab', true); assert.equal(h.document.activeElement, h.$('#btnSaveEx'), 'hidden archive control cannot receive focus');
  h.key('#addExModal', 'Escape'); assert.equal(h.document.activeElement, h.$('#pickerTitle'));
  const choose = h.choices()[0].onclick; choose(); choose();
  assert.equal(selected, 1); assert.equal(cancelled, 0); assert.equal(h.document.activeElement, h.launcher);
});

test('empty filters can be cleared without closing the picker or exposing archived exercises', () => {
  const h = harness(); h.openOrigin('workout');
  h.$('#pickerSearch').value = 'missing'; h.fire('#pickerSearch', 'input');
  assert.equal(h.$('#pickerStatus').textContent, '0 exercises');
  h.$('#pickerList').children.find(node => node.classList.contains('picker-reset')).onclick();
  assert.equal(h.$('#pickerSearch').value, ''); assert.equal(h.choices().length, 4);
  assert.ok(h.choices().every(node => node.children[0].textContent !== 'Archived bench'));
  assert.equal(h.document.activeElement, h.$('#pickerSearch')); assert.equal(h.locked(), true);
});

test('restricted swap choices retain the muscle restriction when clearing search, exclude current exercises and hide creation', () => {
  const h = harness(), before = clone(h.context.DB);
  h.context.openExercisePicker(() => {}, null, {title: 'SWAP CHEST EXERCISE', filter: 'Chest', lockedFilter: true, excludeIds: ['bench'], allowCreate: false});
  assert.equal(h.$('#pickerTitle').textContent, 'SWAP CHEST EXERCISE');
  assert.equal(h.$('#pickerFooter').hidden, true); assert.equal(h.$('#pickerCreate').getClientRects().length, 0);
  assert.deepEqual(h.$('#pickerTabs').children.map(node => node.textContent), ['Chest']);
  assert.deepEqual(h.choices().map(node => node.children[0].textContent), ['Chest fly']);
  h.$('#pickerClose').focus(); h.key('#pickerModal', 'Tab', true);
  assert.equal(h.document.activeElement, h.choices()[0], 'hidden creation button is excluded from the focus trap');
  h.$('#pickerSearch').value = 'row'; h.fire('#pickerSearch', 'input');
  assert.equal(h.choices().length, 0);
  h.$('#pickerList').children.find(node => node.classList.contains('picker-reset')).onclick();
  assert.deepEqual(h.$('#pickerTabs').children.map(node => node.textContent), ['Chest']);
  assert.deepEqual(h.choices().map(node => node.children[0].textContent), ['Chest fly']);
  assert.deepEqual(clone(h.context.DB), before);
  h.fire('#pickerClose'); h.context.openExercisePicker(() => {});
  assert.equal(h.$('#pickerFooter').hidden, false); assert.equal(h.$('#pickerTitle').textContent, 'SELECT EXERCISE');
  assert.equal(h.choices().length, 4); assert.equal(h.$('#pickerTabs').children[0].textContent, 'All');
});

test('an async selection holds its lock, rejects repeated selection/reopening and preserves the logger focus at handoff', async () => {
  let resolve, selections = 0, otherSelections = 0;
  const gate = new Promise(done => { resolve = done; }), h = harness();
  const logger = h.add('loggerTest', 'div'), heading = h.add('loggerTitleTest', 'h3', logger); logger.hidden = true;
  h.context.openExercisePicker(async id => {
    selections++; assert.equal(id, 'bench'); await gate;
    h.lock.acquire('logger'); logger.hidden = false; heading.focus({preventScroll: true});
  });
  const choose = h.choices().find(node => node.children[0].textContent === 'Bench press').onclick;
  const pending = choose(); choose(); h.fire('#pickerClose');
  h.context.openExercisePicker(() => { otherSelections++; });
  assert.equal(h.$('#pickerModal').classList.contains('hidden'), true);
  assert.equal(selections, 1); assert.equal(otherSelections, 0); assert.equal(h.locked(), true); assert.equal(h.scrolls.length, 0);
  resolve(); await pending;
  assert.equal(h.document.activeElement, heading); assert.equal(h.locked(), true); assert.equal(h.scrolls.length, 0);
  h.lock.release('logger'); assert.equal(h.locked(), false); assert.deepEqual(h.scrolls, [[3, 240]]);
});

test('an async cancellation returns focus only after its callback completes and calls it once', async () => {
  const h = harness(); let resolve, cancellations = 0;
  h.context.openExercisePicker(() => assert.fail('Cancel must not select'), () => { cancellations++; return new Promise(done => { resolve = done; }); });
  const pending = h.context.closeExercisePicker(); h.context.closeExercisePicker();
  assert.equal(cancellations, 1); assert.equal(h.locked(), true); assert.equal(h.scrolls.length, 0);
  resolve(); await pending;
  assert.equal(h.document.activeElement, h.launcher); assert.equal(h.locked(), false);
  h.context.openExercisePicker(() => {}); assert.equal(h.$('#pickerModal').classList.contains('hidden'), false);
});

test('an async failure releases only its own lock, reports the error once and permits a later retry', async () => {
  const h = harness(); let reject, attempts = 0;
  h.lock.acquire('underlying-editor');
  h.context.openExercisePicker(() => { attempts++; return new Promise((resolve, fail) => { reject = fail; }); });
  const choose = h.choices()[0].onclick, pending = choose(); choose();
  assert.equal(h.locked(), true); reject(new Error('Swap could not be saved')); await pending;
  assert.equal(attempts, 1); assert.deepEqual(h.notices, [['Swap could not be saved', 'error']]);
  assert.equal(h.locked(), true); assert.equal(h.document.activeElement, h.launcher);
  h.context.openExercisePicker(() => { attempts++; }); h.choices()[0].onclick();
  assert.equal(attempts, 2); assert.equal(h.locked(), true);
  h.lock.release('underlying-editor'); assert.equal(h.locked(), false); assert.deepEqual(h.scrolls, [[3, 240]]);
});

test('a synchronous callback failure cannot strand the scroll lock or invoke the failed callback twice', () => {
  const h = harness(); let calls = 0;
  h.context.openExercisePicker(() => { calls++; throw new Error('Rendering unavailable'); });
  const choose = h.choices()[0].onclick;
  assert.throws(choose, /Rendering unavailable/); choose();
  assert.equal(calls, 1); assert.equal(h.locked(), false); assert.equal(h.document.activeElement, h.launcher);
});

test('swap category filters include unclassified strength exercises and keep cardio separate', () => {
  const h = harness();
  vm.runInContext("DB.exercises.unknown = {id:'unknown', name:'Unclassified lift', type:'strength'}; DB.exercises.empty = {id:'empty', name:'Unnamed muscle lift', type:'strength', muscle:''}; DB.exercises.oldRun = {id:'oldRun', name:'Old cardio', type:'cardio', muscle:'Chest'}; openExercisePicker(() => {}, null, {filter:'Other',lockedFilter:true})", h.context);
  assert.deepEqual(h.choices().map(choice => choice.children[0].textContent), ['Unclassified lift', 'Unnamed muscle lift']);
  h.context.closeExercisePicker();
  h.context.openExercisePicker(() => {}, null, {filter:'Chest',lockedFilter:true});
  assert.deepEqual(h.choices().map(choice => choice.children[0].textContent), ['Bench press', 'Chest fly']);
  h.context.closeExercisePicker();
  h.context.openExercisePicker(() => {}, null, {filter:'Cardio',lockedFilter:true});
  assert.deepEqual(h.choices().map(choice => choice.children[0].textContent), ['Old cardio', 'Run']);
});
