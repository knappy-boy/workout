const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const statsSource = source.slice(source.indexOf('function updateStatsChart()'), source.indexOf('// --- EXPORT / IMPORT ---'));
function setup(db) {
  let table, points;
  const ctx = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  function node() {
    return { children: [], value: '', dataset: {}, style: {setProperty(name, value) { this[name] = value; }}, hidden: false, attributes: {},
      set innerHTML(value) { this.html = value; this.children = []; this.value = ''; },
      get innerHTML() { return this.html || ''; }, get options() { return this.children; },
      appendChild(child) { this.children.push(child); }, setAttribute(name, value) { this.attributes[name] = String(value); },
      getBoundingClientRect: () => ({ width: 360, height: 250 }), getContext: () => ctx,
      classList: { contains: () => false } };
  }
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  $('#statExSelect').value = 'lift'; $('#statChartType').value = 'volume';
  const sandbox = { LiftLogTheme: require('./helpers/theme-runtime.cjs')(), DB: db, $, document: { body: node(), createElement: node, querySelector: $ },
    window: { devicePixelRatio: 1 }, LiftLogDates: require('../dates.js'), LiftLogExerciseLoad: require('../exercise-load.js'),
    LiftLogChartMotion: require('../chart-motion.js'), MUSCLE_COLORS: { Back: '#64B5F6', Other: '#78909C' },
    _exerciseHistoryExpanded: false, updateBodyweightUnitLabel() {}, drawBodyweightChart() {}, renderBodyweightEntries() {}, renderBreakdownChart() {}, getWeightUnit: () => 'kg', convertWeight: value => Number(value),
    escapeHTML: value => String(value).replace(/</g, '&lt;'), formatAxisValue: String,
    updateChartDataTable(canvas, caption, rows) { table = { caption, rows }; },
    updateChartInspection(canvas, values) { points = values; } };
  vm.runInNewContext(source.slice(source.indexOf('function renderStats()'), source.indexOf('function updateStatsChart()')) + statsSource, sandbox);
  return { $, render: () => sandbox.renderStats(), draw: () => sandbox.updateStatsChart(), table: () => table, points: () => points };
}
function database(exercise, rows) {
  return { user: {}, bodyweight: [{ kg: 999 }], exercises: { lift: { id: 'lift', name: 'Lift', type: 'strength', muscle: 'Back', ...exercise } },
    sessions: rows.map((sets, i) => ({ id: String(i), start: `2026-09-${String(20 - i).padStart(2, '0')}T10:00:00Z`, entries: { lift: sets } })) };
}
test('mixed historical load modes get separate raw chart measures and preserve every history row', () => {
  const db = database({ loadType: 'weighted' }, [
    [{ w: 60, r: 8 }, { w: 20, r: 8, loadType: 'assisted', bodyweightKg: 80, bodyweightDate: '2026-09-01' }, { w: 10, r: 8, loadType: 'weighted' }, { w: 0, r: 7, loadType: 'bodyweight' }],
    [{ w: 55, r: 8 }, { w: 25, r: 8, loadType: 'assisted' }, { w: 7.5, r: 8, loadType: 'weighted' }, { w: 0, r: 6, loadType: 'bodyweight' }]
  ]);
  const before = JSON.stringify(db), h = setup(db); h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [60, 80]);
  assert.match(h.table().caption, /Added weight × reps/);
  assert.match(h.$('#exerciseHistory').innerHTML, /20kg assistance × 8/);
  assert.match(h.$('#exerciseHistory').innerHTML, /Est. load 60kg/);
  assert.match(h.$('#exerciseHistory').innerHTML, /Bodyweight × 7/);
  h.$('#statChartType').value = 'bodyweight:volume'; h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [6, 7]);
  assert.match(h.table().caption, /Total reps · reps/);
  h.$('#statChartType').value = 'assisted:maxWeight'; h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [25, 20]);
  assert.match(h.table().caption, /Highest assistance/);
  h.$('#statChartType').value = 'external:volume'; h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [440, 480]);
  assert.equal(JSON.stringify(db), before);
});
test('an edited library default does not reinterpret legacy external raw weights', () => {
  const h = setup(database({ loadType: 'bodyweight' }, [[{ w: 60, r: 8 }], [{ w: 50, r: 8 }]]));
  h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [400, 480]);
  assert.match(h.table().caption, /Volume · kg × reps/);
});
test('bodyweight records count reps and use only recorded snapshot estimates', () => {
  const db = database({ loadType: 'bodyweight' }, [[{ w: 0, r: 10, loadType: 'bodyweight', bodyweightKg: 81, bodyweightDate: '2026-09-01' }], [{ w: 0, r: 8, loadType: 'bodyweight' }]]);
  const h = setup(db); h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [8, 10]);
  assert.equal(h.points().length, 2);
  assert.match(h.$('#exerciseHistory').innerHTML, /Est. load 81kg/);
  assert.doesNotMatch(h.$('#exerciseHistory').innerHTML, /999kg/);
  assert.equal((h.$('#exerciseHistory').innerHTML.match(/Est\. load/g) || []).length, 1);
});
test('clearing the exercise selection also clears accessible chart values and the prior load note', () => {
  const h = setup(database({ loadType: 'assisted' }, [[{ w: 20, r: 8, loadType: 'assisted' }], [{ w: 25, r: 8, loadType: 'assisted' }]]));
  h.draw(); assert.equal(h.table().rows.length, 2); assert.equal(h.points().length, 2);
  assert.ok(h.$('#statMetricNote').textContent);
  h.$('#statExSelect').value = ''; h.draw();
  assert.equal(h.table().rows.length, 0); assert.match(h.table().caption, /no exercise selected/);
  assert.equal(h.points().length, 0); assert.equal(h.$('#exerciseHistory').innerHTML, '');
  assert.equal(h.$('#statMetricNote').textContent, ''); assert.equal(h.$('#statMetricNote').hidden, true);
  assert.equal(h.$('#btnToggleLiftHistory').attributes['aria-expanded'], 'false');
  assert.match(h.$('#btnToggleLiftHistory').attributes['aria-label'], /no exercise selected/);
});

test('one icon-only Lift History control expands and collapses with accurate accessible state', () => {
  const h = setup(database({}, [[{ w: 60, r: 8 }], [{ w: 55, r: 8 }]]));
  const toggle = h.$('#btnToggleLiftHistory');
  toggle.innerHTML = '<svg aria-hidden="true"></svg>';
  h.draw();
  assert.equal(h.$('#exerciseHistoryRegion').hidden, true);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.match(toggle.attributes['aria-label'], /^Expand lift history, 2 sessions/);
  assert.equal(toggle.textContent, undefined);
  toggle.onclick();
  assert.equal(h.$('#exerciseHistoryRegion').hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.match(toggle.attributes['aria-label'], /^Collapse lift history, 2 sessions/);
  assert.equal(h.table().rows.length, 2);
  toggle.onclick();
  assert.equal(h.$('#exerciseHistoryRegion').hidden, true);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.match(toggle.attributes['aria-label'], /^Expand lift history, 2 sessions/);
  assert.equal(toggle.innerHTML, '<svg aria-hidden="true"></svg>');
  assert.equal(h.table().rows.length, 2);
});
test('custom date changes filter the chart and every Lift History row identically without altering records', () => {
  const db = database({}, [[{ w: 60, r: 8 }], [{ w: 55, r: 8 }], [{ w: 50, r: 8 }]]);
  const before = JSON.stringify(db), h = setup(db);
  h.$('#progressRange').dataset.period = 'custom';
  h.$('#progressFrom').value = '2026-09-19'; h.$('#progressTo').value = '2026-09-20';
  h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [440, 480]);
  assert.match(h.$('#exerciseHistory').innerHTML, /55kg × 8/);
  assert.match(h.$('#exerciseHistory').innerHTML, /60kg × 8/);
  assert.doesNotMatch(h.$('#exerciseHistory').innerHTML, /50kg × 8/);
  h.$('#progressFrom').value = '2026-09-21'; h.draw();
  assert.equal(h.table().rows.length, 0); assert.equal(h.points().length, 0);
  assert.equal(h.$('#exerciseHistory').innerHTML, '');
  assert.equal(h.$('#exerciseHistoryRegion').hidden, true);
  assert.match(h.$('#progressRangeStatus').textContent, /From must/);
  h.$('#progressFrom').value = '2026-10-01'; h.$('#progressTo').value = '2026-10-02'; h.draw();
  assert.equal(h.table().rows.length, 0); assert.equal(h.$('#btnToggleLiftHistory').disabled, true);
  assert.doesNotMatch(h.$('#progressRangeStatus').textContent, /From must/);
  h.$('#progressRange').dataset.period = 'all'; h.draw();
  assert.equal(h.table().rows.length, 3);
  assert.equal(JSON.stringify(db), before);
});
test('an empty date range retains the chosen historical load measure', () => {
  const h = setup(database({ loadType: 'weighted' }, [
    [{ w: 20, r: 8, loadType: 'assisted' }, { w: 10, r: 8, loadType: 'weighted' }],
    [{ w: 25, r: 8, loadType: 'assisted' }, { w: 7.5, r: 8, loadType: 'weighted' }]
  ]));
  h.draw(); h.$('#statChartType').value = 'assisted:maxWeight'; h.draw();
  h.$('#progressRange').dataset.period = 'custom'; h.$('#progressFrom').value = '2026-10-01'; h.$('#progressTo').value = '2026-10-02'; h.draw();
  assert.equal(h.table().rows.length, 0);
  assert.equal(h.$('#statChartType').value, 'assisted:maxWeight');
  h.$('#progressRange').dataset.period = 'all'; h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [25, 20]);
});
test('an invalid range collapses the effective history state in both visible and accessible labels', () => {
  const h = setup(database({}, [[{ w: 60, r: 8 }], [{ w: 55, r: 8 }]]));
  h.draw(); h.$('#btnToggleLiftHistory').onclick();
  assert.equal(h.$('#btnToggleLiftHistory').attributes['aria-expanded'], 'true');
  h.$('#progressRange').dataset.period = 'custom';
  h.$('#progressFrom').value = '2026-08-01'; h.$('#progressTo').value = '2026-07-31'; h.draw();
  const button = h.$('#btnToggleLiftHistory');
  assert.equal(h.$('#exerciseHistoryRegion').hidden, true);
  assert.equal(button.disabled, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.match(button.attributes['aria-label'], /^Expand lift history, 0 sessions/);
});


test('progress exposes two sliding measures for the current load type and keeps legacy mixed history separate', () => {
  const db = database({ loadType: 'weighted' }, [
    [{ w: 60, r: 8 }, { w: 20, r: 8, loadType: 'assisted' }, { w: 10, r: 8, loadType: 'weighted' }, { w: 0, r: 7, loadType: 'bodyweight' }],
    [{ w: 55, r: 8 }, { w: 25, r: 8, loadType: 'assisted' }, { w: 7.5, r: 8, loadType: 'weighted' }, { w: 0, r: 6, loadType: 'bodyweight' }]
  ]);
  const before = JSON.stringify(db), h = setup(db); h.render();
  const measures = h.$('#statChartType'), loads = h.$('#statLoadMode');
  const visible = () => measures.options.filter(option => !option.hidden).map(option => [option.value, option.textContent]);
  assert.equal(loads.hidden, false);
  assert.equal(loads.value, 'weighted');
  assert.deepEqual(visible(), [['weighted:volume', 'Added weight × reps'], ['weighted:maxWeight', 'Max added weight']]);
  assert.equal(measures.options.length, 8, 'all raw historical measures remain available to the chart');
  measures.value = 'weighted:maxWeight'; h.draw();
  loads.value = 'assisted'; loads.onchange();
  assert.equal(measures.value, 'assisted:maxWeight');
  assert.deepEqual(visible(), [['assisted:volume', 'Assistance × reps'], ['assisted:maxWeight', 'Highest assistance']]);
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [25, 20]);
  loads.value = 'bodyweight'; loads.onchange();
  assert.equal(measures.value, 'bodyweight:maxWeight');
  assert.deepEqual(visible(), [['bodyweight:volume', 'Total reps'], ['bodyweight:maxWeight', 'Best set reps']]);
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [6, 7]);
  assert.equal(JSON.stringify(db), before);
});

test('single-load progress omits the extra selector and category colour follows exercise changes', () => {
  const db = database({}, [[{ w: 60, r: 8 }], [{ w: 55, r: 8 }]]);
  db.exercises.second = {id: 'second', name: 'Another lift', type: 'strength', muscle: 'Other', loadType: 'bodyweight'};
  const h = setup(db); h.render();
  assert.equal(h.$('#statLoadMode').hidden, true);
  assert.deepEqual(h.$('#statChartType').options.filter(option => !option.hidden).map(option => option.textContent), ['Volume', 'Max weight']);
  assert.equal(h.$('#statExercisePill').style['--progress-muscle'], '#64B5F6');
  h.$('#statExSelect').value = 'second'; h.$('#statExSelect').onchange();
  assert.equal(h.$('#statExercisePill').style['--progress-muscle'], '#78909C');
  assert.equal(h.$('#statLoadMode').hidden, true);
  assert.deepEqual(h.$('#statChartType').options.map(option => option.textContent), ['Total reps', 'Best set reps']);
  h.$('#statExSelect').value = ''; h.draw();
  assert.equal(h.$('#statChartType').hidden, true);
});

test('changing recorded load type in an empty custom range retains the measure when records return', () => {
  const h = setup(database({ loadType: 'weighted' }, [
    [{ w: 20, r: 8, loadType: 'assisted' }, { w: 10, r: 8, loadType: 'weighted' }],
    [{ w: 25, r: 8, loadType: 'assisted' }, { w: 7.5, r: 8, loadType: 'weighted' }]
  ]));
  h.render(); h.$('#statChartType').value = 'weighted:maxWeight'; h.draw();
  h.$('#progressRange').dataset.period = 'custom';
  h.$('#progressFrom').value = '2026-10-01'; h.$('#progressTo').value = '2026-10-02'; h.draw();
  h.$('#statLoadMode').value = 'assisted'; h.$('#statLoadMode').onchange();
  assert.equal(h.table().rows.length, 0);
  assert.equal(h.$('#statChartType').value, 'assisted:maxWeight');
  assert.deepEqual(h.$('#statChartType').options.filter(option => !option.hidden).map(option => option.value), ['assisted:volume', 'assisted:maxWeight']);
  h.$('#progressRange').dataset.period = 'all'; h.draw();
  assert.deepEqual(Array.from(h.table().rows, row => row[1]), [25, 20]);
});
