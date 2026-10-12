const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Dates = require('../dates.js');
const Loads = require('../exercise-load.js');
const source = fs.readFileSync(require.resolve('../recaps.js'), 'utf8');
const muscles = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quads',
  'hamstrings', 'glutes', 'calves', 'core', 'cardio', 'other'];

function harness({ theme = 'light', warm = false, decode = () => Promise.resolve() } = {}) {
  let mode = theme, clock = 0, nextTimer = 0;
  const timers = new Map(), idle = [], warmed = [], writes = [], values = new Map();
  const db = { user: { theme: 'dark' }, draft: { notes: 'Untouched unfinished workout' }, templates: {},
    exercises: { bench: { id: 'bench', name: 'Bench', type: 'strength', muscle: 'Chest' } },
    sessions: ['08', '09'].map((month, index) => ({ id: month, start: `2026-${month}-12T10:00:00Z`,
      end: `2026-${month}-12T11:00:00Z`, entries: { bench: [{ w: 60 + index * 5, r: 8 }] } })) };
  const document = { activeElement: null };
  class Node {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {};
      this.className = ''; this.hidden = false; this.open = false; this.scrollTop = 0; this._text = '';
      this.style = { setProperty() {}, removeProperty() {} };
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          const add = force === undefined ? !set.has(name) : force;
          if (add) set.add(name); else set.delete(name);
          this.className = [...set].join(' '); return add;
        },
        add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false)
      };
      if (tag === 'img') { this.complete = true; this.naturalWidth = 320; this.decode = () => decode(this.src); }
    }
    get src() { return this.attrs.src; }
    set src(value) { this.attrs.src = value; }
    get childNodes() { return this.children; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) {
      nodes.forEach(node => {
        if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node);
        node.parentElement = this; this.children.push(node);
      });
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return this.children.flatMap(node => [
        ...(selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector) ? [node] : [],
        ...node.querySelectorAll(selector)
      ]);
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(name, action) { (this.listeners[name] ||= []).push(action); }
    emit(name) { (this.listeners[name] || []).forEach(action => action({ target: this })); }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
  }
  document.createElement = tag => new Node(tag); document.body = new Node('body');
  const context = {
    document, LiftLogDates: Dates, LiftLogExerciseLoad: Loads, LiftLogTheme: { getTheme: () => mode },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem(key, value) { writes.push([key, value]); values.set(key, value); } },
    setTimeout(action, delay) { const id = ++nextTimer; timers.set(id, { action, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  if (warm) {
    context.Image = class extends Node { constructor() { super('img'); }
      get src() { return this.attrs.src; } set src(value) { this.attrs.src = value; warmed.push(value); } };
    context.requestIdleCallback = action => idle.push(action);
  }
  vm.runInNewContext(source, context);
  const api = context.LiftLogRecaps;
  api.configure({ getDB: () => db, now: () => new Date('2026-10-12T12:00:00Z') });
  return { api, db, writes, timers, warmed, document,
    query: selector => document.body.querySelector(selector),
    images: () => document.body.querySelectorAll('img'),
    theme(next) { mode = next; api.refreshArtwork(); },
    flushIdle() { while (idle.length) idle.shift()(); },
    advance(duration) {
      const end = clock + duration;
      for (;;) {
        const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); next[1].action();
      }
      clock = end;
    }
  };
}

test('only Purple selects female workout and muscle illustrations; neutral art keeps its existing source', () => {
  const h = harness();
  for (const theme of ['light', 'dark', 'purple', 'unrecognised']) {
    h.theme(theme);
    for (const name of ['workouts', ...muscles.map(muscle => `muscle-${muscle}`)]) {
      assert.equal(h.api.assetSource(name), `assets/recap/${theme === 'purple' ? 'female/' : ''}${name}.webp`);
    }
    for (const name of ['time', 'weeks', 'trophy', 'cover']) {
      assert.equal(h.api.assetSource(name), `assets/recap/${name}.webp`);
    }
  }
  h.api.configure({ assetBase: './art', getTheme: () => { throw Error('Unavailable'); } });
  assert.equal(h.api.assetSource('workouts'), './art/workouts.webp');
});

test('artwork refresh is safe before configuration, before a dialog opens, and without a document or theme helper', () => {
  const context = { LiftLogDates: Dates, LiftLogExerciseLoad: Loads, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  assert.doesNotThrow(() => context.LiftLogRecaps.refreshArtwork());
  assert.equal(context.LiftLogRecaps.assetSource('workouts'), 'assets/recap/workouts.webp');
  const h = harness();
  assert.doesNotThrow(() => h.theme('purple'));
  assert.equal(h.document.body.children.length, 0, 'An appearance change must not create or open a recap.');
  assert.equal(h.writes.length, 0);
});

test('switching theme changes only artwork in the open recap and preserves the chosen highlight, phase and data', async () => {
  const h = harness(), before = JSON.stringify(h.db);
  h.api.open(); h.query('.recap-reveal').click(); await new Promise(setImmediate); h.advance(1845);
  assert.equal(h.query('.recap-panel').dataset.phase, 'revealed');
  h.query('.recap-highlight-controls').querySelectorAll('button')[1].click();
  const panel = h.query('.recap-panel'), selected = h.query('.is-current'), scroll = 87;
  h.query('.recap-modal-scroll').scrollTop = scroll;
  const writes = JSON.stringify(h.writes);
  for (const theme of ['purple', 'dark', 'purple', 'light']) {
    h.theme(theme);
    assert.equal(h.query('.recap-panel'), panel);
    assert.equal(h.query('.is-current'), selected);
    assert.equal(panel.dataset.phase, 'revealed');
    assert.equal(h.query('.recap-modal-scroll').scrollTop, scroll);
    assert.equal(JSON.stringify(h.writes), writes, 'Theme changes cannot rewrite reveal preferences.');
    assert.equal(JSON.stringify(h.db), before, 'Appearance cannot mutate workout data or drafts.');
    for (const image of h.images()) {
      const name = image.dataset.recapAsset;
      assert.equal(image.src, `assets/recap/${theme === 'purple' && (name === 'workouts' || name.startsWith('muscle-')) ? 'female/' : ''}${name}.webp`);
    }
  }
});

test('warmup waits for idle, uses the current theme and reuses previously warmed neutral and character artwork', () => {
  const h = harness({ warm: true });
  assert.equal(h.warmed.length, 0);
  h.theme('purple'); h.flushIdle();
  assert.equal(h.warmed.length, 17);
  assert.equal(h.warmed.filter(url => url.includes('/female/')).length, 14);
  h.theme('dark'); h.flushIdle();
  assert.equal(h.warmed.length, 31, 'Only the 14 alternate character assets need another warmup.');
  for (let index = 0; index < 12; index++) { h.theme(index % 2 ? 'purple' : 'light'); h.flushIdle(); }
  assert.equal(h.warmed.length, 31, 'Repeated theme changes must not repeatedly decode every asset.');
  assert.equal(new Set(h.warmed).size, 31);
  assert.equal(h.writes.length, 0);
});

test('theme changes during image preparation wait for the replacement art without restarting or marking the reveal early', async () => {
  let oldReady, newReady;
  const oldArt = new Promise(resolve => { oldReady = resolve; });
  const newArt = new Promise(resolve => { newReady = resolve; });
  const h = harness({ decode: url => url.includes('/female/') ? newArt : oldArt });
  h.api.open(); h.query('.recap-reveal').click();
  assert.equal(h.query('.recap-panel').dataset.phase, 'preparing');
  h.theme('purple'); oldReady(); await new Promise(setImmediate);
  assert.equal(h.query('.recap-panel').dataset.phase, 'preparing');
  assert.equal(h.writes.length, 0);
  newReady(); await new Promise(setImmediate);
  assert.equal(h.query('.recap-panel').dataset.phase, 'opening');
  h.advance(1845); assert.equal(h.query('.recap-panel').dataset.phase, 'revealed');
  assert.equal(h.writes.length, 1);
});

test('a stale decoder failure cannot hide replacement artwork', async () => {
  let reject;
  const original = new Promise((_resolve, fail) => { reject = fail; });
  const h = harness({ decode: url => url.includes('/female/') ? Promise.resolve() : original });
  h.api.open(); h.theme('purple');
  reject(Error('Original request aborted')); await new Promise(setImmediate);
  for (const image of h.images().filter(image => image.src.includes('/female/'))) assert.equal(image.hidden, false);
});

test('all Purple character assets are included in the offline shell and the live theme path refreshes an open recap', () => {
  const worker = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
  const manifest = JSON.parse(worker.match(/LIFTLOG_ASSET_MANIFEST_START \*\/\s*(\[[\s\S]*?\])/)[1]);
  const assets = manifest.filter(path => path.includes('/recap/female/'));
  assert.equal(assets.length, 14);
  assert.deepEqual(new Set(assets), new Set(['workouts', ...muscles.map(muscle => `muscle-${muscle}`)]
    .map(name => `./assets/recap/female/${name}.webp`)));
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const themePath = app.slice(app.indexOf('function setAppTheme('), app.indexOf('$("#btnTheme").addEventListener'));
  assert.match(themePath, /LiftLogTheme\.apply\(mode\);\s*LiftLogRecaps\.refreshArtwork\(\);/);
});
