const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {IDBFactory} = require('fake-indexeddb');
const storage = require('../storage.js');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

async function harness({delayed = false} = {}) {
  const env = {indexedDB: new IDBFactory(), localStorage: {getItem: () => null, setItem() {}}, addEventListener() {}};
  const store = storage.createStorage(env);
  const exercise = id => ({id, name: id === 'hack' ? 'Hack squat' : 'Barbell squat', type: 'strength', muscle: 'Quads', equip: 'machine', isAssisted: false});
  const db = {...clone(storage.BASE_DEFAULTS), exercises: {hack: exercise('hack'), squat: exercise('squat')}, templates: {
    legs: {id: 'legs', name: 'Legs', exercises: [{exId: 'hack'}]}
  }, sessions: [{id: 'previous', start: '2026-09-01T10:00:00Z', end: '2026-09-01T11:00:00Z', templateId: 'legs', templateName: 'Legs', order: ['hack'], entries: {hack: [{w: 50, r: 8}, {w: 50, r: 6}]}}]};
  const opened = await store.open(db);
  const initial = await store.saveDraft({id: 'active', start: '2026-10-12T10:00:00Z', templateId: 'legs', templateName: 'Legs', order: ['hack'], entries: {}, exerciseNotes: {}, logDrafts: {}, notes: ''}, null, {epoch: opened.epoch});
  let rows = [], picker, confirm = false;
  const styles = () => ({getPropertyValue: () => '', getPropertyPriority: () => '', setProperty() {}, removeProperty() {}});
  const node = () => ({children: [], lookups: new Map(), handlers: {}, value: '', dataset: {}, style: styles(), hidden: false,
    addEventListener(name, fn) {this.handlers[name] = fn;}, setAttribute() {}, focus() {},
    appendChild(child) {this.children.push(child);}, remove() {},
    querySelector(selector) {if (!this.lookups.has(selector)) this.lookups.set(selector, node()); return this.lookups.get(selector);},
    classList: {add() {}, remove() {}, toggle() {}}});
  const nodes = new Map(), $ = selector => {if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector);};
  Object.defineProperty($('#logRows'), 'innerHTML', {set() {rows = [];}});
  $('#logRows').appendChild = child => rows.push(child);
  for (const selector of ['#prevSessionInfo', '#loggerCopySlot']) Object.defineProperty($(selector), 'innerHTML', {set() {this.children = [];}});
  const document = {body: {style: styles()}, documentElement: {style: styles()}, querySelector: $, createElement: node};
  const bridge = {equal: storage.equal};
  for (const method of ['saveDraft', 'saveDB']) bridge[method] = async (...args) => {
    if (delayed) await new Promise(resolve => setImmediate(resolve));
    return store[method](...args.map(clone));
  };
  const context = vm.createContext({LiftLogTheme: require('./helpers/theme-runtime.cjs')(), LiftLogStorage: bridge, LiftLogLogging: require('../logging.js'), LiftLogExerciseLoad: require('../exercise-load.js'),
    LiftLogDates: require('../dates.js'), document, window: {scrollTo() {}}, $, $$: selector => selector === '#logRows .log-row' ? rows : [],
    initial, MUSCLE_COLORS: {Quads: '#81C784', Other: '#78909C'}, LiftLogUpdates: {notifySafe() {}}, setTimeout, clearTimeout});
  vm.runInContext(app.slice(app.indexOf('// --- MODAL WORKFLOW HELPERS ---'), app.indexOf('// --- TABS & NAVIGATION ---')), context);
  vm.runInContext(app.slice(0, app.indexOf('// --- DOM HELPERS ---')), context);
  vm.runInContext(app.slice(app.indexOf('let CURRENT_LOG_EX = null;'), app.indexOf('// --- TEMPLATES ---')), context);
  vm.runInContext(`applySnapshot(initial); globalThis.state = {get: () => ({db:copyState(DB), draft:copyState(ACTIVE_SESSION), queued:copyState(QUEUED_DRAFT), base:copyState(BASE_DRAFT), error:STORAGE_ERROR}), idle: () => SAVE_QUEUE};`, context);
  context.getWeightUnit = () => 'kg';
  context.renderActiveSession = () => context.saveDraft();
  context.openExercisePicker = (choose, cancel, options) => {picker = {choose, cancel, options};};
  context.askConfirm = async () => confirm;
  return {store, secondStore: () => storage.createStorage(env), context, $, state: context.state,
    picker: () => picker, confirm: value => {confirm = value;}, rows: () => rows};
}

test('actual logger Copy Last, note, cancelled swap and confirmed swap keep the IndexedDB draft baseline consistent', async t => {
  const h = await harness(); t.after(() => h.store.close());
  h.context.openLogger('hack');
  await h.$('#loggerCopySlot').children.find(child => child.id === 'btnCopyLastSets').handlers.click();
  h.$('#logNotes').value = 'QA keep hack squat draft'; await h.context.captureLogDraft();
  assert.equal(h.state.get().error, null);
  await h.context.swapLoggerExercise(); await h.picker().choose('squat');
  await h.context.swapLoggerExercise(); h.confirm(true); await h.picker().choose('squat');
  await h.state.idle();
  const saved = await h.store.load(), state = h.state.get();
  assert.equal(state.error, null);
  assert.deepEqual(saved.draft.order, ['hack', 'squat']);
  assert.equal(saved.draft.logDrafts.hack.notes, 'QA keep hack squat draft');
  assert.deepEqual(saved.draft.logDrafts.hack.rows.map(row => [row.a, row.b]), [['50', ''], ['50', '']]);
  assert.deepEqual(clone(state.draft), saved.draft); assert.deepEqual(clone(state.queued), saved.draft);
  assert.equal(saved.db.sessions.length, 1); assert.deepEqual(saved.db.templates.legs.exercises, [{exId: 'hack'}]);
});

test('delayed settings and rapid raw-draft writes cannot make a later swap conflict with this same window', async t => {
  const h = await harness({delayed: true}); t.after(() => h.store.close());
  h.context.openLogger('hack');
  const copying = h.$('#loggerCopySlot').children.find(child => child.id === 'btnCopyLastSets').handlers.click();
  h.$('#logNotes').value = 'first'; const first = h.context.captureLogDraft();
  vm.runInContext("DB.user.theme = 'dark'; saveDB();", h.context);
  h.$('#logNotes').value = 'QA keep hack squat draft'; const latest = h.context.captureLogDraft();
  await h.context.swapLoggerExercise(); await h.picker().choose('squat');
  vm.runInContext("DB.user.theme = 'light'; saveDB();", h.context);
  await h.context.swapLoggerExercise(); h.confirm(true); await h.picker().choose('squat');
  await Promise.all([copying, first, latest, h.state.idle()]);
  assert.equal(h.state.get().error, null);
  const saved = await h.store.load();
  assert.deepEqual(saved.draft.order, ['hack', 'squat']); assert.equal(saved.draft.logDrafts.hack.notes, 'QA keep hack squat draft');
  assert.equal(saved.db.user.theme, 'light'); assert.deepEqual(clone(h.state.get().queued), saved.draft);
});

for (const remoteAction of ['clears', 'finishes']) {
  test(`a second tab that ${remoteAction} the draft during the swap picker cannot be overwritten by stale confirmation`, async t => {
    const h = await harness(), other = h.secondStore();
    t.after(() => {h.store.close(); other.close();}); await other.open();
    h.context.openLogger('hack');
    await h.$('#loggerCopySlot').children.find(child => child.id === 'btnCopyLastSets').handlers.click();
    h.$('#logNotes').value = 'Keep this unfinished source note'; await h.context.captureLogDraft();
    await h.context.swapLoggerExercise();
    const localBefore = clone(h.state.get().draft), remote = await other.load();
    let remoteAfter;
    if (remoteAction === 'clears') {
      remoteAfter = await other.saveDraft(null, remote.draft, {epoch: remote.epoch});
    } else {
      // The other tab completes its own inputs, then finishes the same workout.
      const remoteDraft = clone(remote.draft);
      remoteDraft.entries.hack = [{w: 52.5, r: 7, loadType: 'external'}];
      remoteDraft.exerciseNotes.hack = 'Completed in the other tab';
      delete remoteDraft.logDrafts.hack;
      await other.saveDraft(remoteDraft, remote.draft, {epoch: remote.epoch});
      const completed = {...clone(remoteDraft), end: '2026-10-12T11:00:00Z'};
      delete completed.logDrafts;
      remoteAfter = await other.finishWorkout(completed, remoteDraft, {epoch: remote.epoch});
    }
    h.confirm(true); await h.picker().choose('squat'); await h.state.idle();
    const state = h.state.get(), saved = await h.store.load();
    assert.equal(state.error?.code, 'CONFLICT');
    assert.deepEqual(saved, remoteAfter, 'the stale swap must not write or resurrect the cleared draft');
    assert.equal(saved.draft, null);
    assert.deepEqual(clone(state.draft), localBefore, 'rollback retains the complete source draft for review/recovery');
    assert.equal(vm.runInContext('CURRENT_LOG_EX', h.context), 'hack');
    assert.deepEqual(clone(state.draft.order), ['hack']);
    assert.equal(state.draft.logDrafts.squat, undefined);
    assert.equal(state.draft.logDrafts.hack.notes, 'Keep this unfinished source note');
    assert.deepEqual(clone(state.draft.logDrafts.hack.rows).map(row => [row.a, row.b]), [['50', ''], ['50', '']]);
    if (remoteAction === 'finishes') {
      const completed = saved.db.sessions.find(item => item.id === localBefore.id);
      assert.deepEqual(completed.entries.hack, [{w: 52.5, r: 7, loadType: 'external'}]);
      assert.equal(completed.exerciseNotes.hack, 'Completed in the other tab');
    } else assert.equal(saved.db.sessions.some(item => item.id === localBefore.id), false);
    const recovery = await h.store.exportRecovery();
    assert.equal(recovery.current.draft, null);
    assert.deepEqual(recovery.current.db.sessions, saved.db.sessions);
  });
}
