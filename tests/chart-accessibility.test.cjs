const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = app.slice(app.indexOf('function updateChartDataTable('), app.indexOf('function drawBodyweightChart('));

test('accessible chart tables stay inside a clipped block wrapper and retain complete text data', () => {
  const nodes = [];
  function node(tagName) {
    const result = { tagName, children: [], className: '', textContent: '',
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      replaceChildren() { this.children = []; } };
    nodes.push(result); return result;
  }
  let sibling;
  const document = { createElement: node, getElementById: id => nodes.find(item => item.id === id) };
  const canvas = { id: 'progChart', parentElement: { insertAdjacentElement(position, inserted) { assert.equal(position, 'afterend'); sibling = inserted; } } };
  const context = { document }; vm.runInNewContext(source, context);
  const caption = 'A very long exercise name · Added weight × reps · 1 January 2026 – 31 December 2026';
  context.updateChartDataTable(canvas, caption, [['31 December 2026', '120000 kg × reps']]);
  assert.equal(sibling.tagName, 'div'); assert.equal(sibling.className, 'chart-sr-only');
  const table = sibling.children[0];
  assert.equal(table.tagName, 'table'); assert.equal(table.className, '');
  assert.equal(table.children[0].textContent, caption);
  assert.equal(table.children[1].children[0].scope, 'row');
  assert.equal(table.children[1].children[1].textContent, '120000 kg × reps');
  assert.equal(table.hidden, undefined); assert.equal(sibling.hidden, undefined);
  context.updateChartDataTable(canvas, 'Empty date range', []);
  assert.equal(nodes.filter(item => item.tagName === 'table').length, 1);
  assert.equal(table.children.length, 1); assert.equal(table.children[0].textContent, 'Empty date range');
});

test('bodyweight ticks keep measured spacing without moving points or drawing dates outside a panned viewport', () => {
  const Motion = require('../chart-motion.js');
  const drawSource = app.slice(app.indexOf('function drawBodyweightChart('), app.indexOf('// Calendar state'));
  const drawn = [], dots = [], clips = []; let points, clipped = false;
  const ctx = new Proxy({
    save() { clips.push(clipped); }, restore() { clipped = clips.pop(); }, clip() { clipped = true; },
    arc(x, y, radius) { dots.push({ x, y, radius, clipped, fill: this.fillStyle, stroke: this.strokeStyle }); },
    measureText: label => ({ width: label.length * 6 }),
    fillText(label, x, y) { if (y === 180 && label.includes('/')) drawn.push({ label, x, width: label.length * 6 }); }
  }, { get: (target, key) => target[key] || (() => {}) });
  const canvas = { width: 0, height: 0, getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 320, height: 200 }), setAttribute() {} };
  const db = { user: { useLbs: false }, bodyweight: Array.from({ length: 18 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, kg: 80 + index / 10 })) };
  const before = JSON.stringify(db);
  const context = { LiftLogTheme: require('./helpers/theme-runtime.cjs')(), DB: db, $: () => canvas, window: { devicePixelRatio: 2 }, document: { body: { classList: { contains: () => false } } },
    LiftLogChartMotion: Motion, _bwPeriod: 'all', _bwZoom: 1, _bwPanOffset: 0, _bwPointCount: 0, _bwPlotWidth: 1,
    _bwVisualAnimation: null, convertWeight: Number, getWeightUnit: () => 'kg', updateChartDataTable() {},
    updateChartInspection(_canvas, next) { points = next; } };
  vm.runInNewContext(drawSource, context); context.drawBodyweightChart();
  assert.equal(points.length, 18);
  assert.equal(points[0].x, 40); assert.equal(points.at(-1).x, 300);
  function assertDots() {
    assert.equal(dots.length, points.length);
    assert.ok(dots.every(dot => !dot.clipped && dot.radius === 4 && dot.fill === '#FF3333' && dot.stroke === '#FF3333'));
    assert.deepEqual(dots.map(dot => dot.x), Array.from(points, point => point.x));
  }
  assertDots();
  assert.equal(drawn.at(-1).label, '18/9');
  assert.ok(!drawn.some(item => item.label === '17/9'));
  function assertGaps() { drawn.slice(1).forEach((item, index) => {
    assert.ok(item.x - item.width / 2 - drawn[index].x - drawn[index].width / 2 >= 12);
  }); }
  assertGaps();
  drawn.length = 0; dots.length = 0; context._bwZoom = 3; context._bwPanOffset = 7.2; context.drawBodyweightChart();
  assert.equal(context._bwPanOffset, 7.2);
  assert.ok(drawn.length > 0 && drawn.every(item => item.x >= 40 && item.x <= 300));
  assert.ok(points.every(item => item.x >= 40 && item.x <= 300));
  assert.ok(!drawn.some(item => item.label === '18/9')); assertGaps();
  assertDots();
  // The same full red dots remain visible in dark mode, including both edges.
  drawn.length = 0; dots.length = 0; context._bwZoom = 1; context._bwPanOffset = 0;
  context.document.body.classList.contains = () => true; context.LiftLogTheme.apply('dark'); context.drawBodyweightChart();
  assertDots(); assert.equal(dots[0].x, 40); assert.equal(dots.at(-1).x, 300);
  assert.equal(JSON.stringify(db), before);
});

test('chart readouts preserve deliberate tap, keyboard and live output without interrupting bodyweight pan keys', () => {
  const inspectionSource = app.slice(app.indexOf('function updateChartInspection('), app.indexOf('function updateChartDataTable('));
  const listeners = {}, attributes = {};
  const output = { hidden: true, setAttribute(name, value) { attributes[name] = value; } };
  const canvas = { id: 'bwChart', parentElement: { appendChild() {} },
    addEventListener(name, handler) { listeners[name] = handler; }, getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  const sandbox = { document: { createElement: () => output }, _chartAnimator: { finish() {} }, LiftLogChartMotion: require('../chart-motion.js') };
  vm.runInNewContext(inspectionSource, sandbox);
  const points = [{ x: 40, y: 50, label: '1 Sep · 80 kg' }, { x: 100, y: 60, label: '2 Sep · 81 kg' }];
  sandbox.updateChartInspection(canvas, points);
  assert.equal(attributes['aria-live'], 'polite'); assert.equal(canvas.tabIndex, 0);
  listeners.pointerdown({ isPrimary: true, clientX: 50, clientY: 70 });
  listeners.click({ clientX: 50, clientY: 70 });
  assert.equal(output.hidden, false); assert.equal(output.textContent, points[0].label);
  let prevented = false;
  listeners.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, false); assert.equal(output.textContent, points[0].label);
  listeners.keydown({ key: 'ArrowRight', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(output.textContent, points[1].label);
  listeners.keydown({ key: 'Escape', preventDefault() {} }); assert.equal(output.hidden, true);
  listeners.pointerdown({ isPrimary: true, clientX: 50, clientY: 70 });
  listeners.pointermove({ clientX: 100, clientY: 70 }); listeners.click({ clientX: 110, clientY: 80 });
  assert.equal(output.hidden, true);
  listeners.keydown({ key: 'Enter', preventDefault() {} }); assert.equal(output.hidden, false);
  sandbox.updateChartInspection(canvas, []); assert.equal(output.hidden, true);
});
