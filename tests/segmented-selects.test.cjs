const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {bindSelect} = require('../sliding-controls.js');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function harness() {
  const observers = [], nodes = new Map(), doc = {activeElement: null};
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.parentElement = null;
      this.hidden = false; this.disabled = false; this.textContent = ''; this.value = ''; this.options = [];
      this.events = new Map(); this.attrs = new Map(); const classes = new Set();
      this.classList = {contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value),
        toggle: (value, force) => { const next = force ?? !classes.has(value); next ? classes.add(value) : classes.delete(value); return next; }};
    }
    addEventListener(type, callback) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(callback); }
    removeEventListener(type, callback) { this.events.get(type)?.delete(callback); }
    dispatchEvent(event) { event.target ||= this; for (const callback of this.events.get(event.type) || []) callback(event); return true; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    insertBefore(child, before) { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, child); child.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    replaceChildren(...children) { this.children.forEach(child => {child.parentElement = null;}); this.children = []; children.forEach(child => this.insertBefore(child, null)); }
    focus(options) { doc.activeElement = this; this.focusOptions = options; }
    set innerHTML(value) {
      this.options = [...value.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(match => ({value: match[1], textContent: match[2]}));
      this.value = this.options[0]?.value || '';
    }
  }
  const env = {
    Event: class {constructor(type, options) {this.type = type; Object.assign(this, options);} preventDefault() {this.defaultPrevented = true;}},
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe(target) {this.target = target;} disconnect() {this.disconnected = true;}}
  };
  doc.createElement = tag => new Element(tag);
  const make = (id, values, hidden = false) => {
    const select = new Element('select'); select.id = id;
    select.options = values.map(([value, label]) => ({value, textContent: label})); select.value = values[0][0];
    if (hidden) select.classList.add('hidden');
    const track = new Element('div'), row = new Element('div'); row.classList.add('chart-segment-row'); row.replaceChildren(select, track);
    nodes.set(`#${id}`, select); return {select, track, row};
  };
  const period = make('breakdownPeriod', [['week', 'Week'], ['month', 'Month'], ['year', 'Year']]);
  const grouping = make('breakdownGranularity', [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']], true);
  const mode = make('breakdownMode', [['volume', 'Volume'], ['sets', 'Sets']]);
  let renders = 0;
  const context = vm.createContext({$: key => nodes.get(key), _breakdownOffset: -2, renderBreakdownChart: () => {renders++;}});
  const start = app.indexOf('$("#breakdownPeriod").addEventListener("change"');
  vm.runInContext(app.slice(start, app.indexOf('// Period navigation', start)), context);
  const controls = [period, grouping, mode].map(item => bindSelect(env, doc, item.select, item.track));
  const flush = () => observers.filter(observer => !observer.disconnected).forEach(observer => observer.callback([]));
  const choose = (item, value) => item.track.children.find(button => button.dataset.selectValue === value).dispatchEvent(new env.Event('click'));
  const key = (item, value, key, extras = {}) => {
    const event = new env.Event('keydown', {key, target: item.track.children.find(button => button.dataset.selectValue === value), ...extras});
    item.track.dispatchEvent(event); return event;
  };
  return {period, grouping, mode, controls, context, flush, choose, key, env, doc, observers, get renders() {return renders;}};
}

test('segmented period controls drive the actual chart handlers and preserve period-specific grouping options', () => {
  const h = harness();
  assert.equal(h.grouping.row.hidden, true); assert.equal(h.period.select.classList.contains('segmented-backing'), true);
  h.choose(h.period, 'month'); h.flush();
  assert.equal(h.period.select.value, 'month'); assert.equal(h.context._breakdownOffset, 0); assert.equal(h.renders, 1);
  assert.equal(h.grouping.row.hidden, false);
  assert.deepEqual(h.grouping.track.children.map(button => button.textContent), ['Daily', 'Weekly']);
  h.choose(h.grouping, 'weekly'); assert.equal(h.grouping.select.value, 'weekly'); assert.equal(h.renders, 2);
  const weekly = h.grouping.track.children[1];
  h.choose(h.period, 'year'); h.flush();
  assert.deepEqual(h.grouping.track.children.map(button => button.textContent), ['Weekly', 'Monthly']);
  assert.equal(h.grouping.track.children[0], weekly, 'unchanged options retain their button and focus identity');
  h.choose(h.grouping, 'monthly'); assert.equal(h.grouping.select.value, 'monthly');
  h.choose(h.period, 'week'); h.flush(); assert.equal(h.grouping.row.hidden, true); assert.equal(h.grouping.track.hidden, true);
});

test('rapid selections remain synchronous and each actual change fires once; duplicate activation does not redraw', () => {
  const h = harness();
  for (let index = 0; index < 31; index++) {
    const value = index % 2 ? 'volume' : 'sets'; h.choose(h.mode, value);
    assert.equal(h.mode.select.value, value);
    assert.equal(h.mode.track.children.find(button => button.getAttribute('aria-pressed') === 'true').dataset.selectValue, value);
  }
  assert.equal(h.renders, 31); h.choose(h.mode, 'sets'); assert.equal(h.renders, 31);
  h.mode.select.value = 'volume'; h.mode.select.dispatchEvent(new h.env.Event('change'));
  assert.equal(h.mode.track.children[0].getAttribute('aria-pressed'), 'true'); assert.equal(h.renders, 32);
});

test('keyboard arrows/Home/End skip disabled options without scrolling; disabled and hidden controls do not activate', () => {
  const h = harness(); h.period.select.options[1].disabled = true; h.flush();
  assert.equal(h.key(h.period, 'week', 'ArrowRight').defaultPrevented, true);
  assert.equal(h.period.select.value, 'year'); assert.equal(h.doc.activeElement.dataset.selectValue, 'year');
  assert.equal(h.doc.activeElement.focusOptions.preventScroll, true);
  h.key(h.period, 'year', 'Home'); assert.equal(h.period.select.value, 'week');
  h.key(h.period, 'week', 'End'); assert.equal(h.period.select.value, 'year');
  assert.equal(h.key(h.period, 'year', 'ArrowLeft', {ctrlKey: true}).defaultPrevented, undefined);
  const before = h.renders; h.choose(h.period, 'month'); assert.equal(h.renders, before);
  h.mode.select.disabled = true; h.flush(); h.choose(h.mode, 'sets'); assert.equal(h.mode.select.value, 'volume');
  h.choose(h.period, 'week'); h.flush(); const hiddenRenders = h.renders;
  h.choose(h.grouping, 'monthly'); assert.equal(h.renders, hiddenRenders);
});

test('dynamic labels/options follow the native select; teardown restores its fallback and removes listeners', () => {
  const h = harness(); h.mode.select.options[0].label = 'Training volume'; h.flush();
  assert.equal(h.mode.track.children[0].textContent, 'Training volume');
  const detached = h.mode.track.children[1]; h.mode.select.options = [h.mode.select.options[0]]; h.flush();
  assert.equal(h.mode.track.children.length, 1); const before = h.renders;
  detached.dispatchEvent(new h.env.Event('click')); assert.equal(h.renders, before);
  h.controls.forEach(control => control.dispose());
  assert.equal(h.mode.track.hidden, true); assert.equal(h.mode.track.children.length, 0);
  assert.equal(h.mode.select.classList.contains('segmented-backing'), false);
  assert.ok(h.observers.every(observer => observer.disconnected));
  h.mode.select.value = 'sets'; h.mode.select.dispatchEvent(new h.env.Event('change'));
  assert.equal(h.renders, before + 1, 'the app chart handler survives adapter disposal');
});


test('metric slider switches between the active load type’s visible options and ignores stale hidden choices', () => {
  const h = harness(), metric = h.mode;
  metric.select.options = [
    {value: 'weighted:volume', textContent: 'Added weight × reps'},
    {value: 'weighted:maxWeight', textContent: 'Max added weight'},
    {value: 'assisted:volume', textContent: 'Assistance × reps', hidden: true},
    {value: 'assisted:maxWeight', textContent: 'Highest assistance', hidden: true}
  ];
  metric.select.value = 'weighted:volume'; h.flush();
  assert.deepEqual(metric.track.children.map(button => button.textContent), ['Added weight × reps', 'Max added weight']);
  const oldButton = metric.track.children[1];
  h.choose(metric, 'weighted:maxWeight');
  assert.equal(metric.select.value, 'weighted:maxWeight');
  metric.select.options.forEach(option => {option.hidden = !option.value.startsWith('assisted:');});
  metric.select.value = 'assisted:maxWeight'; h.flush();
  assert.deepEqual(metric.track.children.map(button => button.textContent), ['Assistance × reps', 'Highest assistance']);
  assert.equal(metric.track.children[1].getAttribute('aria-pressed'), 'true');
  const before = h.renders; oldButton.dispatchEvent(new h.env.Event('click'));
  assert.equal(h.renders, before); assert.equal(metric.select.value, 'assisted:maxWeight');
  h.key(metric, 'assisted:maxWeight', 'Home');
  assert.equal(metric.select.value, 'assisted:volume');
  assert.equal(metric.track.children[0].getAttribute('aria-pressed'), 'true');
});
