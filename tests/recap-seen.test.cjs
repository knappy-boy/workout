const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Dates = require('../dates.js');
const { createSeenState } = require('../recaps.js');
const source = fs.readFileSync(require.resolve('../recaps.js'), 'utf8');
const seenKey = month => 'liftlog_recap_seen_v1:' + month;
const data = {
  exercises: { bench: { id: 'bench', name: 'Bench', type: 'strength', muscle: 'Chest' } }, templates: {},
  sessions: ['07', '08', '09'].map(number => ({ id: 'month-' + number, start: `2026-${number}-12T10:00:00Z`,
    end: `2026-${number}-12T11:00:00Z`, entries: { bench: [{ w: 60, r: 8 }] } }))
};

function localStore(values = new Map()) {
  const writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}

// Small DOM and clock doubles exercise the real recap event handlers without a browser.
function harness({ storage = localStore(), reduced = false, blockedGetter = false, imageDecode = null } = {}) {
  let now = 0, sequence = 0;
  const timers = new Map(), motionListeners = [];
  const document = { activeElement: null };
  class Node {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.parentElement = null; this.dataset = {}; this.attrs = {};
      this.className = ''; this.hidden = false; this.open = false; this.listeners = {}; this._text = '';
      this.scrollTop = 0; this.offsetTop = 0; this.isConnected = true;
      if (tag === 'img' && imageDecode) { this.complete = true; this.naturalWidth = 320; this.decode = imageDecode; }
      this.style = { setProperty() {}, removeProperty() {} };
      this.classList = { contains: name => this.className.split(/\s+/).includes(name),
        add: name => this.classList.toggle(name, true),
        toggle: (name, force) => {
          const items = new Set(this.className.split(/\s+/).filter(Boolean));
          const use = force === undefined ? !items.has(name) : force;
          if (use) items.add(name); else items.delete(name);
          this.className = [...items].join(' '); return use;
        } };
    }
    get childNodes() { return this.children; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node);
        node.parentElement = this; this.children.push(node);
      }
    }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const result = [];
      for (const node of this.children) {
        if (selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector) result.push(node);
        result.push(...node.querySelectorAll(selector));
      }
      return result;
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    addEventListener(type, action) { (this.listeners[type] ||= []).push(action); }
    emit(type, props = {}) { for (const action of this.listeners[type] || []) action({ target: this, ...props }); }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
  }
  document.createElement = tag => new Node(tag);
  document.body = new Node('body'); document.activeElement = new Node('button');
  const media = { matches: reduced, addEventListener(_event, action) { motionListeners.push(action); } };
  const sandbox = { document, LiftLogDates: Dates, matchMedia: () => media,
    setTimeout(action, delay) { const id = ++sequence; timers.set(id, { action, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  if (blockedGetter) Object.defineProperty(sandbox, 'localStorage', { get() { throw Error('Storage blocked'); } });
  else sandbox.localStorage = storage;
  vm.runInNewContext(source, sandbox);
  const api = sandbox.LiftLogRecaps;
  api.configure({ getDB: () => data, now: () => new Date('2026-10-12T12:00:00Z') });
  const query = selector => document.body.querySelector(selector);
  return { api, storage, timers, query, document,
    phase: () => query('.recap-panel')?.dataset.phase,
    advance(duration) {
      const target = now + duration;
      for (;;) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].action();
      }
      now = target;
    },
    chooseMonth(label) {
      const node = query('.recap-archive').querySelectorAll('.recap-archive-button').find(node => node.textContent.startsWith(label));
      assert.ok(node, `Archive must offer ${label}`); node.click();
    },
    reduceMotion() { media.matches = true; motionListeners.forEach(action => action()); }
  };
}

test('a completed reveal is remembered across reloads and seen months skip all entry animations', () => {
  const storage = localStore(), before = JSON.stringify(data), h = harness({ storage });
  h.api.open();
  assert.equal(h.phase(), 'cover'); assert.equal(storage.writes.length, 0);
  h.query('.recap-reveal').click();
  h.advance(900);
  assert.equal(h.phase(), 'revealing'); assert.equal(storage.writes.length, 0);
  h.advance(844); assert.equal(storage.writes.length, 0);
  h.advance(1); assert.equal(storage.writes.length, 0);
  h.query('.recap-spotlight').children.at(-1).emit('animationend', { animationName: 'recap-tile-unfurl' });
  assert.equal(h.phase(), 'revealed');
  assert.deepEqual(storage.writes, [[seenKey('2026-09'), '1']]);
  h.api.close();
  const reopened = harness({ storage }); reopened.api.open();
  assert.equal(reopened.phase(), 'revealed');
  assert.equal(reopened.query('.recap-cover').hidden, true);
  assert.equal(reopened.query('.recap-results').hidden, false);
  assert.equal(reopened.query('.recap-panel').classList.contains('recap-animate-tiles'), false);
  assert.equal(reopened.timers.size, 0);
  assert.equal(reopened.query('.recap-replay'), null);
  assert.equal(JSON.stringify(data), before, 'Recap preference writes cannot mutate workout data.');
});

test('closing during the cover or tile sequence does not mark a month seen', () => {
  for (const elapsed of [0, 400, 900, 1300, 1744, 1844]) {
    const h = harness(); h.api.open(); h.query('.recap-reveal').click(); h.advance(elapsed);
    const pending = [...h.timers.values()].map(timer => timer.action);
    h.api.close(); h.advance(5000); pending.forEach(action => action());
    assert.equal(h.storage.writes.length, 0, `Closed after ${elapsed}ms`);
    h.api.open(); assert.equal(h.phase(), 'cover');
  }
});

test('native dialog close cancels reveal completion and preserves the unseen month', () => {
  const h = harness(); h.api.open(); h.query('.recap-reveal').click(); h.advance(1100);
  h.query('dialog').close(); h.advance(5000);
  assert.equal(h.storage.writes.length, 0);
  h.api.open(); assert.equal(h.phase(), 'cover');
});

test('archives keep unseen months sealed and show seen months immediately without marking anything on navigation', () => {
  const storage = localStore(new Map([[seenKey('2026-09'), '1']]));
  const h = harness({ storage }); h.api.openArchive();
  assert.equal(h.phase(), 'archive'); assert.equal(storage.writes.length, 0);
  h.chooseMonth('August 2026'); assert.equal(h.phase(), 'cover');
  h.query('.recap-reveal').click(); h.advance(1845);
  assert.equal(storage.values.get(seenKey('2026-08')), '1');
  h.api.openArchive(); h.chooseMonth('September 2026');
  assert.equal(h.phase(), 'revealed'); assert.equal(h.timers.size, 0);
  h.api.openArchive(); h.chooseMonth('July 2026'); assert.equal(h.phase(), 'cover');
  h.query('.recap-archive-link').click(); assert.equal(h.phase(), 'archive');
  h.chooseMonth('August 2026'); assert.equal(h.phase(), 'revealed');
  assert.deepEqual(storage.writes, [[seenKey('2026-08'), '1']]);
});

test('switching month before the previous reveal finishes cannot mark either month seen', () => {
  const h = harness(); h.api.open(); h.query('.recap-reveal').click(); h.advance(1100);
  h.api.openArchive(); h.chooseMonth('August 2026'); h.advance(5000);
  assert.equal(h.phase(), 'cover'); assert.equal(h.storage.writes.length, 0);
});

test('reduced motion shows and remembers the completed result immediately', () => {
  const h = harness({ reduced: true }); h.api.open(); h.query('.recap-reveal').click();
  assert.equal(h.phase(), 'revealed'); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.storage.writes, [[seenKey('2026-09'), '1']]);
  const changed = harness(); changed.api.open(); changed.query('.recap-reveal').click(); changed.advance(1100);
  changed.reduceMotion();
  assert.equal(changed.phase(), 'revealed'); assert.equal(changed.timers.size, 0);
  assert.deepEqual(changed.storage.writes, [[seenKey('2026-09'), '1']]);
});

test('invalid stored flags remain unseen and invalid month keys never reach storage', () => {
  for (const invalid of ['true', 'false', '0', 'null', '{bad json', '{"seen":true}', '2026-09', '', 1, true]) {
    const h = harness({ storage: localStore(new Map([[seenKey('2026-09'), invalid]])) });
    h.api.open(); assert.equal(h.phase(), 'cover', `Invalid flag ${String(invalid)}`);
    assert.equal(h.storage.writes.length, 0);
  }
  let access = 0;
  const seen = createSeenState(() => { access++; return localStore(); });
  for (const key of ['2026-13', '2026-00', '2026-9', '0000-01', '../2026-09', '__proto__', null]) {
    assert.equal(seen.has(key), false); assert.equal(seen.mark(key), false);
  }
  assert.equal(access, 0);
});

test('unavailable storage and failed writes fall back to memory without touching workout keys', () => {
  for (const options of [
    { blockedGetter: true },
    { storage: { getItem() { throw Error('Blocked reads'); }, setItem() { throw Error('Quota'); } } },
    { storage: null }
  ]) {
    const h = harness(options); h.api.open(); h.query('.recap-reveal').click(); h.advance(1845); h.api.close();
    h.api.open(); assert.equal(h.phase(), 'revealed');
  }
  const values = new Map([['liftlog_ultra_v1', '{"workouts":"untouched"}']]), storage = localStore(values);
  const a = createSeenState(() => storage), b = createSeenState(() => storage);
  a.mark('2026-09'); b.mark('2026-08');
  assert.equal(a.has('2026-08'), true); assert.equal(b.has('2026-09'), true);
  assert.equal(values.get('liftlog_ultra_v1'), '{"workouts":"untouched"}');
  assert.deepEqual(storage.writes.map(([key]) => key), [seenKey('2026-09'), seenKey('2026-08')]);
});

test('Month in review is at the bottom of Stats with archive access and absent from Home', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const home = html.slice(html.indexOf('<section id="tab-dashboard"'), html.indexOf('<section id="tab-workout"'));
  const stats = html.slice(html.indexOf('<section id="tab-stats"'), html.indexOf('<section id="tab-settings"'));
  assert.doesNotMatch(home, /btnLatestRecap|recap-home-link|MONTH IN REVIEW/);
  assert.match(stats, /MONTH IN REVIEW/); assert.match(stats, /id="btnRecapArchive"/);
  assert.ok(stats.indexOf('recap-stats-entry') > stats.indexOf('id="breakdownCardio"'));
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const start = app.indexOf('function updateRecapLinks()');
  const nodes = { '#btnLatestRecap': {}, '#recapMonthLabel': {}, '#btnRecapArchive': {} };
  let months = [];
  const context = vm.createContext({ DB: {}, $: key => nodes[key], LiftLogRecaps: { availableMonths: () => months, displayMonth: key => key } });
  vm.runInContext(app.slice(start, app.indexOf('\nasync function editCompletedWorkout(', start)), context);
  context.updateRecapLinks();
  assert.equal(nodes['#btnLatestRecap'].disabled, true); assert.equal(nodes['#btnRecapArchive'].hidden, true);
  months = ['2026-04']; context.updateRecapLinks();
  assert.equal(nodes['#btnLatestRecap'].disabled, false); assert.equal(nodes['#btnRecapArchive'].hidden, false);
  assert.equal(nodes['#recapMonthLabel'].textContent, '2026-04');
});

test('image decode completes before reveal starts or reduced motion can mark the recap seen', async () => {
  let ready;
  const loading = new Promise(resolve => { ready = resolve; });
  const h = harness({ reduced: true, imageDecode: () => loading });
  h.api.open(); h.query('.recap-reveal').click();
  assert.equal(h.phase(), 'preparing'); assert.equal(h.storage.writes.length, 0);
  h.advance(1000); assert.equal(h.storage.writes.length, 0);
  ready(); await new Promise(setImmediate);
  assert.equal(h.phase(), 'revealed'); assert.equal(h.storage.writes.length, 1);
});

test('closing while images prepare leaves the month unseen and stale decode callbacks inert', async () => {
  let ready;
  const loading = new Promise(resolve => { ready = resolve; });
  const h = harness({ imageDecode: () => loading });
  h.api.open(); h.query('.recap-reveal').click(); h.api.close();
  ready(); await new Promise(setImmediate); h.advance(5000);
  assert.equal(h.storage.writes.length, 0); assert.equal(h.timers.size, 0);
});

test('failed or stalled image decoding falls back to text without hanging or skipping reveal completion', async () => {
  for (const imageDecode of [() => Promise.reject(Error('Missing art')), () => new Promise(() => {})]) {
    const h = harness({ imageDecode });
    h.api.open(); h.query('.recap-reveal').click();
    h.advance(1800); await new Promise(setImmediate);
    assert.equal(h.phase(), 'opening'); assert.equal(h.storage.writes.length, 0);
    assert.ok(h.query('.recap-cover-art').hidden);
    h.advance(1845);
    assert.equal(h.phase(), 'revealed'); assert.equal(h.storage.writes.length, 1);
  }
});
