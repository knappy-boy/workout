const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');
const { createStorage, parseBackup, migrateDB, mergeDB, clone, BASE_DEFAULTS, LEGACY_KEY } = require('../storage.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data.json'), 'utf8'));
const empty = () => clone(BASE_DEFAULTS);
const workout = (id = 's1') => ({ id, start: '2026-10-11T10:00:00.000Z', end: '2026-10-11T11:00:00.000Z', entries: {}, order: [] });
const draft = (id = 'd1') => ({ id, start: '2026-10-11T10:00:00.000Z', entries: {}, order: [], notes: '' });
function environment(legacy = null) {
  const local = new Map(legacy === null ? [] : [[LEGACY_KEY, legacy]]);
  return {
    indexedDB: new IDBFactory(),
    localStorage: { getItem: key => local.has(key) ? local.get(key) : null,
      setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) },
    local
  };
}
const opts = saved => ({ epoch: saved.epoch });
const isCode = code => error => error.code === code;
async function opened(env = environment()) {
  const storage = createStorage(env);
  const initial = await storage.open(empty());
  return { storage, initial, env };
}

test('legacy fixture migration preserves complete workout, routine, exercise and bodyweight records', () => {
  const result = parseBackup(fixture);
  assert.deepEqual(result.sessions, fixture.data.sessions);
  assert.deepEqual(result.exercises, fixture.data.exercises);
  assert.deepEqual(result.templates, fixture.data.templates);
  assert.deepEqual(result.bodyweight, fixture.data.bodyweight);
  assert.equal(result.user.useLbs, false);
  assert.equal(result.sessions.length, 30);
  assert.equal(typeof result.sessions[0].entries.ex2[0].w, 'string');
});

test('migration supplies optional collections and order, respects legacy pounds', () => {
  const value = { user: { unit: 'lbs' }, exercises: {}, sessions: [{ ...workout(), order: undefined }] };
  delete value.sessions[0].order;
  const result = migrateDB(value);
  assert.equal(result.user.useLbs, true);
  assert.deepEqual(result.sessions[0].order, []);
  assert.deepEqual(result.bodyweight, []);
  assert.equal(value.user.unit, 'lbs');
});

test('valid orphaned exercise references and historical empty sets remain intact', () => {
  const db = empty();
  db.sessions.push({ ...workout(), order: ['deletedExercise'], entries: { deletedExercise: [{ w: '', r: '', note: 'historical' }] } });
  assert.deepEqual(parseBackup(db).sessions, db.sessions);
});

test('backup validation rejects malformed shapes, unsupported versions, unsafe IDs, duplicates and impossible numbers', () => {
  const invalid = [
    '{}', '[]', '{', { version: 2, data: empty() }, { version: '1', data: empty() },
    { ...empty(), sessions: {} }, { ...empty(), exercises: [] },
    { ...empty(), sessions: [workout(), workout()] },
    { ...empty(), sessions: [{ ...workout(), start: 'yesterday' }] },
    { ...empty(), sessions: [{ ...workout(), id: 'x\" onclick=alert(1)' }] },
    { ...empty(), sessions: [{ ...workout(), entries: { ex1: [{ w: 'Infinity', r: 2 }] } }] },
    { ...empty(), bodyweight: [{ date: '2026-10-11', kg: -1 }] },
    { ...empty(), user: { useLbs: 'false' } },
    JSON.parse('{"exercises":{},"sessions":[],"__proto__":{"polluted":true}}'),
    { ...empty(), exercises: { x: { id: 'different', name: 'Test', type: 'strength' } } }
  ];
  for (const input of invalid) assert.throws(() => parseBackup(input));
  assert.equal({}.polluted, undefined);
});

test('text content is preserved as text for caller escaping, without accepting unsafe IDs', () => {
  const db = empty();
  db.exercises.ex1 = { id: 'ex1', name: '<img src=x onerror=alert(1)>', type: 'strength' };
  assert.equal(parseBackup(db).exercises.ex1.name, db.exercises.ex1.name);
});

test('legacy cardio exercises with nullable strength-only fields remain valid', () => {
  const db = empty();
  db.exercises.cardio = { id: 'cardio', name: 'Bike', type: 'cardio', increment: null,
    muscle: null, equip: null, cardioGoal: 'endurance' };
  assert.deepEqual(parseBackup(db).exercises, db.exercises);
});

test('three-way merge preserves independent additions and stale settings changes', () => {
  const base = empty(), local = empty(), current = empty();
  local.user.theme = 'dark';
  local.sessions.push(workout('s2'));
  current.sessions.push(workout('s1'));
  current.user.useLbs = true;
  const result = mergeDB(base, local, current);
  assert.deepEqual(new Set(result.sessions.map(s => s.id)), new Set(['s1', 's2']));
  assert.equal(result.user.theme, 'dark');
  assert.equal(result.user.useLbs, true);
});

test('three-way merge respects deliberate deletions without deleting unrelated records', () => {
  const base = empty(); base.sessions.push(workout('s1'));
  const local = clone(base), current = clone(base);
  local.sessions = [];
  current.sessions.push(workout('s2'));
  assert.deepEqual(mergeDB(base, local, current).sessions.map(s => s.id), ['s2']);
});

test('concurrent same-field edits and delete-versus-edit fail explicitly', () => {
  const base = empty(), local = empty(), current = empty();
  local.user.increment = 5; current.user.increment = 10;
  assert.throws(() => mergeDB(base, local, current), isCode('CONFLICT'));
  base.sessions.push(workout());
  current.sessions.push({ ...workout(), notes: 'edited elsewhere' });
  assert.throws(() => mergeDB(base, local, current), isCode('CONFLICT'));
});

test('duplicate legacy bodyweight timestamps are never collapsed', () => {
  const base = empty();
  base.bodyweight.push({ date: '2026-10-11T10:00:00Z', kg: 80 }, { date: '2026-10-11T10:00:00Z', kg: 81 });
  const local = clone(base), current = clone(base);
  local.user.theme = 'dark';
  assert.equal(mergeDB(base, local, current).bodyweight.length, 2);
});

test('IndexedDB imports legacy exactly once and never modifies its original localStorage key', async () => {
  const raw = JSON.stringify(fixture.data), env = environment(raw);
  const { storage, initial } = await opened(env);
  assert.deepEqual(initial.db.sessions, fixture.data.sessions);
  assert.equal(env.local.get(LEGACY_KEY), raw);
  const next = clone(initial.db); next.user.theme = 'dark';
  await storage.saveDB(next, initial.db, opts(initial));
  storage.close();
  const reopened = createStorage(env);
  const loaded = await reopened.open(empty());
  assert.equal(loaded.db.user.theme, 'dark');
  assert.equal(loaded.db.sessions.length, 30);
  const recovery = await reopened.exportRecovery();
  assert.equal(recovery.recovery.length, 1);
  assert.equal(recovery.recovery[0].raw, raw);
  assert.equal(env.local.get(LEGACY_KEY), raw);
  reopened.close();
});

test('corrupt legacy data prevents empty initialization and remains exportable and replaceable by explicit restore', async () => {
  const raw = '{broken', env = environment(raw), storage = createStorage(env);
  await assert.rejects(storage.open(empty()), isCode('VALIDATION'));
  assert.equal((await storage.exportRecovery()).legacyRaw, raw);
  await assert.rejects(storage.load());
  const restored = await storage.restore(fixture, 0);
  assert.equal(restored.db.sessions.length, 30);
  assert.equal(restored.epoch, 1);
  assert.equal(env.local.get(LEGACY_KEY), raw);
  assert.equal((await storage.exportRecovery()).recovery[0].legacyRaw, raw);
  storage.close();
});

test('blocked legacy localStorage access fails closed instead of losing data', async () => {
  const env = environment();
  env.localStorage.getItem = () => { throw new Error('SecurityError'); };
  const storage = createStorage(env);
  await assert.rejects(storage.open(empty()), isCode('STORAGE'));
  await assert.rejects(storage.load());
  storage.close();
});

test('legacy recovery remains downloadable when IndexedDB itself is unavailable', async () => {
  const raw = JSON.stringify(fixture), env = environment(raw);
  env.indexedDB = null;
  const storage = createStorage(env);
  await assert.rejects(storage.open(empty()), isCode('STORAGE'));
  const result = await storage.exportRecovery();
  assert.equal(result.legacyRaw, raw);
  assert.equal(result.databaseUnavailable, true);
  assert.equal(env.local.get(LEGACY_KEY), raw);
});

test('reload recovers unfinished sets, notes, exercise order, timer and partially typed editor values', async () => {
  const { storage, initial, env } = await opened();
  const active = { ...draft(), order: ['ex1'], entries: { ex1: [{ w: 60, r: 8 }] },
    notes: 'Keep elbows tucked', exerciseNotes: { ex1: 'Pause' },
    logDrafts: { ex1: [{ value1: '62.', value2: '' }] }, restTimer: { endsAt: 1791712860000 } };
  await storage.saveDraft(active, null, opts(initial));
  storage.close();
  const reopened = createStorage(env), result = await reopened.open(empty());
  assert.deepEqual(result.draft, active);
  reopened.close();
});

test('caller mutations after save invocation cannot change pending writes or returned snapshots', async () => {
  const { storage, initial } = await opened();
  const active = draft();
  const pending = storage.saveDraft(active, null, opts(initial));
  active.notes = 'Changed too late';
  const result = await pending;
  assert.equal(result.draft.notes, '');
  result.draft.notes = 'Mutated result';
  assert.equal((await storage.load()).draft.notes, '');
  storage.close();
});

test('two tabs concurrently adding workouts preserve both records transactionally', async () => {
  const env = environment();
  const a = createStorage(env), b = createStorage(env);
  const [sa, sb] = await Promise.all([a.open(empty()), b.open(empty())]);
  const da = clone(sa.db), db = clone(sb.db);
  da.sessions.push(workout('sa')); db.sessions.push(workout('sb'));
  await Promise.all([a.saveDB(da, sa.db, opts(sa)), b.saveDB(db, sb.db, opts(sb))]);
  assert.deepEqual(new Set((await a.load()).db.sessions.map(s => s.id)), new Set(['sa', 'sb']));
  a.close(); b.close();
});

test('stale tab settings save cannot erase a newly finished workout', async () => {
  const env = environment();
  const a = createStorage(env), b = createStorage(env);
  const sa = await a.open(empty()), sb = await b.open(empty());
  const active = draft();
  await a.saveDraft(active, null, opts(sa));
  await a.finishWorkout({ ...active, end: '2026-10-11T11:00:00Z' }, active, opts(sa));
  const settings = clone(sb.db); settings.user.theme = 'dark';
  const result = await b.saveDB(settings, sb.db, opts(sb));
  assert.equal(result.db.sessions.length, 1);
  assert.equal(result.db.user.theme, 'dark');
  a.close(); b.close();
});

test('two tabs cannot silently overwrite or discard each other’s unfinished workout', async () => {
  const env = environment();
  const a = createStorage(env), b = createStorage(env);
  const sa = await a.open(empty()), sb = await b.open(empty());
  await a.saveDraft(draft('first'), null, opts(sa));
  await assert.rejects(b.saveDraft(draft('second'), null, opts(sb)), isCode('CONFLICT'));
  await assert.rejects(b.saveDraft(null, draft('second'), opts(sb)), isCode('CONFLICT'));
  assert.equal((await a.load()).draft.id, 'first');
  a.close(); b.close();
});

test('finish is atomic, retry is idempotent, and stale draft cannot resurrect completed workout', async () => {
  const { storage, initial } = await opened();
  const active = draft(), complete = { ...active, end: '2026-10-11T11:00:00Z' };
  await storage.saveDraft(active, null, opts(initial));
  const result = await storage.finishWorkout(complete, active, opts(initial));
  assert.equal(result.draft, null);
  assert.equal(result.db.sessions.length, 1);
  await storage.finishWorkout(complete, active, opts(initial));
  assert.equal((await storage.load()).db.sessions.length, 1);
  await assert.rejects(storage.saveDraft(active, null, opts(initial)), isCode('CONFLICT'));
  storage.close();
});

test('failed finish keeps active draft and does not add a partial historical workout', async () => {
  const { storage, initial } = await opened();
  const active = draft();
  await storage.saveDraft(active, null, opts(initial));
  const updated = { ...active, notes: 'newer' };
  await storage.saveDraft(updated, active, opts(initial));
  await assert.rejects(storage.finishWorkout({ ...active, end: '2026-10-11T11:00:00Z' }, active, opts(initial)), isCode('CONFLICT'));
  const saved = await storage.load();
  assert.deepEqual(saved.draft, updated);
  assert.equal(saved.db.sessions.length, 0);
  storage.close();
});

test('invalid restore leaves database, revision and draft unchanged', async () => {
  const { storage, initial } = await opened();
  const saved = await storage.saveDraft(draft(), null, opts(initial));
  assert.throws(() => storage.restore({ version: 1, data: { exercises: {}, sessions: {} } }, saved.revision), isCode('VALIDATION'));
  assert.deepEqual(await storage.load(), saved);
  assert.equal((await storage.exportRecovery()).recovery.length, 0);
  storage.close();
});

test('version 1 backups can round-trip an active workout and its editor metadata', async () => {
  const { storage, initial } = await opened();
  const active = { ...draft(), logDrafts: { ex1: { unit: 'lbs', rows: [{ value1: '100', value2: '8', originalKg: 45.3592, originalDisplay: '100' }] } } };
  const backup = { version: 1, data: fixture.data, draft: active };
  assert.deepEqual(storage.parseBackupEnvelope(backup).draft, active);
  const result = await storage.restore(JSON.stringify(backup), initial.revision);
  assert.deepEqual(result.draft, active);
  assert.equal(result.db.sessions.length, 30);
  const bad = { ...backup, draft: { ...active, id: fixture.data.sessions[0].id } };
  assert.throws(() => storage.validateBackup(bad), isCode('VALIDATION'));
  assert.deepEqual(await storage.load(), result);
  storage.close();
});

test('repeated open returns the current saved snapshot', async () => {
  const { storage, initial } = await opened();
  const saved = await storage.saveDraft(draft(), null, opts(initial));
  assert.deepEqual(await storage.open(empty()), saved);
  storage.close();
});

test('notification failure cannot turn a successfully committed write into a save error', async () => {
  const env = environment();
  env.BroadcastChannel = class { postMessage() { throw new Error('Channel unavailable'); } close() {} };
  env.localStorage.setItem = () => { throw new Error('LocalStorage unavailable'); };
  const { storage, initial } = await opened(env);
  const saved = await storage.saveDraft(draft(), null, opts(initial));
  assert.deepEqual(await storage.load(), saved);
  storage.close();
});

test('restore creates a full rollback snapshot and epoch blocks all stale writes', async () => {
  const { storage, initial } = await opened();
  const active = draft();
  const previous = await storage.saveDraft(active, null, opts(initial));
  const restored = await storage.restore(fixture, previous.revision);
  const recovery = await storage.exportRecovery();
  assert.deepEqual(recovery.recovery[0].state.draft, active);
  assert.equal(restored.db.sessions.length, 30);
  assert.equal(restored.draft, null);
  assert.equal(restored.epoch, previous.epoch + 1);
  const stale = clone(initial.db); stale.user.theme = 'dark';
  await assert.rejects(storage.saveDB(stale, initial.db, opts(initial)), isCode('CONFLICT'));
  await assert.rejects(storage.saveDraft(active, null, opts(initial)), isCode('CONFLICT'));
  await assert.rejects(storage.finishWorkout({ ...active, end: '2026-10-11T11:00:00Z' }, active, opts(initial)), isCode('CONFLICT'));
  assert.deepEqual(await storage.load(), restored);
  storage.close();
});

test('restore refuses a stale confirmation revision', async () => {
  const { storage, initial } = await opened();
  const saved = await storage.saveDraft(draft(), null, opts(initial));
  await assert.rejects(storage.restore(fixture, initial.revision), isCode('CONFLICT'));
  assert.deepEqual(await storage.load(), saved);
  storage.close();
});

test('storage abort rolls back writes and later saves can succeed', async () => {
  const { storage, initial } = await opened();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'state') { this.transaction.abort(); throw new Error('Simulated quota/disk failure'); }
    return originalPut.apply(this, args);
  };
  try { await assert.rejects(storage.saveDraft(draft(), null, opts(initial)), isCode('STORAGE')); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await storage.load(), initial);
  const result = await storage.saveDraft(draft(), null, opts(initial));
  assert.equal(result.draft.id, 'd1');
  storage.close();
});

test('restore snapshot and new state both roll back on transaction failure', async () => {
  const { storage, initial } = await opened();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'state') throw new Error('Simulated failure');
    return originalPut.apply(this, args);
  };
  try { await assert.rejects(storage.restore(fixture, initial.revision), isCode('STORAGE')); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await storage.load(), initial);
  assert.equal((await storage.exportRecovery()).recovery.length, 0);
  storage.close();
});

test('reset uses a restorable snapshot while leaving legacy backup untouched', async () => {
  const raw = JSON.stringify(fixture), { storage, initial, env } = await opened(environment(raw));
  const result = await storage.reset(initial.revision);
  assert.equal(result.db.sessions.length, 0);
  assert.equal(env.local.get(LEGACY_KEY), raw);
  const rollback = (await storage.exportRecovery()).recovery.find(item => item.kind === 'before-restore');
  assert.equal(rollback.state.db.sessions.length, 30);
  storage.close();
});

test('ten thousand sessions survive migration, independent additions and save/reload', async () => {
  const db = empty();
  db.sessions = Array.from({ length: 10000 }, (_, i) => ({ ...workout(`s${i}`), notes: `Workout ${i}` }));
  const { storage, initial } = await opened(environment(JSON.stringify(db)));
  const updated = clone(initial.db); updated.sessions.unshift(workout('new'));
  await storage.saveDB(updated, initial.db, opts(initial));
  assert.equal((await storage.load()).db.sessions.length, 10001);
  storage.close();
});
