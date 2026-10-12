const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const { createStorage, BASE_DEFAULTS, clone, LEGACY_KEY } = require('../storage.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const handlerSource = app.slice(app.indexOf('// Restore/reset rollback is available'), app.indexOf('// End restore/reset rollback controls.'));
assert.ok(handlerSource.includes('btnRestorePreviousSave'), 'Test must execute the actual rollback control');
const workout = id => ({ id, start: '2026-10-11T10:00:00Z', end: '2026-10-11T11:00:00Z', order: [], entries: {} });
const dbWith = (...ids) => ({ ...clone(BASE_DEFAULTS), sessions: ids.map(workout) });

async function setup(legacy = null) {
  const local = new Map(legacy === null ? [] : [[LEGACY_KEY, legacy]]);
  const env = { indexedDB: new IDBFactory(), localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) } };
  const storage = createStorage(env);
  const saved = await storage.open(clone(BASE_DEFAULTS));
  return { storage, saved };
}

function controls(storage, saved, options = {}) {
  const events = [], notices = [], confirmations = [];
  let handler, button;
  const context = {
    COMMITTING: false, STORAGE_REVISION: saved.revision,
    document: { createElement: () => button = { disabled: false, addEventListener: (type, fn) => { handler = fn; } } },
    $: selector => selector === '#dataContent' ? { appendChild() {} } : { click() { events.push('dashboard'); } },
    STORE: {
      exportRecovery: () => { events.push('export'); return options.exportRecovery ? options.exportRecovery() : storage.exportRecovery(); },
      // A VM creates another JS realm. Serialize at this boundary like a real JSON backup.
      parseBackupEnvelope: backup => storage.parseBackupEnvelope(JSON.stringify(backup)),
      restore: (backup, revision) => { events.push(['restore', revision]); return storage.restore(JSON.stringify(backup), revision); }
    },
    flushSaves: async () => { events.push('flush'); return options.flush !== false; },
    askConfirm: async (title, message) => {
      confirmations.push({ title, message });
      return options.confirm ? options.confirm() : options.accept !== false;
    },
    applySnapshot(snapshot) {
      context.STORAGE_REVISION = snapshot.revision; context.snapshot = snapshot;
      events.push('apply');
      if (options.failRender) throw new Error('Render failed');
    },
    stopTimer() { events.push('stopTimer'); }, loadSettings() { events.push('settings'); },
    showNotice(message, kind) { notices.push({ message, kind }); },
    updateSaveStatus() { events.push(['status', context.COMMITTING]); },
    LiftLogUpdates: { notifySafe() {} }
  };
  vm.runInNewContext(handlerSource, context);
  return { click: () => handler(), context, button, events, notices, confirmations };
}

test('previous-save control reverses restore and brings unfinished editor data back atomically', async () => {
  const { storage, saved } = await setup();
  const priorDB = dbWith('old');
  let previous = await storage.saveDB(priorDB, saved.db, { epoch: saved.epoch });
  const active = { id: 'draft1', start: '2026-10-11T12:00:00Z', order: [], entries: {}, notes: 'unfinished', logDrafts: { ex1: { unit: 'lbs', rows: [{ value1: '100', value2: '' }] } } };
  previous = await storage.saveDraft(active, null, { epoch: previous.epoch });
  const replaced = await storage.restore({ version: 1, data: dbWith('new') }, previous.revision);
  const ui = controls(storage, replaced);
  await ui.click();
  const result = await storage.load();
  assert.deepEqual(result.db.sessions.map(s => s.id), ['old']);
  assert.deepEqual(result.draft, active);
  assert.match(ui.confirmations[0].message, /1 workouts.*unfinished workout/);
  assert.equal(ui.context.COMMITTING, false);
  assert.equal(ui.button.disabled, false);
  assert.ok(ui.events.includes('dashboard'));
  assert.equal((await storage.exportRecovery()).recovery.at(-1).state.db.sessions[0].id, 'new');
  // The next invocation reverses the rollback without losing either copy.
  await ui.click();
  assert.deepEqual((await storage.load()).db.sessions.map(s => s.id), ['new']);
  storage.close();
});

test('previous-save control reverses a reset', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('keep')));
  const reset = await storage.reset(saved.revision);
  const ui = controls(storage, reset);
  await ui.click();
  assert.deepEqual((await storage.load()).db.sessions.map(s => s.id), ['keep']);
  assert.match(ui.notices.at(-1).message, /Previous save restored/);
  storage.close();
});

test('original migration is offered when no restore/reset snapshot exists', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('original')));
  const laterDB = dbWith('later');
  const later = await storage.saveDB(laterDB, saved.db, { epoch: saved.epoch });
  const ui = controls(storage, later);
  await ui.click();
  assert.match(ui.confirmations[0].message, /original data from before the storage upgrade/);
  assert.deepEqual((await storage.load()).db.sessions.map(s => s.id), ['original']);
  storage.close();
});

test('no available recovery copy is explained without a confirmation or mutation', async () => {
  const { storage, saved } = await setup();
  const ui = controls(storage, saved);
  await ui.click();
  assert.equal(ui.confirmations.length, 0);
  assert.match(ui.notices[0].message, /No previous save is available/);
  assert.deepEqual(await storage.load(), saved);
  storage.close();
});

test('cancellation leaves current data and recovery history unchanged', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('before')));
  const reset = await storage.reset(saved.revision);
  const before = await storage.exportRecovery();
  const ui = controls(storage, reset, { accept: false });
  await ui.click();
  assert.deepEqual(await storage.load(), reset);
  assert.equal((await storage.exportRecovery()).recovery.length, before.recovery.length);
  assert.equal(ui.context.COMMITTING, false);
  storage.close();
});

test('a concurrent save during confirmation causes a conflict instead of replacing newer data', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('before')));
  const reset = await storage.reset(saved.revision);
  let concurrent;
  const ui = controls(storage, reset, { confirm: async () => {
    concurrent = await storage.saveDB(dbWith('otherWindow'), reset.db, { epoch: reset.epoch });
    return true;
  } });
  await ui.click();
  assert.deepEqual(await storage.load(), concurrent);
  assert.match(ui.notices.at(-1).message, /not restored.*Another open LiftLog/);
  assert.equal(ui.notices.at(-1).kind, 'error');
  assert.equal(ui.context.COMMITTING, false);
  assert.equal(ui.button.disabled, false);
  storage.close();
});

test('pending-save failure stops rollback before reading or replacing recovery', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('before')));
  const ui = controls(storage, saved, { flush: false });
  await ui.click();
  assert.equal(ui.events.includes('export'), false);
  assert.equal(ui.confirmations.length, 0);
  assert.deepEqual(await storage.load(), saved);
  storage.close();
});

test('malformed recovery data cannot replace a valid database', async () => {
  const { storage, saved } = await setup();
  const ui = controls(storage, saved, { exportRecovery: async () => ({ recovery: [{ kind: 'before-restore', state: { db: { sessions: 'bad' }, draft: null } }] }) });
  await ui.click();
  assert.equal(ui.confirmations.length, 0);
  assert.match(ui.notices.at(-1).message, /not restored/);
  assert.deepEqual(await storage.load(), saved);
  storage.close();
});

test('repeated clicks share one pending confirmation and commit only once', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('before')));
  const reset = await storage.reset(saved.revision);
  let accept, started;
  const confirmed = new Promise(resolve => { started = resolve; });
  const ui = controls(storage, reset, { confirm: () => { started(); return new Promise(resolve => { accept = resolve; }); } });
  const first = ui.click();
  await confirmed;
  await ui.click();
  accept(true);
  await first;
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.events.filter(event => Array.isArray(event) && event[0] === 'restore').length, 1);
  storage.close();
});

test('a rendering error after commit accurately reports that recovery succeeded', async () => {
  const { storage, saved } = await setup(JSON.stringify(dbWith('before')));
  const reset = await storage.reset(saved.revision);
  const ui = controls(storage, reset, { failRender: true });
  await ui.click();
  assert.deepEqual((await storage.load()).db.sessions.map(s => s.id), ['before']);
  assert.match(ui.notices.at(-1).message, /was restored, but the screen could not refresh/);
  assert.equal(ui.context.COMMITTING, false);
  storage.close();
});
