const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const baseline = { id: 'completed', start: '2026-10-01T10:00:00Z', end: '2026-10-01T11:00:00Z', entries: { bench: [{ w: 60, r: 8 }] }, notes: 'Before' };
function historyHarness({ flush = async () => true, renderError = false, commitError = false } = {}) {
  let options, writes = 0, applied = 0;
  const notices = [];
  const context = vm.createContext({
    STORE_READY: true, STORAGE_ERROR: null, COMMITTING: false, UPDATE_LOCK: false, STORAGE_EPOCH: 1,
    DB: { sessions: [baseline], exercises: {} }, LOGGER_SCROLL_LOCK: {},
    LiftLogHistoryEditor: { open(_session, value) { options = value; } },
    getWeightUnit: () => 'kg', askConfirm() {}, openExercisePicker() {}, flushSaves: flush,
    updateSaveStatus() {}, applySnapshot() { applied++; },
    renderHistory() { if (renderError) throw new Error('View could not render'); }, renderDashboard() {}, updateRecapLinks() {},
    showNotice(message) { notices.push(message); }, LiftLogUpdates: { notifySafe() {} },
    STORE: { async editSession() { writes++; if (commitError) throw new Error('disk unavailable'); return { db: {}, draft: null, epoch: 1, revision: 2 }; } }
  });
  const start = app.indexOf('async function editCompletedWorkout(');
  vm.runInContext(app.slice(start, app.indexOf('\nLiftLogRecaps.configure(', start)), context);
  context.editCompletedWorkout(baseline.id);
  return { context, save: () => options.saveSession({ ...baseline, notes: 'After' }, baseline), get writes() { return writes; }, get applied() { return applied; }, notices };
}

test('history save either owns the commit lock before flushing or respects a lock acquired during the flush', async () => {
  const gate = deferred(), h = historyHarness({ flush: () => gate.promise });
  const pending = h.save();
  const acquiredBeforeFlush = h.context.COMMITTING;
  if (!acquiredBeforeFlush) h.context.COMMITTING = true; // A previously pending operation acquired its lock.
  gate.resolve(true);
  const result = await pending;
  if (acquiredBeforeFlush) {
    assert.equal(result.ok, true); assert.equal(h.writes, 1); assert.equal(h.context.COMMITTING, false);
  } else {
    assert.equal(result.ok, false, 'must not overlap a commit that acquired the lock during await');
    assert.equal(h.writes, 0);
    assert.equal(h.context.COMMITTING, true, 'must not release another operation’s commit lock');
  }
});

test('a history edit committed to storage is reported saved even if the following screen refresh fails', async () => {
  const h = historyHarness({ renderError: true });
  const result = await h.save();
  assert.equal(h.writes, 1); assert.equal(h.applied, 1);
  assert.equal(result.ok, true, 'returning failure here leaves the editor open against an already replaced baseline');
  assert.equal(h.context.COMMITTING, false);
});

test('an actual failed history write remains unsaved and releases only its own lock', async () => {
  const h = historyHarness({ commitError: true });
  const result = await h.save();
  assert.equal(result.ok, false); assert.equal(h.applied, 0); assert.equal(h.context.COMMITTING, false);
});

test('a late active-workout drag cannot reorder a draft while its completion or update is locked', () => {
  const start = app.indexOf('function moveActiveExercise(');
  const source = app.slice(start, app.indexOf('// Global pointer handlers', start));
  for (const [lock, value] of [['COMMITTING', true], ['FINISHING', true], ['UPDATE_LOCK', true], ['STARTING', true], ['STORE_READY', false], ['STORAGE_ERROR', new Error('Storage unavailable')]]) {
    let renders = 0;
    const order = ['bench', 'curl', 'press'];
    const context = vm.createContext({ ACTIVE_SESSION: { order: order.slice() }, COMMITTING: false, FINISHING: false, UPDATE_LOCK: false, STARTING: false, STORE_READY: true, STORAGE_ERROR: null, renderActiveSession() { renders++; } });
    context[lock] = value;
    vm.runInContext(source, context); context.moveActiveExercise(0, 2);
    assert.deepEqual(Array.from(context.ACTIVE_SESSION.order), order, `${lock} must keep the captured workout order stable`);
    assert.equal(renders, 0);
  }
});
