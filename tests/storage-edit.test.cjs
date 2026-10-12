const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');
const { createStorage, clone, BASE_DEFAULTS, LEGACY_KEY } = require('../storage.js');

function workout(id = 's1') {
  return { id, templateId: 'chest', templateName: 'Chest & Arms',
    start: '2026-10-11T10:00:01.123Z', end: '2026-10-11T11:00:05.456Z',
    entries: { bench: [{ w: 62.5, r: 8, note: 'Keep this', type: 'weight', custom: { old: true } }] },
    order: ['bench'], exerciseNotes: { bench: 'Rest 123' }, notes: 'Original workout',
    extension: { importedFrom: 'legacy', values: [1, 2] } };
}
function database() {
  const db = clone(BASE_DEFAULTS);
  db.exercises.bench = { id: 'bench', name: 'Bench press', type: 'strength', muscle: 'Chest' };
  db.templates.chest = { id: 'chest', name: 'Chest & Arms', exercises: [{ exId: 'bench', sets: 3 }] };
  db.sessions = [workout('s1'), { ...workout('s2'), start: '2026-10-10T10:00:00.000Z', end: '2026-10-10T11:00:00.000Z' }];
  db.bodyweight = [{ date: '2026-10-11', kg: 80.5 }];
  db.goals = { bench: { target: 70 } };
  db.extension = { version: 42 };
  return db;
}
function environment(db = database()) {
  const local = new Map([[LEGACY_KEY, JSON.stringify(db)]]);
  return { indexedDB: new IDBFactory(), localStorage: {
    getItem: key => local.has(key) ? local.get(key) : null,
    setItem: (key, value) => local.set(key, String(value)),
    removeItem: key => local.delete(key)
  } };
}
async function opened(t, env = environment()) {
  const storage = createStorage(env);
  t.after(() => storage.close());
  const initial = await storage.open(clone(BASE_DEFAULTS));
  return { storage, initial, env };
}
const opts = snapshot => ({ epoch: snapshot.epoch });
const isCode = code => error => error.code === code;
const find = (snapshot, id = 's1') => snapshot.db.sessions.find(session => session.id === id);
const unfinished = () => ({ id: 'active', start: '2026-10-12T10:00:00.000Z', entries: {}, order: ['bench'],
  notes: 'In progress', editorDrafts: { bench: { rows: [{ w: '62.', r: '' }], notes: 'Keep my unfinished input' } } });

test('editing one completed workout preserves all other data and the exact active draft', async t => {
  const { storage, initial } = await opened(t);
  const active = await storage.saveDraft(unfinished(), null, opts(initial));
  const baseline = clone(find(initial));
  const next = clone(baseline);
  next.end = '2026-10-11T10:45:01.123Z';
  next.notes = 'Corrected duration';
  next.entries.bench[0].r = 9;
  const result = await storage.editSession(next, baseline, opts(initial));
  const expected = clone(active.db);
  expected.sessions[0] = next;
  assert.deepEqual(result.db, expected);
  assert.deepEqual(result.draft, active.draft);
  assert.equal(result.epoch, active.epoch);
  assert.equal(result.revision, active.revision + 1);
  assert.deepEqual(find(initial), baseline);
  assert.deepEqual(await storage.load(), result);
});

test('two tabs editing different fields of the same workout cannot silently merge or overwrite', async t => {
  const { storage: first, initial, env } = await opened(t);
  const { storage: second } = await opened(t, env);
  const baseline = find(initial);
  const firstEdit = { ...clone(baseline), notes: 'First tab' };
  const secondEdit = clone(baseline);
  secondEdit.entries.bench[0].w = 65;
  const results = await Promise.allSettled([
    first.editSession(firstEdit, baseline, opts(initial)),
    second.editSession(secondEdit, baseline, opts(initial))
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'CONFLICT');
  const winner = results[0].status === 'fulfilled' ? firstEdit : secondEdit;
  const saved = await first.load();
  assert.deepEqual(find(saved), winner);
  assert.equal(saved.revision, initial.revision + 1);
});

test('concurrent edits to separate workouts both persist from the same old snapshot', async t => {
  const { storage: first, initial, env } = await opened(t);
  const { storage: second } = await opened(t, env);
  const one = { ...clone(find(initial, 's1')), notes: 'Updated one' };
  const two = { ...clone(find(initial, 's2')), notes: 'Updated two' };
  await Promise.all([
    first.editSession(one, find(initial, 's1'), opts(initial)),
    second.editSession(two, find(initial, 's2'), opts(initial))
  ]);
  const saved = await first.load();
  assert.deepEqual(find(saved, 's1'), one);
  assert.deepEqual(find(saved, 's2'), two);
  assert.equal(saved.revision, initial.revision + 2);
});

test('stale editor saves retain newer settings, library additions, history and active input', async t => {
  const { storage: first, initial, env } = await opened(t);
  const { storage: second } = await opened(t, env);
  const other = clone(initial.db);
  other.user.theme = 'dark';
  other.exercises.curl = { id: 'curl', name: 'Biceps curl', type: 'strength' };
  other.sessions.unshift({ ...workout('s3'), start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z' });
  const changed = await second.saveDB(other, initial.db, opts(initial));
  const active = await second.saveDraft(unfinished(), null, opts(changed));
  const next = { ...clone(find(initial)), notes: 'My history correction' };
  const saved = await first.editSession(next, find(initial), opts(initial));
  const expected = clone(active.db);
  expected.sessions[expected.sessions.findIndex(session => session.id === next.id)] = next;
  assert.deepEqual(saved.db, expected);
  assert.deepEqual(saved.draft, active.draft);
});

test('deleted workouts are not recreated by an open editor', async t => {
  const { storage, initial } = await opened(t);
  const db = clone(initial.db);
  db.sessions = db.sessions.filter(session => session.id !== 's1');
  const deleted = await storage.saveDB(db, initial.db, opts(initial));
  await assert.rejects(storage.editSession({ ...find(initial), notes: 'Stale edit' }, find(initial), opts(initial)), isCode('CONFLICT'));
  assert.deepEqual(await storage.load(), deleted);
});

test('changes to an unknown session field invalidate the complete baseline', async t => {
  const { storage, initial } = await opened(t);
  const db = clone(initial.db);
  db.sessions[0].extension.values.push(3);
  const changed = await storage.saveDB(db, initial.db, opts(initial));
  await assert.rejects(storage.editSession({ ...find(initial), notes: 'Stale edit' }, find(initial), opts(initial)), isCode('CONFLICT'));
  assert.deepEqual(await storage.load(), changed);
});

test('restoring identical history invalidates an editor from the previous epoch', async t => {
  const { storage, initial } = await opened(t);
  const restored = await storage.restore(initial.db, initial.revision);
  assert.deepEqual(restored.db, initial.db);
  await assert.rejects(storage.editSession({ ...find(initial), notes: 'Old generation' }, find(initial), opts(initial)), isCode('CONFLICT'));
  assert.deepEqual(await storage.load(), restored);
});

test('session ID changes and invalid proposed values leave durable state unchanged', async t => {
  const { storage, initial } = await opened(t);
  const baseline = find(initial);
  const invalid = [
    { ...clone(baseline), id: 'replacement' },
    { ...clone(baseline), end: '2026-10-11T09:59:00.000Z' },
    { ...clone(baseline), entries: { bench: [{ w: -5, r: 8 }] } },
    { ...clone(baseline), entries: { bench: [{ w: Infinity, r: 8 }] } },
    { ...clone(baseline), order: ['bench', 'bench'] },
    JSON.parse(JSON.stringify(baseline).replace('"id":"s1"', '"__proto__":{"unsafe":true},"id":"s1"'))
  ];
  for (const proposed of invalid) assert.throws(() => storage.editSession(proposed, baseline, opts(initial)), isCode('VALIDATION'));
  await assert.rejects(storage.editSession(baseline, baseline), isCode('VALIDATION'));
  await assert.rejects(storage.editSession(baseline, baseline, { epoch: initial.epoch + 1 }), isCode('CONFLICT'));
  assert.deepEqual(await storage.load(), initial);
  assert.equal({}.unsafe, undefined);
});

test('queued edits capture caller inputs and epoch before those objects can change', async t => {
  const { storage, initial } = await opened(t);
  const baseline = clone(find(initial));
  const proposed = { ...clone(baseline), notes: 'Captured proposal' };
  const expected = clone(proposed);
  const options = opts(initial);
  const pending = storage.editSession(proposed, baseline, options);
  proposed.notes = 'Later caller mutation';
  baseline.extension.values.push(99);
  options.epoch += 100;
  const result = await pending;
  assert.deepEqual(find(result), expected);
  result.db.sessions[0].notes = 'Snapshot mutation';
  assert.deepEqual(find(await storage.load()), expected);
});

test('editing start time keeps history in date order and exact values survive reopening', async t => {
  const { storage, initial, env } = await opened(t);
  const proposed = { ...clone(find(initial)), start: '2026-10-09T09:30:02.123Z', end: '2026-10-09T10:15:02.123Z' };
  const result = await storage.editSession(proposed, find(initial), opts(initial));
  assert.deepEqual(result.db.sessions.map(session => session.id), ['s2', 's1']);
  storage.close();
  const { initial: reopened } = await opened(t, env);
  assert.deepEqual(find(reopened), proposed);
  assert.deepEqual(find(reopened, 's2'), find(initial, 's2'));
});

test('legacy sessions without end or blank historical metrics remain editable without normalization', async t => {
  const db = database();
  delete db.sessions[0].end;
  db.sessions[0].entries.bench = [{ w: '', r: null, note: 'Legacy row' }];
  const { storage, initial } = await opened(t, environment(db));
  const proposed = { ...clone(find(initial)), notes: 'Only changed this note' };
  const result = await storage.editSession(proposed, find(initial), opts(initial));
  assert.deepEqual(find(result), proposed);
  assert.equal(Object.hasOwn(find(result), 'end'), false);
});

test('a failed edit transaction preserves history and draft and can be retried', async t => {
  const { storage, initial } = await opened(t);
  const before = await storage.saveDraft(unfinished(), null, opts(initial));
  const proposed = { ...clone(find(before)), notes: 'Retry this change' };
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'state') { this.transaction.abort(); throw new Error('Simulated disk failure'); }
    return originalPut.apply(this, args);
  };
  try { await assert.rejects(storage.editSession(proposed, find(before), opts(before)), isCode('STORAGE')); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await storage.load(), before);
  const saved = await storage.editSession(proposed, find(before), opts(before));
  assert.deepEqual(find(saved), proposed);
  assert.deepEqual(saved.draft, before.draft);
});
