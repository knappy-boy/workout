const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {IDBFactory} = require('fake-indexeddb');
const storageAPI = require('../storage.js');
const appSource = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const session = (id, notes = '') => ({id, start: '2026-10-10T10:00:00.000Z', end: '2026-10-10T11:00:00.000Z', notes, order: ['bench'], entries: {bench: [{w: 50, r: 8, type: 'normal'}]}});
const draft = (notes = '') => { const value = session('active', notes); delete value.end; value.logDrafts = {}; return value; };

async function harness() {
  const factory = new IDBFactory();
  const memory = new Map();
  const env = {indexedDB: factory, localStorage: {getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value)}, addEventListener() {}};
  const store = storageAPI.createStorage(env);
  const other = storageAPI.createStorage(env);
  const initial = await store.open();
  await other.open();
  const nodes = new Map();
  const dom = {editorOpen: false, activeElement: null, body: {className: ''}, querySelector(selector) {
    if (selector === '.overlay:not(.hidden), dialog[open]') return this.editorOpen ? {} : null;
    if (!nodes.has(selector)) nodes.set(selector, {textContent: '', hidden: false, inert: false, value: '', dataset: {tab: 'dashboard'}, events: {}, addEventListener(type, fn) { this.events[type] = fn; }, click() { if (this.events.click) return this.events.click(); }});
    return nodes.get(selector);
  }};
  const bridge = {equal: storageAPI.equal};
  for (const key of ['saveDB', 'saveDraft', 'finishWorkout', 'load']) bridge[key] = (...args) => store[key](...args.map(clone));
  const updates = {calls: 0, notifySafe() { this.calls++; }};
  const context = vm.createContext({LiftLogTheme: require('./helpers/theme-runtime.cjs')(), LiftLogStorage: bridge, document: dom, LiftLogUpdates: updates, LiftLogLogging: require('../logging.js'),
    LiftLogDates: {completedExerciseIds: value => Object.keys(value.entries).filter(key => value.entries[key].length)},
    URL, Blob, setTimeout, clearTimeout, console,
    renderCurrentTab() {}, renderWorkoutTab() {}, stopTimer() {}, openLogger() {}, clearActiveDrag() {}});
  vm.runInContext(appSource.slice(0, appSource.indexOf('// --- DOM HELPERS ---')), context);
  context.initial = initial;
  vm.runInContext(`applySnapshot(initial); globalThis.state = {
    get: () => ({db: copyState(DB), draft: copyState(ACTIVE_SESSION), baseDB: copyState(BASE_DB), baseDraft: copyState(BASE_DRAFT), pending: PENDING_SAVES, error: STORAGE_ERROR, revision: STORAGE_REVISION}),
    applySnapshot, saveDB, saveDraft, flushSaves, canUpdate, refreshSavedData,
    setDraft: value => { ACTIVE_SESSION = copyState(value); },
    patchUser: value => Object.assign(DB.user, copyState(value)),
    mutateDB: fn => fn(DB)
  };`, context);
  // Execute the real finish listener with lightweight controls and dialog answers.
  context.$ = selector => dom.querySelector(selector);
  vm.runInContext('askConfirm = async () => true;', context);
  const finishStart = appSource.indexOf('$("#btnFinishWorkout").addEventListener("click", async () => {');
  const finishEnd = appSource.indexOf('// --- LOGGING MODAL ---', finishStart);
  vm.runInContext(appSource.slice(finishStart, finishEnd), context);
  const retryStart = appSource.indexOf('$("#btnRetrySave").addEventListener("click", async () => {');
  const retryEnd = appSource.indexOf('$("#btnReloadSaved").addEventListener', retryStart);
  vm.runInContext(appSource.slice(retryStart, retryEnd), context);
  return {state: context.state, store, other, bridge, dom, nodes, context, updates,
    finish: () => dom.querySelector('#btnFinishWorkout').events.click(),
    retry: () => dom.querySelector('#btnRetrySave').events.click(),
    close() { store.close(); other.close(); }};
}

test('rapid note typing serializes every draft save and persists the final text', async t => {
  const h = await harness(); t.after(() => h.close());
  h.state.setDraft(draft());
  await h.state.saveDraft();
  const saves = [];
  for (let i = 1; i <= 30; i++) { h.state.setDraft(draft('Rapid notes ' + i)); saves.push(h.state.saveDraft()); }
  assert.equal(h.state.get().pending, 30);
  assert.equal(h.dom.querySelector('#saveStatus').textContent, 'Saving…');
  assert.ok((await Promise.all(saves)).every(Boolean));
  assert.equal((await h.store.load()).draft.notes, 'Rapid notes 30');
  assert.equal(h.state.get().draft.notes, 'Rapid notes 30');
  assert.equal(h.state.get().pending, 0);
  assert.equal(h.dom.querySelector('#saveStatus').textContent, 'Saved on this device');
});

test('a failed save keeps unsaved memory and never displays Saved', async t => {
  const h = await harness(); t.after(() => h.close());
  h.state.setDraft(draft('keep these notes'));
  h.bridge.saveDraft = async () => { throw new Error('disk full'); };
  assert.equal(await h.state.saveDraft(), false);
  assert.equal(h.state.get().draft.notes, 'keep these notes');
  assert.equal((await h.store.load()).draft, null);
  assert.match(h.dom.querySelector('#saveStatus').textContent, /^Not saved/);
  assert.equal(h.state.canUpdate(), false);
  assert.equal(h.state.get().pending, 0);
  h.state.setDraft(draft('even newer unsaved notes'));
  assert.equal(await h.state.saveDraft(), false);
  assert.equal(h.state.get().draft.notes, 'even newer unsaved notes');
});

test('queued settings changes merge a workout saved in another window', async t => {
  const h = await harness(); t.after(() => h.close());
  const gate = deferred(), started = deferred();
  const save = h.bridge.saveDB;
  let calls = 0;
  h.bridge.saveDB = async (...args) => { if (++calls === 1) { started.resolve(); await gate.promise; } return save(...args); };
  h.state.patchUser({theme: 'dark'});
  const first = h.state.saveDB();
  await started.promise;
  h.state.patchUser({useLbs: true});
  const second = h.state.saveDB();
  const remote = await h.other.load();
  const changed = clone(remote.db); changed.sessions.push(session('remote'));
  await h.other.saveDB(changed, remote.db, {epoch: remote.epoch});
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const saved = await h.store.load();
  assert.equal(saved.db.sessions[0].id, 'remote');
  assert.equal(saved.db.user.theme, 'dark');
  assert.equal(saved.db.user.useLbs, true);
  assert.equal(h.state.get().db.sessions[0].id, 'remote');
});

test('update safety immediately blocks queued writes, open editors, active workouts and failures', async t => {
  const h = await harness(); t.after(() => h.close());
  assert.equal(h.state.canUpdate(), true);
  const gate = deferred(), started = deferred();
  const save = h.bridge.saveDB;
  h.bridge.saveDB = async (...args) => { started.resolve(); await gate.promise; return save(...args); };
  h.state.patchUser({theme: 'dark'});
  const pending = h.state.saveDB();
  await started.promise;
  assert.equal(h.state.canUpdate(), false);
  gate.resolve(); await pending;
  assert.equal(h.state.canUpdate(), true);
  h.dom.editorOpen = true; assert.equal(h.state.canUpdate(), false);
  h.dom.editorOpen = false;
  h.dom.activeElement = {value: 'typing', matches: () => true}; assert.equal(h.state.canUpdate(), false);
  h.dom.activeElement = null;
  vm.runInContext('COMMITTING = true;', h.context); assert.equal(h.state.canUpdate(), false);
  vm.runInContext('COMMITTING = false;', h.context);
  h.state.setDraft(draft()); assert.equal(h.state.canUpdate(), false);
});

test('an async external refresh does not overwrite a workout begun during the read', async t => {
  const h = await harness(); t.after(() => h.close());
  const gate = deferred(), started = deferred();
  const load = h.bridge.load;
  h.bridge.load = async () => { const saved = await load(); started.resolve(); await gate.promise; return saved; };
  const refresh = h.state.refreshSavedData();
  await started.promise;
  h.state.setDraft(draft('started during refresh'));
  gate.resolve(); await refresh;
  assert.equal(h.state.get().draft.notes, 'started during refresh');
});

test('finishing a stale workout cannot consume newer draft edits acknowledged by a DB-only save', async t => {
  const h = await harness(); t.after(() => h.close());
  h.state.setDraft(draft('old local notes')); await h.state.saveDraft();
  const remote = await h.other.load();
  const remoteDraft = clone(remote.draft); remoteDraft.notes = 'newer notes in another window';
  remoteDraft.entries.bench.push({w: 55, r: 8, type: 'normal'});
  await h.other.saveDraft(remoteDraft, remote.draft, {epoch: remote.epoch});
  h.state.patchUser({theme: 'dark'}); await h.state.saveDB();
  await h.finish();
  const saved = await h.store.load();
  assert.equal(saved.db.sessions.length, 0, 'must not finish over another window’s changed draft');
  assert.equal(saved.draft.notes, 'newer notes in another window');
  assert.equal(saved.draft.entries.bench.length, 2);
  assert.equal(h.state.get().draft.notes, 'old local notes', 'retain this window’s input for recovery');
  assert.match(h.dom.querySelector('#saveStatus').textContent, /^Not saved/);
  assert.notEqual(h.dom.querySelector('#appNotice').textContent, 'Workout saved.');
});

test('Finish reopens blank pending edits over existing bodyweight sets or exercise notes without discarding them', async t => {
  for (const existingWork of ['bodyweight sets', 'exercise notes']) {
    const h = await harness(); t.after(() => h.close());
    const pending = draft();
    pending.entries.bench = existingWork === 'bodyweight sets' ? [{w: 0, r: 8, loadType: 'bodyweight'}] : [];
    pending.exerciseNotes = {bench: existingWork === 'exercise notes' ? 'Note being removed' : ''};
    pending.logDrafts.bench = {unit: 'kg', loadType: 'bodyweight', notes: '', rows: [{a: '', b: '', loadType: 'bodyweight'}]};
    h.state.setDraft(pending); await h.state.saveDraft();
    const opens = []; h.context.openLogger = exId => opens.push(exId);
    await h.finish();
    assert.deepEqual(opens, ['bench'], existingWork);
    assert.equal(JSON.stringify(h.state.get().draft), JSON.stringify(pending));
    const stored = await h.store.load();
    assert.equal(stored.db.sessions.length, 0);
    assert.deepEqual(stored.draft.logDrafts.bench, pending.logDrafts.bench);
    assert.match(h.dom.querySelector('#appNotice').textContent, /unfinished exercise edits/);
  }
});

test('an untouched blank placeholder still allows Finish to save completed work on another exercise', async t => {
  const h = await harness(); t.after(() => h.close());
  const pending = draft();
  pending.order.push('unstarted');
  pending.logDrafts.unstarted = {unit: 'kg', loadType: 'bodyweight', notes: '', rows: [{a: '', b: '', loadType: 'bodyweight'}]};
  h.state.setDraft(pending); await h.state.saveDraft();
  const opens = []; h.context.openLogger = exId => opens.push(exId);
  await h.finish();
  assert.deepEqual(opens, []);
  const stored = await h.store.load();
  assert.equal(stored.draft, null); assert.equal(stored.db.sessions.length, 1);
  assert.deepEqual(stored.db.sessions[0].entries.bench, pending.entries.bench);
  assert.equal(stored.db.sessions[0].logDrafts, undefined);
});

test('finishing locks controls through the async commit and unlocks after failure', async t => {
  const h = await harness(); t.after(() => h.close());
  h.state.setDraft(draft('do not lose these')); await h.state.saveDraft();
  const gate = deferred(), started = deferred();
  h.bridge.finishWorkout = async () => { started.resolve(); await gate.promise; throw new Error('disk unavailable'); };
  const finishing = h.finish();
  await started.promise;
  assert.equal(h.dom.querySelector('#appShell').inert, true, 'inputs must be locked while final snapshot commits');
  assert.equal(h.state.canUpdate(), false);
  gate.resolve(); await finishing;
  assert.equal(h.state.get().draft.notes, 'do not lose these');
  assert.equal((await h.store.load()).draft.notes, 'do not lose these');
  assert.equal(h.dom.querySelector('#appShell').inert, false);
  assert.match(h.dom.querySelector('#saveStatus').textContent, /^Not saved/);
});

test('retrying after a later queued write fails does not delete another window’s merged workout', async t => {
  const h = await harness(); t.after(() => h.close());
  const gate = deferred(), started = deferred();
  const save = h.bridge.saveDB;
  let calls = 0;
  h.bridge.saveDB = async (...args) => {
    calls++;
    if (calls === 1) { started.resolve(); await gate.promise; }
    if (calls === 2) throw new Error('transient failure');
    return save(...args);
  };
  h.state.patchUser({theme: 'dark'}); const first = h.state.saveDB();
  await started.promise;
  h.state.patchUser({useLbs: true}); const second = h.state.saveDB();
  const remote = await h.other.load();
  const changed = clone(remote.db); changed.sessions.push(session('remote'));
  await h.other.saveDB(changed, remote.db, {epoch: remote.epoch});
  gate.resolve(); await first;
  assert.equal(await second, false);
  assert.equal(h.state.get().db.user.useLbs, true);
  await h.retry();
  assert.equal(h.state.get().error, null);
  const saved = await h.store.load();
  assert.equal(saved.db.sessions[0]?.id, 'remote', 'retry must preserve history merged from the other window');
  assert.equal(saved.db.user.useLbs, true);
});

test('JSON backup exports another window’s committed history together with the active workout draft', async t => {
  const h = await harness(); t.after(() => h.close());
  h.state.setDraft(draft('saved workout notes'));
  await h.state.saveDraft();
  const remote = await h.other.load();
  const changed = clone(remote.db);
  changed.sessions.push(session('remote-export', 'completed in another window'));
  await h.other.saveDB(changed, remote.db, {epoch: remote.epoch});
  assert.equal(h.state.get().db.sessions.length, 0, 'this window intentionally still has stale history');

  const unfinished = draft('latest notes typed before export');
  unfinished.logDrafts.bench = {unit: 'kg', notes: 'one more set', rows: [{a: '55.5', b: '9', type: 'normal'}]};
  h.state.setDraft(unfinished);
  // Exercise the actual export event handler. Capture its download rather than
  // creating a browser URL; persistence and the final store read remain real.
  h.context.LiftLogDates.localDayKey = value => new Date(value).toISOString().slice(0, 10);
  const version = appSource.match(/const DATA_VERSION = \d+;/);
  assert.ok(version);
  vm.runInContext(version[0] + '\ndownloadJSON = (data, name) => { globalThis.downloadedBackup = {data, name}; };', h.context);
  const exportStart = appSource.indexOf('$("#btnExportJSON").addEventListener("click", async () => {');
  const exportEnd = appSource.indexOf('async function restoreFile', exportStart);
  vm.runInContext(appSource.slice(exportStart, exportEnd), h.context);
  await h.dom.querySelector('#btnExportJSON').events.click();

  const backup = clone(h.context.downloadedBackup);
  assert.match(backup.name, /^liftlog_backup_\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(backup.data.version, 1);
  assert.equal(backup.data.data.sessions[0].id, 'remote-export');
  assert.equal(backup.data.data.sessions[0].notes, 'completed in another window');
  assert.equal(backup.data.draft.notes, 'latest notes typed before export');
  assert.equal(backup.data.draft.entries.bench[0].w, 50);
  assert.equal(backup.data.draft.logDrafts.bench.rows[0].a, '55.5');
  assert.equal(backup.data.draft.logDrafts.bench.rows[0].b, '9');
  assert.equal((await h.store.load()).draft.notes, 'latest notes typed before export');
  assert.equal(h.state.get().error, null);
});

test('successful saves stay quiet in the real app but errors remain visible inside the logger', async t => {
  const h = await harness(); t.after(() => h.close());
  assert.equal(h.dom.querySelector('#saveStatus').hidden, true);
  assert.equal(h.dom.querySelector('#logSaveStatus').hidden, true);
  h.state.setDraft(draft('keep private')); h.bridge.saveDraft = async () => {throw new Error('disk full');};
  assert.equal(await h.state.saveDraft(), false);
  assert.equal(h.dom.querySelector('#saveStatus').hidden, false);
  assert.equal(h.dom.querySelector('#logSaveStatus').hidden, false);
  assert.match(h.dom.querySelector('#logSaveStatus').textContent, /^Not saved/);
});

test('preview builds keep normal saves quiet and save failures visible', async t => {
  const h = await harness(); t.after(() => h.close());
  h.dom.body.dataset = {testBuild:'B'};
  vm.runInContext('updateSaveStatus()', h.context);
  assert.equal(h.dom.querySelector('#saveStatus').hidden, true);
  assert.equal(h.dom.querySelector('#logSaveStatus').hidden, true);
  h.state.setDraft(draft('keep private')); h.bridge.saveDraft = async () => {throw new Error('disk full');};
  assert.equal(await h.state.saveDraft(), false);
  assert.equal(h.dom.querySelector('#saveStatus').hidden, false);
  assert.equal(h.dom.querySelector('#logSaveStatus').hidden, false);
  assert.match(h.dom.querySelector('#logSaveStatus').textContent, /^Not saved/);
});
