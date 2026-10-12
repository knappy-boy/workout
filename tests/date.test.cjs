const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const dates = require('../dates.js');

process.env.TZ = 'Europe/London';

test('calendar uses the local day at UK summer midnight and UTC boundaries', () => {
  assert.equal(dates.localDayKey(new Date(2026, 6, 1)), '2026-07-01');
  assert.equal(dates.localDayKey('2026-06-30T23:30:00.000Z'), '2026-07-01');
  assert.equal(dates.localDayKey('2026-07-01'), '2026-07-01');
  assert.equal(dates.localDayKey('invalid'), '');
  assert.equal(dates.localDayKey('2026-02-30'), '');
});

test('date-only details remain on the selected day west of UTC', () => {
  const script = `const d = require(${JSON.stringify(path.resolve(__dirname, '../dates.js'))});
    process.stdout.write(JSON.stringify([d.localDayKey('2026-07-01'),
      d.parseLocalDay('2026-07-01').getDate(), d.localDayKey('2026-07-01T02:00:00Z')]));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8'
  }));
  assert.deepEqual(result, ['2026-07-01', 1, '2026-06-30']);
});

test('week includes Sunday midnight through Saturday night, excluding adjacent days', () => {
  const p = dates.periodInfo('week', 'daily', 0, new Date(2026, 9, 14, 15, 45));
  assert.equal(dates.localDayKey(p.startDate), '2026-10-11');
  assert.equal(dates.localDayKey(p.endDate), '2026-10-18');
  assert.equal(p.startDate.getHours(), 0);
  assert.equal(dates.inPeriod(new Date(2026, 9, 11, 0), p.startDate, p.endDate), true);
  assert.equal(dates.inPeriod(new Date(2026, 9, 17, 23, 59, 59, 999), p.startDate, p.endDate), true);
  assert.equal(dates.inPeriod(new Date(2026, 9, 18, 0), p.startDate, p.endDate), false);
  assert.equal(dates.inPeriod(new Date(2026, 9, 10, 23, 59), p.startDate, p.endDate), false);
});

test('monthly and annual periods include their entire last day, including leap years', () => {
  for (const [period, now, lastDay, nextDay, count] of [
    ['month', new Date(2024, 1, 15, 9), new Date(2024, 1, 29, 23, 59), new Date(2024, 2, 1), 29],
    ['month', new Date(2026, 3, 15, 9), new Date(2026, 3, 30, 23, 59), new Date(2026, 4, 1), 30],
    ['year', new Date(2026, 6, 15, 9), new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1), 12]
  ]) {
    const p = dates.periodInfo(period, 'daily', 0, now);
    assert.equal(dates.inPeriod(lastDay, p.startDate, p.endDate), true);
    assert.equal(dates.inPeriod(nextDay, p.startDate, p.endDate), false);
    assert.equal(p.labels.length, count);
  }
});

test('weekly bins follow calendar days across both UK daylight-saving transitions', () => {
  for (const start of [new Date(2026, 2, 29), new Date(2026, 9, 25)]) {
    const p = dates.periodInfo('week', 'daily', 0, start);
    for (let day = 0; day < 7; day++) {
      for (const hour of [0, 12, 23]) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, hour);
        assert.equal(dates.breakdownIndex(date, p.startDate, 'week', 7), day);
      }
    }
  }
});

test('every calendar date is counted exactly once in annual weekly charts', () => {
  for (const year of [2024, 2026]) {
    const p = dates.periodInfo('year', 'weekly', 0, new Date(year, 6, 1));
    assert.equal(p.labels.length, 53);
    const counts = Array(53).fill(0);
    for (let d = new Date(year, 0, 1); d < p.endDate; d.setDate(d.getDate() + 1)) {
      const index = dates.breakdownIndex(d, p.startDate, 'year', p.labels.length, 'weekly');
      assert.equal(dates.inPeriod(d, p.startDate, p.endDate), true);
      counts[index]++;
    }
    assert.deepEqual(counts.slice(0, 52), Array(52).fill(7));
    assert.equal(counts[52], year === 2024 ? 2 : 1);
  }
});

test('month weekly bins and previous periods handle year rollover', () => {
  const p = dates.periodInfo('month', 'weekly', -1, new Date(2026, 0, 31));
  assert.equal(p.labelText, 'December 2025');
  assert.equal(p.labels.length, 5);
  assert.equal(dates.breakdownIndex(new Date(2025, 11, 31, 23), p.startDate, 'month', 5, 'weekly'), 4);
  const feb = dates.periodInfo('month', 'weekly', 0, new Date(2026, 1, 1));
  assert.equal(feb.labels.length, 4);
  assert.equal(dates.breakdownIndex(new Date(2025, 11, 31), new Date(2026, 0, 1), 'year', 12), -1);
});

test('completed exercise totals exclude blank/invalid/planned sets and keep bodyweight reps', () => {
  const exercises = { strength: { type: 'strength' }, cardio: { type: 'cardio' }, empty: {}, planned: {} };
  const session = { order: ['strength', 'cardio', 'empty', 'planned', 'strength'], entries: {
    strength: [{ w: '', r: '' }, { w: '20', r: '8' }, { w: '0', r: '12' }, { w: '', r: '6' },
      { w: '-5', r: '8' }, { w: '20', r: '0' }, { w: '20', r: '1.5' }],
    cardio: [{ time: '', dist: '' }, { time: '10', dist: '1.5' }, { time: '', dist: '2' }],
    empty: [{ w: '', r: '' }], planned: [{ w: '100', r: '10', completed: false }],
    unlisted: [{ w: '10', r: '5' }]
  } };
  const original = JSON.stringify(session);
  assert.equal(dates.completedSets(session.entries.strength, exercises.strength).length, 3);
  assert.equal(dates.completedSets(session.entries.cardio, exercises.cardio).length, 2);
  assert.deepEqual(dates.completedExerciseIds(session, exercises), ['strength', 'cardio', 'unlisted']);
  assert.equal(JSON.stringify(session), original, 'reading metrics never rewrites stored workouts');
});

test('actual breakdown chart includes final-day logs and counts primary muscles only, even with legacy compound settings', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const chartFunctions = app.slice(app.indexOf('function getBreakdownPeriodInfo()'), app.indexOf('function drawHiResBarChart('));
  let chartData;
  const elements = {};
  const element = () => ({ style: {}, classList: { contains: () => false }, appendChild() {}, innerHTML: '' });
  const context2d = { scale() {} };
  elements['#breakdownPeriod'] = { value: 'month' };
  elements['#breakdownGranularity'] = { value: 'daily' };
  elements['#breakdownMode'] = { value: 'sets' };
  elements['#breakdownChart'] = { getBoundingClientRect: () => ({ width: 400, height: 240 }), getContext: () => context2d };
  const entries = {
    bench: [{ w: '20', r: '8' }, { w: '20', r: '8' }, { w: '', r: '' }, { w: '20', r: '8', completed: false }]
  };
  const sandbox = {
    LiftLogTheme: require('./helpers/theme-runtime.cjs')(),
    LiftLogDates: { ...dates, periodInfo: (period, granularity, offset) => dates.periodInfo(period, granularity, offset, new Date(2026, 6, 15)) },
    $: selector => elements[selector] || (elements[selector] = element()),
    document: { body: element(), createElement: element },
    window: { devicePixelRatio: 1 },
    DB: {
      user: { includeCompound: true },
      exercises: { bench: { type: 'strength', muscle: 'Chest', isCompound: true, secondaryMuscles: ['Triceps', 'Triceps', 'Chest', 'Unknown'] } },
      sessions: [
        { start: new Date(2026, 6, 31, 23, 59).toISOString(), entries },
        { start: new Date(2026, 5, 30, 23, 59).toISOString(), entries },
        { start: new Date(2026, 7, 1).toISOString(), entries }
      ]
    },
    _breakdownOffset: 0, _hiddenMuscles: new Set(),
    MUSCLE_GROUPS: ['Chest', 'Triceps', 'Other'], MUSCLE_COLORS: {},
    convertWeight: value => value,
    drawHiResStackedBarChart: (_ctx, _w, _h, _labels, data) => { chartData = data; }
  };
  vm.createContext(sandbox);
  vm.runInContext(chartFunctions, sandbox);
  const original = JSON.stringify(sandbox.DB);
  sandbox.renderBreakdownChart();
  assert.equal(chartData.Chest[30], 2);
  assert.equal(chartData.Triceps[30], 0);
  assert.equal(Object.values(chartData.Chest).reduce((a, b) => a + b, 0), 2);
  elements['#breakdownMode'].value = 'volume';
  sandbox.renderBreakdownChart();
  assert.equal(chartData.Chest[30], 320);
  assert.equal(chartData.Triceps[30], 0);
  assert.equal(JSON.stringify(sandbox.DB), original, 'reading stats preserves legacy flags and muscle metadata');
  // Hiding the primary muscle must not reveal credited secondary-muscle work.
  sandbox._hiddenMuscles.add('Chest');
  for (const mode of ['sets', 'volume']) {
    elements['#breakdownMode'].value = mode;
    sandbox.renderBreakdownChart();
    assert.ok(Object.values(chartData).every(values => Object.values(values).every(value => value === 0)));
  }
});
