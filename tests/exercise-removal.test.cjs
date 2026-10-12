const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const storage = require('../storage.js');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function session(extra = {}) {
  return { id: 'active', start: '2026-10-12T12:00:00.000Z', order: ['bench', 'row'], entries: {}, notes: 'Workout notes', ...extra };
}
function harness({ draft = session(), answer = async () => true, save = async () => true } = {}) {
  let prompts = 0, writes = 0, renders = 0, clears = 0;
  const notices = [];
  const context = vm.createContext({
    ACTIVE_SESSION: clone(draft), DB: { exercises: { bench: { name: 'Bench press' }, row: { name: 'Row' } } },
    LOG_SAVING: false, REMOVING_EXERCISE: false, CURRENT_LOG_EX: null,
    COMMITTING: false, FINISHING: false, UPDATE_LOCK: false, STARTING: false, STORE_READY: true, STORAGE_ERROR: null, STORAGE_EPOCH: 1,
    copyState: clone, LiftLogStorage: storage, LiftLogUpdates: { notifySafe() {} },
    clearActiveDrag() { clears++; }, updateSaveStatus() {}, showNotice: value => notices.push(value),
    storageFailure(error) { context.STORAGE_ERROR = error; },
    askConfirm: (...args) => { prompts++; return answer(...args); },
    saveDraft: async () => { writes++; return save(context); },
    renderActiveSession() { renders++; }
  });
  const start = source.indexOf('async function removeExerciseFromSession(');
  vm.runInContext(source.slice(start, source.indexOf('\nfunction loggerRows()', start)), context);
  return { context, notices, remove: () => context.removeExerciseFromSession('bench'),
    get prompts() { return prompts; }, get writes() { return writes; }, get renders() { return renders; }, get clears() { return clears; } };
}

test('every removal asks first and cancellation preserves empty rows, saved notes, and unfinished edits exactly', async () => {
  for (const draft of [
    session(),
    session({ exerciseNotes: { bench: 'Only a saved exercise note' } }),
    session({ entries: { bench: [{ w: '60', r: '8', note: 'Set note' }] }, exerciseNotes: { bench: 'Saved note' }, logDrafts: { bench: { rows: [{ a: '62.5', b: '' }], notes: 'Draft note', unit: 'kg' } } })
  ]) {
    const h = harness({ draft, answer: async () => false });
    await h.remove();
    assert.equal(h.prompts, 1);
    assert.equal(h.writes, 0);
    assert.deepEqual(clone(h.context.ACTIVE_SESSION), draft);
    assert.equal(h.context.REMOVING_EXERCISE, false);
  }
});

test('confirmed removal saves once, discards only that exercise, and accepts persistence replacing the draft object', async () => {
  const draft = session({ entries: { bench: [{ w: '60', r: '8' }], row: [{ w: '20', r: '10' }] },
    exerciseNotes: { bench: 'Bench note', row: 'Keep row note' }, logDrafts: { bench: { rows: [{ a: '62.5', b: '' }], notes: 'Unfinished' } } });
  const h = harness({ draft, save: async context => {
    assert.equal(context.COMMITTING, true, 'lock must cover asynchronous persistence');
    context.ACTIVE_SESSION = clone(context.ACTIVE_SESSION);
    return true;
  } });
  await h.remove();
  assert.equal(h.prompts, 1); assert.equal(h.writes, 1); assert.equal(h.renders, 1);
  assert.deepEqual(clone(h.context.ACTIVE_SESSION), { ...draft, order: ['row'], entries: { row: draft.entries.row }, exerciseNotes: { row: 'Keep row note' }, logDrafts: {} });
  assert.equal(h.context.COMMITTING, false);
});

test('storage failure restores order, exact missing fields, saved sets, exercise notes, and partial input', async () => {
  for (const draft of [session(), session({ entries: { bench: [{ w: '60', r: '8' }] }, exerciseNotes: { bench: 'Saved note' }, logDrafts: { bench: { rows: [{ a: '62.5', b: '' }], notes: 'Draft note', unit: 'kg' } } })]) {
    for (const rejects of [false, true]) {
      const h = harness({ draft, save: async context => {
        context.ACTIVE_SESSION = clone(context.ACTIVE_SESSION);
        if (rejects) throw new Error('Storage failed');
        return false;
      } });
      await h.remove();
      assert.deepEqual(clone(h.context.ACTIVE_SESSION), draft);
      assert.equal(h.context.COMMITTING, false); assert.equal(h.context.REMOVING_EXERCISE, false);
      assert.equal(h.renders, 0);
    }
  }
});

test('a changed workout or generation while confirmation is open cannot authorize a later deletion', async () => {
  for (const change of [
    c => { c.ACTIVE_SESSION = session({ id: 'another-workout' }); },
    c => { c.ACTIVE_SESSION = null; },
    c => { c.ACTIVE_SESSION.notes = 'New workout note'; },
    c => { c.ACTIVE_SESSION.entries.bench = [{ w: '70', r: '5' }]; },
    c => { c.STORAGE_EPOCH++; },
    c => { c.COMMITTING = true; },
    c => { c.FINISHING = true; },
    c => { c.UPDATE_LOCK = true; },
    c => { c.LOG_SAVING = true; },
    c => { c.CURRENT_LOG_EX = 'row'; }
  ]) {
    const confirmation = deferred(), h = harness({ answer: () => confirmation.promise });
    const pending = h.remove();
    change(h.context); const latest = clone(h.context.ACTIVE_SESSION), wasCommitting = h.context.COMMITTING;
    confirmation.resolve(true); await pending;
    assert.equal(h.writes, 0);
    assert.deepEqual(clone(h.context.ACTIVE_SESSION), latest);
    assert.equal(h.context.COMMITTING, wasCommitting, 'must not clear another operation’s lock');
  }
});

test('duplicate removal taps share one confirmation and do not start competing writes', async () => {
  const confirmation = deferred(), h = harness({ answer: () => confirmation.promise });
  const first = h.remove();
  await h.remove();
  assert.equal(h.prompts, 1);
  confirmation.resolve(true); await first;
  assert.equal(h.writes, 1);
});

test('an ordinary saved copy during confirmation remains eligible, without relying on object identity', async () => {
  const confirmation = deferred(), h = harness({ answer: () => confirmation.promise });
  const pending = h.remove();
  h.context.ACTIVE_SESSION = clone(h.context.ACTIVE_SESSION);
  confirmation.resolve(true); await pending;
  assert.equal(h.writes, 1);
  assert.deepEqual(Array.from(h.context.ACTIVE_SESSION.order), ['row']);
});

test('failed removal never restores deleted fields into a replacement workout or overwrites unrelated edits', async () => {
  const draft = session({ exerciseNotes: { bench: 'Keep this exercise note' } });
  const changed = harness({ draft, save: async context => {
    context.ACTIVE_SESSION.notes = 'Changed during async save';
    return false;
  } });
  await changed.remove();
  assert.equal(changed.context.ACTIVE_SESSION.notes, 'Changed during async save');
  assert.equal(changed.context.ACTIVE_SESSION.exerciseNotes.bench, 'Keep this exercise note');
  const replacement = session({ id: 'replacement', order: ['row'] });
  const replaced = harness({ draft, save: async context => { context.ACTIVE_SESSION = clone(replacement); return false; } });
  await replaced.remove();
  assert.deepEqual(clone(replaced.context.ACTIVE_SESSION), replacement);
});
