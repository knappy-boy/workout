const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function harness(exercises = {}, options = {}) {
  const nodes = new Map();
  const document = { body: { style: {} }, querySelector: () => null };
  const origin = { isConnected: true, focus() { document.activeElement = this; } };
  document.activeElement = origin;
  const controlIds = ['#btnCloseExModal', '#newExName', '#newExType', '#newExMuscle', '#newExEquip', '#newExLoadType', '#newExCardioMetric', '#btnSaveEx', '#btnDeleteEx'];
  const removed = new Set(['#newExCompound', '#secondaryMusclesWrapper', '#secondaryMusclesList', '#settingCompound']);
  const $ = selector => {
    assert.ok(!removed.has(selector), `removed control still accessed: ${selector}`);
    if (!nodes.has(selector)) {
      const classes = new Set(selector === '#addExModal' ? ['hidden'] : []);
      nodes.set(selector, {
        value: '', checked: false, textContent: '', listeners: {}, disabled: false, isConnected: true,
        classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name) },
        querySelectorAll: () => controlIds.map($), getClientRects: () => classes.has('hidden') ? [] : [{}],
        focus() { document.activeElement = this; }, reportValidity() { this.reportedValidity = true; },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        dispatchEvent(event) { this.listeners[event.type]?.({...event, target: this}); }
      });
    }
    return nodes.get(selector);
  };
  let saved;
  const DB = { user: { includeCompound: true }, exercises: clone(exercises), sessions: [{ id: 'history', entries: { bench: [{ w: '60', r: '8' }] } }] };
  const context = vm.createContext({
    $, DB, LiftLogExerciseLoad: require('../exercise-load.js'), _createdExerciseCallback: null, _createdExerciseCancelCallback: null,
    LOGGER_SCROLL_LOCK: { acquire() { document.body.style.overflow = "hidden"; }, release() { document.body.style.overflow = ""; } }, uid: () => 'new-exercise',
    Event: class { constructor(type) { this.type = type; } }, ACTIVE_SESSION: options.draft || null, document, askConfirm: options.confirm || (async () => true),
    saveDB: options.save || (async () => { saved = clone(DB); return true; }), renderExerciseLibrary() {}
  });
  vm.runInContext(source.slice(source.indexOf('// --- MODAL WORKFLOW HELPERS ---'), source.indexOf('// --- TABS & NAVIGATION ---')), context);
  const start = source.indexOf('let EDITING_EXERCISE_ID = null;');
  vm.runInContext(source.slice(start, source.indexOf('// --- WORKOUT LOGGING ---', start)), context);
  return { $, DB, context, document, origin, save: () => $('#btnSaveEx').listeners.click(), archive: () => $('#btnDeleteEx').listeners.click(), get saved() { return saved; } };
}

test('editing a primary muscle preserves hidden legacy exercise metadata and existing history', async () => {
  const legacy = {
    id: 'bench', name: 'Bench', type: 'strength', muscle: 'Chest', equip: 'barbell', increment: 2.5,
    isAssisted: true, isCompound: true, secondaryMuscles: ['Triceps', 'Shoulders'],
    archived: false, importedDetails: { source: 'original backup' }
  };
  const h = harness({ bench: legacy });
  const history = clone(h.DB.sessions);
  h.context.editExercise('bench');
  h.$('#newExName').value = 'Close-grip bench';
  h.$('#newExMuscle').value = 'Triceps';
  await h.save();
  assert.equal(h.saved.exercises.bench.name, 'Close-grip bench');
  assert.equal(h.saved.exercises.bench.muscle, 'Triceps');
  assert.equal(h.saved.exercises.bench.isAssisted, true);
  assert.equal(h.saved.exercises.bench.isCompound, true);
  assert.deepEqual(h.saved.exercises.bench.secondaryMuscles, legacy.secondaryMuscles);
  assert.deepEqual(h.saved.exercises.bench.importedDetails, legacy.importedDetails);
  assert.deepEqual(h.saved.sessions, history);
  assert.equal(h.saved.user.includeCompound, true);
});

test('new exercises save a single primary muscle without adding legacy compound fields', async () => {
  const h = harness();
  h.$('#newExName').value = 'Assisted pull-up';
  h.$('#newExType').value = 'strength';
  h.$('#newExMuscle').value = 'Back';
  h.$('#newExEquip').value = 'machine';
  h.$('#newExInc').value = '2.5';
  h.$('#newExLoadType').value = 'assisted';
  await h.save();
  const exercise = h.saved.exercises['new-exercise'];
  assert.equal(exercise.muscle, 'Back');
  assert.equal(exercise.isAssisted, false);
  assert.equal(exercise.loadType, 'assisted');
  assert.ok(!Object.hasOwn(exercise, 'isCompound'));
  assert.ok(!Object.hasOwn(exercise, 'secondaryMuscles'));
});

test('editor focuses its heading, contains keyboard focus, and restores the launcher on cancel', () => {
  const h = harness({ bench: { id: 'bench', name: 'Bench', type: 'strength' } });
  h.context.editExercise('bench');
  assert.equal(h.document.activeElement, h.$('#exModalTitle'));
  assert.equal(h.document.body.style.overflow, 'hidden');
  let prevented = 0;
  const key = (value, shiftKey = false) => h.$('#addExModal').listeners.keydown({ key: value, shiftKey, preventDefault() { prevented++; } });
  key('Tab'); assert.equal(h.document.activeElement, h.$('#btnCloseExModal'));
  key('Tab', true); assert.equal(h.document.activeElement, h.$('#btnDeleteEx'));
  key('Tab'); assert.equal(h.document.activeElement, h.$('#btnCloseExModal'));
  key('Escape');
  assert.equal(h.$('#addExModal').classList.contains('hidden'), true);
  assert.equal(h.document.activeElement, h.origin);
  assert.equal(h.document.body.style.overflow, '');
  assert.equal(prevented, 4);
});

test('a pending save prevents duplicate commits and closing, and failure keeps the editor available', async () => {
  let settle, writes = 0;
  const h = harness({ bench: { id: 'bench', name: 'Bench', type: 'strength' } }, { save: () => { writes++; return new Promise(resolve => { settle = resolve; }); } });
  h.context.editExercise('bench');
  const pending = h.save();
  assert.equal(h.$('#btnSaveEx').disabled, true);
  await h.save(); h.context.closeExerciseModal();
  assert.equal(writes, 1); assert.equal(h.$('#addExModal').classList.contains('hidden'), false);
  settle(false); await pending;
  assert.equal(h.$('#btnSaveEx').disabled, false);
  assert.equal(h.$('#addExModal').classList.contains('hidden'), false);
});

test('archiving waits for a successful save and does not remove the exercise or past entries', async () => {
  const h = harness({ bench: { id: 'bench', name: 'Bench', type: 'strength', custom: { keep: true } } });
  const history = clone(h.DB.sessions);
  h.context.editExercise('bench'); await h.archive();
  assert.equal(h.saved.exercises.bench.archived, true);
  assert.deepEqual(h.saved.exercises.bench.custom, { keep: true });
  assert.deepEqual(h.saved.sessions, history);
  assert.equal(h.$('#addExModal').classList.contains('hidden'), true);
  const cancelled = harness({ bench: { id: 'bench', name: 'Bench', type: 'strength' } }, { confirm: async () => false });
  cancelled.context.editExercise('bench'); await cancelled.archive();
  assert.equal(cancelled.DB.exercises.bench.archived, undefined); assert.equal(cancelled.saved, undefined);
});

test('zero increments, cardio settings and unknown metadata survive a name-only edit', async () => {
  const strength = harness({ bench: { id: 'bench', name: 'Bench', type: 'strength', increment: 0, custom: ['kept'] } });
  strength.context.editExercise('bench'); await strength.save();
  assert.equal(strength.saved.exercises.bench.increment, 0);
  assert.deepEqual(strength.saved.exercises.bench.custom, ['kept']);
  const cardio = harness({ stairs: { id: 'stairs', name: 'Stairs', type: 'cardio', cardioMetric: 'floors', cardioGoal: 'speed', extra: 'keep' } });
  cardio.context.editExercise('stairs'); cardio.$('#newExName').value = 'Stair climber'; await cardio.save();
  assert.equal(cardio.saved.exercises.stairs.cardioMetric, 'floors');
  assert.equal(cardio.saved.exercises.stairs.cardioGoal, 'speed');
  assert.equal(cardio.saved.exercises.stairs.extra, 'keep');
});

test('changing a default load type preserves legacy assistance flags and all historical raw rows', async () => {
  for (const legacyFlag of [true, false, undefined]) {
    const original={id:'bench',name:'Dips',type:'strength',...(legacyFlag === undefined ? {}:{isAssisted:legacyFlag})};
    const h=harness({bench:original}); const before=clone(h.DB.sessions);
    h.context.editExercise('bench');
    assert.equal(h.$('#newExLoadType').value,legacyFlag ? 'assisted':'external');
    h.$('#newExLoadType').value='weighted'; await h.save();
    assert.equal(h.saved.exercises.bench.loadType,'weighted');
    assert.equal(h.saved.exercises.bench.isAssisted,legacyFlag);
    assert.equal(Object.hasOwn(h.saved.exercises.bench,'isAssisted'),Object.hasOwn(original,'isAssisted'));
    assert.deepEqual(h.saved.sessions,before);
  }
});


test('recorded exercise type changes cannot hide saved history or unfinished rows, including blank placeholders', async () => {
  for (const draft of [null, {entries:{},logDrafts:{bench:{rows:[{a:'45',b:''}]}}}, {entries:{},logDrafts:{bench:{rows:[{a:'',b:''}]}}}]) {
    const messages=[];
    const h=harness({bench:{id:'bench',name:'Bench',type:'strength'}},{draft,confirm:async(...args)=>{messages.push(args);return true;}});
    if(draft) h.DB.sessions=[];
    const before=clone(h.DB);
    h.context.editExercise('bench');h.$('#newExType').value='cardio';h.$('#newExName').value='Changed name';
    await h.save();
    assert.deepEqual(h.DB,before);assert.equal(h.saved,undefined);
    assert.equal(h.$('#newExType').value,'strength');assert.equal(h.document.activeElement,h.$('#newExType'));
    assert.equal(messages.length,1);assert.match(messages[0][1],/separate exercise/);
    assert.equal(h.$('#addExModal').classList.contains('hidden'),false);
  }
  const h=harness({run:{id:'run',name:'Run',type:'cardio',cardioMetric:'km'}});
  h.DB.sessions=[{entries:{run:[{time:'20',dist:'4'}]}}];
  const before=clone(h.DB);
  h.context.editExercise('run');h.$('#newExType').value='strength';await h.save();
  assert.deepEqual(h.DB,before);assert.equal(h.$('#newExType').value,'cardio');assert.equal(h.saved,undefined);
});

test('an unused exercise can change type and a new entry can use either type without altering another exercise history', async () => {
  const h=harness({unused:{id:'unused',name:'Unused',type:'strength'}});
  h.context.editExercise('unused');h.$('#newExType').value='cardio';h.$('#newExCardioMetric').value='km';await h.save();
  assert.equal(h.saved.exercises.unused.type,'cardio');assert.equal(h.saved.sessions[0].entries.bench[0].w,'60');
});

test('a freshly opened exercise editor resets its internal scroll independently of saved workout data', () => {
  const h=harness({bench:{id:'bench',name:'Bench',type:'strength'}}),before=clone(h.DB);
  h.$('#addExModal .exercise-editor-body').scrollTop=240;
  h.context.editExercise('bench');
  assert.equal(h.$('#addExModal .exercise-editor-body').scrollTop,0);
  assert.deepEqual(h.DB,before);
});
