const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const recaps = require('../recaps.js');

process.env.TZ = 'Europe/London';
const NOW = new Date(2026, 9, 12, 12);
function workout(id, date, entries = { bench: [{ w: 60, r: 8 }] }, more = {}) {
  const start = new Date(date);
  return { id, start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), entries, ...more };
}
function database(sessions = [], extras = {}) {
  return { user: { useLbs: false, includeCompound: true }, exercises: {
    bench: { id: 'bench', name: 'Bench press', type: 'strength', muscle: 'Chest', equip: 'barbell', isCompound: true, secondaryMuscles: ['Triceps', 'Shoulders'] },
    curl: { id: 'curl', name: 'Biceps curl', type: 'strength', muscle: 'Biceps', equip: 'dumbbell' },
    assisted: { id: 'assisted', name: 'Assisted pull-up', type: 'strength', muscle: 'Back', isAssisted: true },
    bw: { id: 'bw', name: 'Push-up', type: 'strength', muscle: 'Chest', equip: 'bodyweight' },
    bike: { id: 'bike', name: 'Bike', type: 'cardio', muscle: 'Cardio' }
  }, templates: {}, sessions, bodyweight: [], goals: {}, ...extras };
}
function summary(db, key = '2026-09', options = {}) { return recaps.summarizeMonth(db, key, { now: NOW, ...options }); }
function deepFreeze(value) { Object.values(value).forEach(item => { if (item && typeof item === 'object') deepFreeze(item); }); return Object.freeze(value); }

test('only finished workouts with completed entries count; drafts, invalid, planned and empty sessions do not', () => {
  const db = database([
    workout('done', '2026-09-01T10:00Z'),
    workout('draft', '2026-09-02T10:00Z', undefined, { end: null }),
    workout('empty', '2026-09-03T10:00Z', {}),
    workout('planned', '2026-09-04T10:00Z', { bench: [{ w: 60, r: 8, completed: false }] }),
    workout('partial', '2026-09-05T10:00Z', { bench: [{ w: 60, r: '' }] }),
    workout('invalid-end', '2026-09-06T10:00Z', undefined, { end: '2026-09-06T09:00Z' }),
    workout('future-end', '2026-09-07T10:00Z', undefined, { end: '2026-11-01T10:00Z' }),
    workout('cardio', '2026-09-08T10:00Z', { bike: [{ time: '12.5', dist: '0' }] }),
    workout('zero-load', '2026-09-09T10:00Z', { bw: [{ w: 0, r: 10 }] })
  ]);
  const result = summary(db);
  assert.equal(result.workoutCount, 3);
  assert.equal(result.completedStrengthSets, 2);
  assert.equal(result.hasData, true);
});

test('duration comes from the current timestamps, includes rests, and reflects a history correction immediately', () => {
  const session = workout('edited', '2026-09-01T10:00Z');
  const db = database([session]);
  assert.equal(summary(db).totalMinutes, 60);
  session.end = '2026-09-01T10:22:00.000Z';
  session.duration = 9999; // Any stale derived field must be ignored.
  assert.equal(summary(db).totalMinutes, 22);
  assert.equal(summary(db).durationMs, 1320000);
  assert.match(summary(db).timeDefinition, /including rests/);
});

test('month selection follows local start dates and includes the whole final day', () => {
  const db = database([
    workout('local-september', '2026-08-31T23:30:00Z'),
    workout('last-minute', '2026-09-30T22:59:00Z'),
    workout('local-october', '2026-09-30T23:01:00Z')
  ]);
  assert.equal(summary(db).workoutCount, 2);
  assert.deepEqual(recaps.availableMonths(db, NOW), ['2026-09']);
});

test('month availability waits for the next local month, including the first visit on October 3', () => {
  const db = database([workout('sept', '2026-09-10T10:00Z'), workout('aug', '2026-08-10T10:00Z')]);
  assert.equal(summary(db, '2026-09', { now: new Date(2026, 8, 30, 23, 59) }).hasData, false);
  assert.equal(recaps.latestMonth(db, new Date(2026, 9, 3)), '2026-09');
  assert.equal(summary(db, '2026-10').isCompletedMonth, false);
  assert.equal(summary(db, '2027-01').workoutCount, 0);
  assert.deepEqual(recaps.availableMonths(db, NOW), ['2026-09', '2026-08']);
});

test('Home has no previous-month invitation when that month is empty; Stats still exposes old populated months', () => {
  const db = database([workout('old', '2026-04-13T10:00Z')]);
  assert.equal(recaps.latestMonth(db, NOW), null);
  assert.deepEqual(recaps.availableMonths(db, NOW), ['2026-04']);
  const empty = summary(db);
  assert.equal(empty.hasData, false);
  assert.equal(empty.personalBest, null);
  assert.equal(empty.highlight, null);
  assert.equal(empty.activeWeeks, 0);
});

test('primary-muscle totals ignore compound/secondary credit and exclude cardio records', () => {
  const db = database([workout('one', '2026-09-01T10:00Z', {
    bench: [{ w: 60, r: 8 }, { w: 60, r: 8 }, { w: 60, r: 8, completed: false }],
    curl: [{ w: 10, r: 10 }], bike: [{ time: 10, dist: 2 }]
  })]);
  const result = summary(db);
  assert.deepEqual(result.muscleSets, { Chest: 2, Biceps: 1 });
  assert.equal(result.completedStrengthSets, 3);
  assert.deepEqual(result.topMuscle, { name: 'Chest', sets: 2, tied: false, ties: ['Chest'] });
});

test('tied muscle totals are reported as ties rather than invented winners', () => {
  const db = database([workout('tie', '2026-09-01T10:00Z', {
    bench: [{ w: 60, r: 8 }], curl: [{ w: 10, r: 10 }]
  })]);
  assert.deepEqual(summary(db).topMuscle.ties, ['Biceps', 'Chest']);
  assert.equal(summary(db).topMuscle.tied, true);
});

test('active weeks are calendar weeks, independent of the clock and a streak goal', () => {
  const db = database([
    workout('saturday', '2026-09-05T10:00Z'), workout('sunday', '2026-09-06T00:00Z'),
    workout('same-week', '2026-09-10T22:00Z')
  ]);
  assert.equal(summary(db).activeWeeks, 2);
  assert.equal(summary(db, '2026-09', { weekStartsOn: 1 }).activeWeeks, 2);
  const dst = database([workout('dst', '2026-10-25T00:30:00Z', undefined, { end: '2026-10-25T01:30:00Z' })]);
  assert.equal(summary(dst, '2026-10', { now: new Date(2026, 10, 1) }).totalMinutes, 60);
});

test('routine frequency retains stored names and excludes Freestyle from most-used routine', () => {
  const db = database([
    workout('a', '2026-09-01T10:00Z', undefined, { templateId: 'old', templateName: 'Chest & Arms' }),
    workout('b', '2026-09-02T10:00Z', undefined, { templateId: 'old', templateName: 'Chest & Arms' }),
    workout('c', '2026-09-03T10:00Z', undefined, { templateName: 'Freestyle' })
  ]);
  assert.deepEqual(summary(db).favouriteRoutine, { id: 'old', name: 'Chest & Arms', count: 2, tied: false, ties: ['Chest & Arms'] });
});

test('a PB requires the same exercise and reps, with a heavier load than every earlier completed workout', () => {
  const db = database([
    workout('prior', '2026-04-01T10:00Z', { bench: [{ w: 70, r: 8 }] }),
    workout('different-reps', '2026-08-01T10:00Z', { bench: [{ w: 100, r: 1 }] }),
    workout('equal', '2026-09-01T10:00Z', { bench: [{ w: 70, r: 8 }] }),
    workout('best', '2026-09-04T10:00Z', { bench: [{ w: 72.5, r: 8 }] })
  ]);
  const best = summary(db).personalBest;
  assert.equal(best.exerciseId, 'bench'); assert.equal(best.reps, 8);
  assert.equal(best.weightKg, 72.5); assert.equal(best.previousWeightKg, 70);
  assert.equal(summary(db).highlight.kind, 'personalBest');
  db.sessions[0].entries.bench[0].w = 80;
  assert.equal(summary(db).personalBest, null);
});

test('a first result, extra sets in that workout, and a different rep count do not invent a PB', () => {
  const db = database([
    workout('first', '2026-09-01T10:00Z', { bench: [{ w: 50, r: 8 }, { w: 60, r: 8 }] }),
    workout('new-reps', '2026-09-08T10:00Z', { bench: [{ w: 70, r: 5 }] })
  ]);
  assert.equal(summary(db).personalBest, null);
});

test('assisted, bodyweight, zero-load and cardio entries are never compared as external-load PBs', () => {
  const db = database([
    workout('before', '2026-08-01T10:00Z', { assisted: [{ w: 30, r: 8 }], bw: [{ w: 10, r: 8 }], bike: [{ time: 10, dist: 2 }], bench: [{ w: 0, r: 8 }] }),
    workout('after', '2026-09-01T10:00Z', { assisted: [{ w: 35, r: 8 }], bw: [{ w: 15, r: 8 }], bike: [{ time: 20, dist: 4 }], bench: [{ w: 10, r: 8 }] })
  ]);
  assert.equal(summary(db).personalBest, null);
});

test('deleted/unknown definitions keep workout counts without inventing a PB or muscle attribution', () => {
  const db = database([workout('unknown', '2026-09-01T10:00Z', { removed: [{ w: 20, r: 8 }] })]);
  assert.equal(summary(db).workoutCount, 1);
  assert.deepEqual(summary(db).muscleSets, { Other: 1 });
  assert.equal(summary(db).personalBest, null);
});

test('summarising and listing archives leave the complete input backup byte-for-byte unchanged', () => {
  const db = database([workout('before', '2026-08-01T10:00Z'), workout('after', '2026-09-01T10:00Z', { bench: [{ w: 62.5, r: 8 }] }, { notes: '<b>literal</b>', exerciseNotes: { bench: 'keep me' } })], { activeDraft: { notes: 'unfinished' }, schemaVersion: 1 });
  const before = JSON.stringify(db);
  deepFreeze(db);
  summary(db); summary(db); recaps.availableMonths(db, NOW); recaps.latestMonth(db, NOW);
  assert.equal(JSON.stringify(db), before);
});

test('local month interpretation is correct west of UTC and does not parse day-only dates as UTC', () => {
  const script = `const r=require(${JSON.stringify(path.resolve(__dirname, '../recaps.js'))}); process.stdout.write(JSON.stringify([r.monthKey('2026-09-01'),r.monthKey('2026-09-01T02:00:00Z')]));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }));
  assert.deepEqual(result, ['2026-09', '2026-08']);
});

test('invalid month keys are rejected and duration labels retain minutes without false precision', () => {
  for (const key of ['2026-00', '2026-13', '2026-9', '2026-09-01', '<script>']) assert.throws(() => summary(database(), key), RangeError);
  assert.equal(recaps.formatDuration(430), '7h 10m');
  assert.equal(recaps.formatDuration(60), '1h');
  assert.equal(recaps.formatDuration(22), '22 min');
  assert.equal(recaps.formatDuration(0), '<1 min');
});

test('highlight choices contain only evidenced results and preserve the initial month selection', () => {
  const routine = { templateId: 'chest', templateName: 'Chest & Arms' };
  const db = database([
    workout('baseline', '2026-08-01T10:00Z'),
    workout('best', '2026-09-01T10:00Z', { bench: [{ w: 62.5, r: 8 }] }, routine),
    workout('repeat', '2026-09-08T10:00Z', { bench: [{ w: 62.5, r: 8 }] }, routine)
  ]);
  const result = summary(db);
  assert.deepEqual(result.highlights.map(item => item.kind), ['personalBest', 'muscle', 'routine']);
  assert.equal(result.highlight, result.highlights[0]);
  const sparse = summary(database([workout('only', '2026-09-01T10:00Z')]));
  assert.deepEqual(sparse.highlights.map(item => item.kind), ['muscle']);
  assert.deepEqual(summary(database()).highlights, []);
});

test('recap PBs never combine explicit bodyweight, assistance or weighted-bodyweight raw values with external sets', () => {
  for (const mode of ['bodyweight', 'assisted', 'weighted']) {
    const db = database([
      workout('old', '2026-08-12T10:00:00Z', { bench: [{ w: 60, r: 8, loadType: 'external' }] }),
      workout('new', '2026-09-12T10:00:00Z', { bench: [{ w: 90, r: 8, loadType: mode, bodyweightKg: 80, bodyweightDate: '2026-09-01' }] })
    ]);
    assert.equal(summary(db).personalBest, null, mode);
    assert.equal(summary(db).workoutCount, 1);
    assert.equal(summary(db).completedStrengthSets, 1);
  }
});
test('a changed default load type never rewrites legacy external PB history', () => {
  const db = database([
    workout('old', '2026-08-12T10:00:00Z', { bench: [{ w: 60, r: 8 }] }),
    workout('new', '2026-09-12T10:00:00Z', { bench: [{ w: 62.5, r: 8 }] })
  ]);
  db.exercises.bench.loadType = 'bodyweight';
  assert.equal(summary(db).personalBest.weightKg, 62.5);
});
test('explicit external sets earn external PBs independently of retained legacy assisted flags', () => {
  const db = database([
    workout('legacy', '2026-07-12T10:00:00Z', { assisted: [{ w: 90, r: 8 }] }),
    workout('external-before', '2026-08-12T10:00:00Z', { assisted: [{ w: 20, r: 8, loadType: 'external' }] }),
    workout('external-now', '2026-09-12T10:00:00Z', { assisted: [{ w: 25, r: 8, loadType: 'external' }] })
  ]);
  db.exercises.assisted.loadType = 'external'; db.exercises.assisted.equip = 'bodyweight';
  assert.equal(summary(db).personalBest.weightKg, 25);
  assert.equal(summary(db).personalBest.previousWeightKg, 20);
});
