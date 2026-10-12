const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { IDBFactory } = require('fake-indexeddb');
const load = require('../exercise-load.js');
const storage = require('../storage.js');

function database(set = { w: '18', r: '8' }, exercise = {}) {
  return { ...storage.clone(storage.BASE_DEFAULTS), exercises: {
    dips: { id: 'dips', name: 'Dips', type: 'strength', ...exercise }
  }, sessions: [{ id: 's1', start: '2026-10-12T10:00:00Z', end: '2026-10-12T11:00:00Z',
    order: ['dips'], entries: { dips: [set] } }] };
}

test('exercise defaults are explicit, with only the existing assistance flag as a legacy fallback', () => {
  for (const mode of load.MODES) assert.equal(load.resolveMode({ loadType: mode, isAssisted: true }), mode);
  assert.equal(load.resolveMode({ isAssisted: true }), 'assisted');
  assert.equal(load.resolveMode({ name: 'Assisted weighted bodyweight dips', equip: 'bodyweight' }), 'external');
  assert.equal(load.resolveMode({ loadType: 'unknown', isAssisted: true }), 'assisted');
  assert.equal(load.resolveMode(null), 'external');
  assert.deepEqual(load.MODES.map(load.rawLabel), ['Weight', 'Bodyweight', 'Assistance', 'Added weight']);
});

test('changing library defaults never reinterprets legacy sets or explicitly saved load types', () => {
  const legacySet = Object.freeze({ w: '18', r: '8', note: 'Original machine setting' });
  const oldAssisted = { isAssisted: true, loadType: 'weighted' };
  const oldExternal = { isAssisted: false, loadType: 'bodyweight' };
  assert.equal(load.resolveSetMode(legacySet, oldAssisted), 'assisted');
  assert.equal(load.resolveSetMode(legacySet, oldExternal), 'external');
  for (const mode of load.MODES) {
    assert.equal(load.resolveSetMode({ ...legacySet, loadType: mode }, oldAssisted), mode);
    assert.equal(load.resolveSetMode({ ...legacySet, loadType: mode }, oldExternal), mode);
  }
  assert.equal(load.estimatedLoad(legacySet), null, 'legacy rows are not silently converted to estimates');
  assert.equal(legacySet.w, '18');
});

test('bodyweight selection finds the latest valid reading at or before the workout, without sorting the source', () => {
  const readings = [
    { id: 'future', date: '2026-10-12T10:00:00.001Z', kg: 100 },
    { id: 'old', date: '2026-10-10T09:00:00Z', kg: 79 },
    { id: 'matching', date: '2026-10-12T10:00:00Z', kg: '80' },
    { id: 'bad-number', date: '2026-10-12T10:00:00Z', kg: 'Infinity' },
    { id: 'bad-day', date: '2026-02-30', kg: 81 }
  ];
  const before = JSON.stringify(readings);
  assert.deepEqual(load.latestBodyweight(readings, '2026-10-12T10:00:00Z'),
    { kg: 80, date: '2026-10-12T10:00:00Z', sourceId: 'matching' });
  assert.equal(JSON.stringify(readings), before);
  assert.equal(load.latestBodyweight(readings, '2026-10-09T10:00:00Z'), null);
  assert.equal(load.latestBodyweight(readings, null), null);
  assert.equal(load.latestBodyweight(readings, '2026-02-30'), null);
  assert.equal(load.latestBodyweight(null, '2026-10-12'), null);
});

test('date-only readings use their local day while timestamped future readings stay excluded across timezones and DST', () => {
  const modulePath = path.resolve(__dirname, '../exercise-load.js');
  const script = `const l = require(${JSON.stringify(modulePath)});
    const start = new Date(2026, 6, 1, 0, 30);
    const readings = [{date:'2026-06-30',kg:79},{date:'2026-07-01',kg:80},{date:'2026-07-02',kg:90},
      {date:new Date(start.getTime()+1).toISOString(),kg:100}];
    const autumn = l.latestBodyweight([{date:'2026-10-25',kg:81},{date:'2026-10-26',kg:99}],new Date(2026,9,25,0,30));
    const spring = l.latestBodyweight([{date:'2026-03-29',kg:82},{date:'2026-03-30',kg:99}],new Date(2026,2,29,0,30));
    process.stdout.write(JSON.stringify([l.latestBodyweight(readings,start),autumn,spring,
      l.latestBodyweight([{date:'2026-07-01',kg:80}],new Date(2026,5,30,23,59,59))]));`;
  for (const timezone of ['Europe/London', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8'
    }));
    assert.deepEqual(result, [{ kg: 80, date: '2026-07-01' }, { kg: 81, date: '2026-10-25' },
      { kg: 82, date: '2026-03-29' }, null], timezone);
  }
});

test('duplicate measurement timestamps deterministically use the last valid stored reading', () => {
  assert.deepEqual(load.latestBodyweight([{ id: 'a', date: '2026-10-12', kg: 80 },
    { id: 'b', date: '2026-10-12', kg: 81 }, { date: '2026-10-12', kg: 0 }], '2026-10-12'),
  { kg: 81, date: '2026-10-12', sourceId: 'b' });
  for (const value of [0, -1, NaN, Infinity, null, undefined, '', ' ', false, [], {}]) {
    assert.equal(load.latestBodyweight([{ date: '2026-10-12', kg: value }], '2026-10-12'), null);
  }
});

test('optional estimates distinguish external load, bodyweight, assistance and added weight', () => {
  assert.equal(load.estimatedLoad({ loadType: 'external', w: '60' }), 60);
  assert.equal(load.estimatedLoad({ loadType: 'external', w: 0 }), 0);
  assert.equal(load.estimatedLoad({ loadType: 'bodyweight', bodyweightKg: 80 }), 80);
  assert.equal(load.estimatedLoad({ loadType: 'assisted', w: '18', bodyweightKg: 80 }), 62);
  assert.equal(load.estimatedLoad({ loadType: 'weighted', w: '10', bodyweightKg: '80' }), 90);
  assert.equal(load.estimatedLoad({ loadType: 'assisted', w: 0, bodyweightKg: 80 }), 80);
  assert.equal(load.estimatedLoad({ loadType: 'assisted', w: 80, bodyweightKg: 80 }), 0);
});

test('missing, non-finite and impossible estimates return null without discarding raw entries', () => {
  for (const value of [NaN, Infinity, -1, null, undefined, '', ' ', false, [], {}]) {
    assert.equal(load.estimatedLoad({ loadType: 'external', w: value }), null);
    assert.equal(load.estimatedLoad({ loadType: 'weighted', w: value, bodyweightKg: 80 }), null);
  }
  for (const value of [0, NaN, Infinity, -1, null, undefined, '', false]) {
    assert.equal(load.estimatedLoad({ loadType: 'bodyweight', bodyweightKg: value }), null);
    assert.equal(load.estimatedLoad({ loadType: 'assisted', w: 18, bodyweightKg: value }), null);
  }
  const unusualMachineSetting = Object.freeze({ loadType: 'assisted', w: 100, r: 8, bodyweightKg: 80 });
  assert.equal(load.estimatedLoad(unusualMachineSetting), null);
  assert.equal(unusualMachineSetting.w, 100);
  assert.equal(load.estimatedLoad({ loadType: 'weighted', w: Number.MAX_VALUE, bodyweightKg: Number.MAX_VALUE }), null);
  assert.equal(load.estimatedLoad({ w: 18, bodyweightKg: 80 }), null);
  assert.equal(load.estimatedLoad({ loadType: 'unknown', w: 18, bodyweightKg: 80 }), null);
});

test('new set snapshots retain raw weight and deep-copy unknown fields without mutating inputs', () => {
  const raw = { w: '18.0', r: '8', note: 'machine setting', extra: { tags: ['keep'], imported: true } };
  const snapshot = { kg: 80, date: '2026-10-12T08:00:00Z', sourceId: 'bw_1' };
  const result = load.snapshotSet(raw, 'assisted', snapshot);
  assert.deepEqual(result, { ...raw, loadType: 'assisted', bodyweightKg: 80,
    bodyweightDate: snapshot.date, bodyweightSourceId: 'bw_1' });
  result.extra.tags.push('new');
  assert.deepEqual(raw.extra.tags, ['keep']);
  snapshot.kg = 99;
  assert.equal(load.estimatedLoad(result), 62, 'future changes to a source object cannot alter a saved snapshot');
  assert.equal(raw.loadType, undefined);
  assert.equal(result.w, '18.0', 'raw numeric formatting is not normalized');
});

test('bodyweight logging needs only reps, and absent snapshots never fabricate a bodyweight', () => {
  const raw = { w: '18', r: 8, note: 'keep me' };
  assert.deepEqual(load.snapshotSet(raw, 'bodyweight', null), { w: 0, r: 8, note: 'keep me', loadType: 'bodyweight' });
  assert.equal(raw.w, '18');
  assert.equal(load.estimatedLoad(load.snapshotSet(raw, 'bodyweight', null)), null);
  for (const snapshot of [null, { kg: 80 }, { kg: -1, date: '2026-10-12' }, { kg: 80, date: '2026-02-30' }]) {
    assert.deepEqual(load.snapshotSet(raw, 'assisted', snapshot), { ...raw, loadType: 'assisted' });
  }
  assert.deepEqual(load.snapshotSet(raw, 'external', { kg: 80, date: '2026-10-12' }), { ...raw, loadType: 'external' });
  assert.throws(() => load.snapshotSet(raw, 'unknown', null), TypeError);
});

test('deliberate resnapshot replaces obsolete metadata; source IDs stay optional', () => {
  const old = { w: 18, r: 8, loadType: 'assisted', bodyweightKg: 80, bodyweightDate: '2026-10-01', bodyweightSourceId: 'old' };
  assert.deepEqual(load.snapshotSet(old, 'weighted', { kg: 82, date: '2026-10-12' }),
    { w: 18, r: 8, loadType: 'weighted', bodyweightKg: 82, bodyweightDate: '2026-10-12' });
  assert.deepEqual(load.snapshotSet(old, 'external', null), { w: 18, r: 8, loadType: 'external' });
  assert.equal(old.bodyweightKg, 80);
});

test('legacy backup roundtrip retains every original set and exercise field', () => {
  const original = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../test-data.json'), 'utf8'));
  const originalText = JSON.stringify(original);
  for (const session of original.data.sessions) for (const [id, rows] of Object.entries(session.entries)) {
    for (const row of rows) {
      load.resolveSetMode(row, original.data.exercises[id]);
      load.estimatedLoad(row);
    }
  }
  const parsed = storage.parseBackup(original);
  assert.deepEqual(parsed.sessions, original.data.sessions);
  assert.deepEqual(parsed.exercises, original.data.exercises);
  assert.equal(JSON.stringify(original), originalText);
});

test('backup and draft validation accept optional snapshots but reject invalid new metadata', () => {
  const row = load.snapshotSet({ w: 18, r: 8, extra: { preserve: true } }, 'assisted', { kg: 80, date: '2026-10-12' });
  const db = database(row, { loadType: 'weighted', isAssisted: true });
  assert.deepEqual(storage.parseBackup(db).sessions, db.sessions);
  assert.deepEqual(storage.validateDraft(db.sessions[0]), db.sessions[0]);
  assert.doesNotThrow(() => storage.parseBackup(database({ w: 0, r: 8, loadType: 'bodyweight',
    bodyweightKg: null, bodyweightDate: null, bodyweightSourceId: null })));
  assert.doesNotThrow(() => storage.parseBackup(database({ w: 100, r: 8, loadType: 'assisted', bodyweightKg: 80 })),
    'assistance above bodyweight prevents an estimate, not storage of the entered value');
  const invalid = [
    { loadType: 'unknown' }, { loadType: null }, { bodyweightKg: 0 }, { bodyweightKg: -1 },
    { bodyweightKg: 'Infinity' }, { bodyweightKg: NaN }, { bodyweightKg: '' }, { bodyweightKg: false },
    { bodyweightDate: 'invalid' }, { bodyweightDate: '2026-02-30' }, { bodyweightDate: '2026-02-30T10:00:00Z' },
    { bodyweightSourceId: '<script>' }, { bodyweightSourceId: 'constructor' }
  ];
  for (const metadata of invalid) {
    const bad = database({ w: 18, r: 8, ...metadata });
    assert.throws(() => storage.parseBackup(bad), error => error.code === 'VALIDATION', JSON.stringify(metadata));
    assert.throws(() => storage.validateDraft(bad.sessions[0]), error => error.code === 'VALIDATION');
  }
  assert.throws(() => storage.parseBackup(database(row, { loadType: 'unknown' })), error => error.code === 'VALIDATION');
});

test('durable roundtrip and later bodyweight updates cannot change historical snapshots', async () => {
  const snapshot = { kg: 80, date: '2026-10-12T08:00:00Z', sourceId: 'bw1' };
  const row = load.snapshotSet({ w: '18', r: '8', imported: { note: 'keep' } }, 'assisted', snapshot);
  const db = database(row, { loadType: 'assisted' });
  db.bodyweight = [{ id: 'bw1', date: snapshot.date, kg: 80 }];
  const env = { indexedDB: new IDBFactory(), localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  const store = storage.createStorage(env);
  const initial = await store.open(db);
  const edited = storage.clone(initial.db);
  edited.bodyweight[0].kg = 81;
  edited.bodyweight.push({ id: 'bw2', date: '2026-10-13T08:00:00Z', kg: 90 });
  edited.exercises.dips.loadType = 'weighted';
  await store.saveDB(edited, initial.db, { epoch: initial.epoch });
  store.close();
  const reopened = storage.createStorage(env);
  try {
    const loaded = await reopened.open(storage.clone(storage.BASE_DEFAULTS));
    const savedRow = loaded.db.sessions[0].entries.dips[0];
    assert.deepEqual(savedRow, row);
    assert.equal(load.resolveSetMode(savedRow, loaded.db.exercises.dips), 'assisted');
    assert.equal(load.estimatedLoad(savedRow), 62);
  } finally { reopened.close(); }
});

test('session snapshots are optional or explicitly unknown, while saved partial bodyweight input survives', () => {
  const original = database().sessions[0];
  for (const snapshot of [null, { kg: 80, date: '2026-10-12', sourceId: 'bw1' }]) {
    const session = { ...original, bodyweightSnapshot: snapshot,
      bodyweightInput: { value: '80.', unit: 'kg', originalKg: 80, originalDisplay: '80' } };
    assert.deepEqual(storage.validateDraft(session), session);
    const db = database(); db.sessions[0] = session;
    assert.deepEqual(storage.parseBackup(db).sessions[0], session);
  }
  for (const snapshot of [{}, { kg: 80 }, { date: '2026-10-12' }, { kg: 0, date: '2026-10-12' },
    { kg: 80, date: '2026-02-30' }, { kg: 80, date: '2026-10-12', sourceId: 'bad id' }, []]) {
    assert.throws(() => storage.validateDraft({ ...original, bodyweightSnapshot: snapshot }), error => error.code === 'VALIDATION');
  }
});
