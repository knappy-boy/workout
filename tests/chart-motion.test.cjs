const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnimator, viewport, anchoredZoom } = require('../chart-motion.js');
function clock() {
  let time = 0, sequence = 0, reduced = false;
  const frames = new Map();
  const animator = createAnimator({ requestFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelFrame(id) { frames.delete(id); }, now: () => time, reduced: () => reduced });
  return { animator, frames, setReduced(value) { reduced = value; }, tick(value) { time = value; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); } };
}
test('cascade staggers whole bars, then reaches exact non-rounded targets with no live frame', () => {
  const c = clock(); let values, done;
  c.animator.animate('chart', [{ key: 'first', value: 18.5, delayIndex: 0 }, { key: 'second', value: 24, delayIndex: 1 }], (v, d) => { values = v; done = d; }, { cascade: true, duration: 100, stagger: 30 });
  c.tick(20); assert.ok(values[0] > 0); assert.equal(values[1], 0); assert.equal(done, false);
  c.tick(130); assert.deepEqual(values, [18.5, 24]); assert.equal(done, true); assert.equal(c.frames.size, 0);
});
test('rapid filters start at the last rendered picture and the latest target wins', () => {
  const c = clock(); let values;
  const draw = v => { values = v; };
  c.animator.animate('chart', [{ key: 'Chest', value: 100 }], draw, { duration: 100 });
  c.tick(40); const middle = values[0]; assert.ok(middle > 0 && middle < 100);
  c.animator.animate('chart', [{ key: 'Chest', value: 20 }], draw, { duration: 100 });
  assert.equal(values[0], middle); assert.equal(c.frames.size, 1);
  c.tick(70);
  c.animator.animate('chart', [{ key: 'Chest', value: 60 }, { key: 'Back', value: 8 }], draw, { duration: 100 });
  c.tick(200); assert.deepEqual(values, [60, 8]); assert.equal(c.frames.size, 0);
});
test('reduced motion applies final data immediately, including when enabled during a cascade', () => {
  const c = clock(); let values;
  const rows = [{ key: 'a', value: 8 }, { key: 'b', value: 16 }];
  c.animator.animate('chart', rows, v => { values = v; }, { cascade: true });
  c.tick(20); c.setReduced(true); c.animator.finishAll();
  assert.deepEqual(values, [8, 16]); assert.equal(c.frames.size, 0);
  c.animator.animate('chart', [{ key: 'a', value: 3 }], v => { values = v; });
  assert.deepEqual(values, [3]); assert.equal(c.frames.size, 0);
});
test('cancelling an empty or hidden chart prevents old data being drawn later', () => {
  const c = clock(); let draws = 0;
  c.animator.animate('chart', [{ key: 'a', value: 9 }], () => draws++);
  c.animator.cancel('chart', true); const before = draws;
  c.tick(500); assert.equal(draws, before); assert.equal(c.frames.size, 0);
});
test('fractional pan remains continuous and clamps to the recorded range', () => {
  assert.deepEqual(viewport(14, 3, 1.4), { count: 14 / 3, offset: 1.4 });
  assert.equal(viewport(14, 3, -2).offset, 0);
  assert.equal(viewport(14, 3, 100).offset, 14 - 14 / 3);
  assert.deepEqual(viewport(1, 10, 99), { count: 1, offset: 0 });
  assert.deepEqual(viewport(0, 1, 0), { count: 0, offset: 0 });
});
test('zoom keeps the data point under the gesture midpoint where bounds allow', () => {
  const offset = anchoredZoom(20, 2, 3, 4, 0.3);
  const oldPoint = 3 + 0.3 * (10 - 1);
  const newPoint = offset + 0.3 * (5 - 1);
  assert.ok(Math.abs(oldPoint - newPoint) < 1e-9);
  assert.equal(anchoredZoom(20, 4, 10, 1, 0.5), 0);
});

test('chart geometry stays finite on compact, hidden and normal canvases', () => {
  const { plotGeometry } = require('../chart-motion.js');
  assert.deepEqual(plotGeometry(320, 200), { left: 40, top: 20, width: 260, height: 140 });
  assert.deepEqual(plotGeometry(0, 0), { left: 40, top: 20, width: 0, height: 0 });
  assert.deepEqual(plotGeometry(50, 40), { left: 40, top: 20, width: 0, height: 0 });
});
test('tap mapping chooses nearby points, actual bars and ignores gaps or empty bars', () => {
  const { hitTest } = require('../chart-motion.js');
  const points = [{ x: 40, y: 90 }, { x: 100, y: 60 }];
  assert.equal(hitTest(points, 104, 63), 1);
  assert.equal(hitTest(points, 12, 90), -1);
  assert.equal(hitTest(points, NaN, 60), -1);
  const bars = [{ x: 40, y: 50, width: 20, height: 100 }, { x: 75, y: 100, width: 20, height: 50 }, { x: 110, y: 150, width: 20, height: 0 }];
  assert.equal(hitTest(bars, 50, 60), 0);
  assert.equal(hitTest(bars, 80, 120), 1);
  assert.equal(hitTest(bars, 70, 120), -1);
  assert.equal(hitTest(bars, 80, 60), -1);
  assert.equal(hitTest(bars, 120, 150), -1);
});
test('adaptive chart ranges expose small load changes without zero-range divisions', () => {
  const { niceRange } = require('../chart-motion.js');
  for (const values of [[], [0, 0], [60, 60], [60, 62.5], [10000, 24000]]) {
    const range = niceRange(values);
    assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max));
    assert.ok(range.max > range.min);
    values.forEach(value => assert.ok(value >= range.min && value <= range.max));
  }
  assert.ok(niceRange([60, 62.5]).max - niceRange([60, 62.5]).min < 20);
});

test('date labels reserve the final point and skip a crowded penultimate label at phone widths', () => {
  const { spacedAxisLabels } = require('../chart-motion.js');
  const dates = ['15/6', '6/7', '27/7', '17/8', '7/9', '28/9', '5/10'];
  const positions = [0, 3, 6, 9, 12, 15, 16];
  const widths = [24, 17, 24, 24, 17, 24, 24];
  const candidates = positions.map((index, i) => ({ x: 40 + index / 16 * 266, label: dates[i], width: widths[i] }));
  const before = JSON.stringify(candidates), selected = spacedAxisLabels(candidates, 12);
  assert.equal(selected[0].label, '15/6');
  assert.equal(selected.at(-1).label, '5/10');
  assert.ok(!selected.some(item => item.label === '28/9'));
  for (let i = 1; i < selected.length; i++) {
    const gap = selected[i].x - selected[i].width / 2 - (selected[i - 1].x + selected[i - 1].width / 2);
    assert.ok(gap >= 12, `label gap ${gap} must remain readable`);
  }
  assert.equal(JSON.stringify(candidates), before);
});
test('date label spacing handles long measured text, empty data and very narrow charts', () => {
  const { spacedAxisLabels } = require('../chart-motion.js');
  assert.deepEqual(spacedAxisLabels([]), []);
  const tight = [{ x: 40, width: 34, label: '31/12' }, { x: 60, width: 18, label: '1/1' }];
  assert.deepEqual(spacedAxisLabels(tight), [tight[1]]);
  const roomy = [{ x: 40, width: 34, label: '31/12' }, { x: 100, width: 18, label: '1/1' }, { x: 160, width: 30, label: '20/1' }];
  assert.deepEqual(spacedAxisLabels(roomy), roomy);
});
test('twelve monthly bar labels leave measured gaps on a 320px phone chart', () => {
  const { spacedAxisLabels } = require('../chart-motion.js');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const candidates = months.map((label, index) => ({ label, x: 40 + (index + .5) * 220 / 12, width: 21 }));
  const selected = spacedAxisLabels(candidates);
  assert.equal(selected[0].label, 'Jan'); assert.equal(selected.at(-1).label, 'Dec');
  assert.ok(selected.length >= 4 && selected.length < months.length);
  selected.slice(1).forEach((item, index) => {
    const previous = selected[index];
    assert.ok(item.x - item.width / 2 - previous.x - previous.width / 2 >= 12);
  });
});
