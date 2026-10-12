const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const { createStorage, clone, LEGACY_KEY, DATABASE_NAME } = require('../storage.js');

const app = fs.readFileSync(new URL('../app.js', 'file://' + __filename), 'utf8');
// Use the production app's actual defaults, rather than a test-only empty account.
const production = JSON.parse(vm.runInNewContext(
  app.slice(0, app.indexOf('// Conversion constants')) + '\nJSON.stringify({key: DB_KEY, defaults: DEFAULT_DB})'
));

function environment(raw = null) {
  const local = new Map(raw === null ? [] : [[LEGACY_KEY, raw]]);
  return { indexedDB: new IDBFactory(), local,
    localStorage: { getItem: key => local.has(key) ? local.get(key) : null,
      setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) } };
}

// Fictional records with the field shapes saved by the original v35 app.
// No personal backup or phone test data belongs in the production repository.
function originalAccount() {
  return {
    user: { theme: 'dark', unit: 'lbs', increment: 1.25, showSuggestions: false,
      includeCompound: false, trainingGoal: 'strength', bodyweight: 80 },
    exercises: {
      assisted: { id: 'assisted', name: 'Assisted pull-up', type: 'strength', muscle: 'Back',
        equip: 'Machine', increment: 2.5, isAssisted: true, isCompound: true, secondaryMuscles: ['Biceps'] },
      archived: { id: 'archived', name: 'Previous curl', type: 'strength', muscle: 'Biceps', archived: true },
      cardio: { id: 'cardio', name: 'Bike', type: 'cardio', muscle: null, equip: null,
        increment: null, cardioMetric: 'time', cardioGoal: 'endurance' }
    },
    templates: {
      routine: { id: 'routine', name: 'Upper body', exercises: [{ exId: 'assisted', sets: 3 }, { exId: 'archived', sets: 2 }] }
    },
    sessions: [{ id: 'old-workout', start: '2026-04-02T17:00:00.000Z', end: '2026-04-02T18:00:00.000Z',
      templateId: 'routine', templateName: 'Upper body', notes: 'Fictional regression record',
      order: ['assisted', 'removed-exercise', 'cardio'], exerciseNotes: { assisted: 'Pause at the top' },
      entries: {
        assisted: [{ w: '18', r: '8', note: 'Assistance', type: 'normal' }],
        'removed-exercise': [{ w: '12.5', r: '10' }],
        cardio: [{ time: '12', dist: '4' }]
      } }],
    bodyweight: [{ date: '2026-04-01T08:00:00.000Z', kg: 80 }, { date: '2026-04-02T08:00:00.000Z', kg: 79.5 }],
    goals: { assisted: { targetWeight: 10, targetReps: 10 } }
  };
}

const options = state => ({ epoch: state.epoch });

test('the actual production defaults start empty and keep the original storage identity', async () => {
  assert.equal(production.key, 'liftlog_ultra_v1');
  assert.equal(LEGACY_KEY, production.key);
  assert.equal(DATABASE_NAME, 'liftlog-durable');
  const storage = createStorage(environment());
  try {
    const state = await storage.open(production.defaults);
    assert.deepEqual(state.db.exercises, {});
    assert.deepEqual(state.db.templates, {});
    assert.deepEqual(state.db.sessions, []);
    assert.deepEqual(state.db.bodyweight, []);
    assert.deepEqual(state.db.goals, {});
    assert.equal(state.draft, null);
  } finally { storage.close(); }
});

test('original production records retain routines, order, deleted references, assisted flags, cardio and bodyweight', async () => {
  const original = originalAccount(), raw = JSON.stringify(original), env = environment(raw);
  const storage = createStorage(env);
  try {
    const state = await storage.open(production.defaults);
    for (const collection of ['sessions', 'exercises', 'templates', 'bodyweight', 'goals']) {
      assert.deepEqual(state.db[collection], original[collection]);
    }
    const expectedUser = { ...original.user, useLbs: true };
    delete expectedUser.unit;
    assert.deepEqual(state.db.user, expectedUser);
  } finally { storage.close(); }
});

test('later original-version writes cannot replace the migrated data on reopen', async () => {
  const original = originalAccount(), raw = JSON.stringify(original), env = environment(raw);
  let storage = createStorage(env);
  try {
    const first = await storage.open(production.defaults);
    const edited = clone(first.db);
    edited.user.theme = 'purple';
    edited.sessions[0].notes = 'Updated in the current app';
    const saved = await storage.saveDB(edited, first.db, options(first));
    assert.equal(env.local.get(LEGACY_KEY), raw);
    storage.close();
    env.local.set(LEGACY_KEY, JSON.stringify(production.defaults));
    storage = createStorage(env);
    const reopened = await storage.open(production.defaults);
    assert.deepEqual(reopened.db, saved.db);
    const recovery = await storage.exportRecovery();
    assert.equal(recovery.recovery.length, 1);
    assert.equal(recovery.recovery[0].kind, 'legacy-migration');
    assert.equal(recovery.recovery[0].raw, raw);
  } finally { storage.close(); }
});

test('a current-version update preserves unfinished rows and the dated workout bodyweight snapshot', async () => {
  const env = environment(JSON.stringify(originalAccount()));
  let storage = createStorage(env);
  try {
    const first = await storage.open(production.defaults);
    const active = { id: 'unfinished', start: '2026-10-12T17:00:00.000Z', templateId: 'routine',
      templateName: 'Upper body', entries: {}, order: ['assisted', 'archived'], notes: 'Resume this workout',
      exerciseNotes: { assisted: 'Keep this note' },
      logDrafts: { assisted: { rows: [{ value1: '18.', value2: '' }], notes: 'Keep this note', unit: 'kg' } },
      bodyweightSnapshot: { kg: 79.5, date: '2026-04-02T08:00:00.000Z' },
      bodyweightInput: { value: '79.5', unit: 'kg', originalKg: 79.5 },
      restTimer: { endsAt: 1791824700000 } };
    await storage.saveDraft(active, null, options(first));
    storage.close();
    storage = createStorage(env);
    const resumed = await storage.open(production.defaults);
    assert.deepEqual(resumed.db, first.db);
    assert.deepEqual(resumed.draft, active);
    const completed = { ...clone(active), end: '2026-10-12T18:00:00.000Z', logDrafts: {},
      entries: { assisted: [{ w: 18, r: 8, loadType: 'assisted',
        bodyweightKg: 79.5, bodyweightDate: '2026-04-02T08:00:00.000Z' }] } };
    const finished = await storage.finishWorkout(completed, active, options(resumed));
    assert.equal(finished.draft, null);
    assert.deepEqual(finished.db.sessions.find(session => session.id === completed.id), completed);
    assert.deepEqual(finished.db.sessions.find(session => session.id === 'old-workout'), first.db.sessions[0]);
  } finally { storage.close(); }
});

test('independent devices have empty independent databases when sharing the production website', async () => {
  const owner = createStorage(environment(JSON.stringify(originalAccount())));
  const friend = createStorage(environment());
  try {
    const [ownerState, friendState] = await Promise.all([owner.open(production.defaults), friend.open(production.defaults)]);
    assert.equal(ownerState.db.sessions.length, 1);
    assert.deepEqual(friendState.db.sessions, []);
    assert.deepEqual(friendState.db.exercises, {});
    const ownExercise = clone(friendState.db);
    ownExercise.exercises.friend = { id: 'friend', name: 'Friend squat', type: 'strength', muscle: 'Quads' };
    await friend.saveDB(ownExercise, friendState.db, options(friendState));
    assert.deepEqual((await owner.load()).db.exercises, ownerState.db.exercises);
    assert.deepEqual((await friend.load()).db.exercises, ownExercise.exercises);
  } finally { owner.close(); friend.close(); }
});

test('the production shell loads no preview seeds or personal data files', () => {
  const html = fs.readFileSync(new URL('../index.html', 'file://' + __filename), 'utf8');
  const worker = fs.readFileSync(new URL('../sw.js', 'file://' + __filename), 'utf8');
  assert.doesNotMatch(html, /preview-seed|test-data\.json|liftlog_backup|diagnostics\.js|compare-bridge/);
  assert.doesNotMatch(worker, /preview-seed|test-data\.json|liftlog_backup|diagnostics\.js|compare-bridge/);
});
