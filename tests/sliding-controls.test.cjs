const test = require('node:test');
const assert = require('node:assert/strict');
const {markerBounds, createGroup, bind} = require('../sliding-controls.js');

test('marker uses the actual border box and stays inset inside either unequal Library choice', () => {
  const metrics = {container: {left: 20, top: 40, width: 360, height: 62}, clientLeft: 2, clientTop: 2, clientWidth: 356, clientHeight: 58, scrollWidth: 356, scrollHeight: 58};
  const left = markerBounds({...metrics, button: {left: 28, top: 48, width: 138, height: 46}});
  const right = markerBounds({...metrics, button: {left: 174, top: 48, width: 198, height: 46}});
  assert.deepEqual(left, {x: 6, y: 6, width: 138, height: 46});
  assert.deepEqual(right, {x: 152, y: 6, width: 198, height: 46});
  assert.equal(right.x + right.width, metrics.clientWidth - 6);
  assert.equal(right.y + right.height, metrics.clientHeight - 6);
});

test('horizontal scrolling does not alter marker content coordinates; hidden or invalid geometry is not painted', () => {
  const base = {container: {left: 10, top: 20, width: 200, height: 50}, button: {left: 252, top: 25, width: 115, height: 40}, clientLeft: 2, clientTop: 0, clientWidth: 196, clientHeight: 50, scrollWidth: 560, scrollHeight: 50};
  const before = markerBounds(base);
  const scrolled = markerBounds({...base, scrollLeft: 180, button: {...base.button, left: 72}});
  assert.deepEqual(scrolled, before);
  assert.equal(markerBounds({...base, container: {...base.container, width: 0}}), null);
  assert.equal(markerBounds({...base, button: {...base.button, left: NaN}}), null);
  const clipped = markerBounds({...base, button: {...base.button, left: 900, width: 900}});
  assert.equal(clipped.x, 0); assert.equal(clipped.width, 560);
});

function harness() {
  let nextFrame = 1;
  const frames = new Map(), mutations = [], resizes = [], windowEvents = new Map();
  const env = {
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle: node => ({borderRadius: node.radius || '99px'}),
    addEventListener: (type, callback) => windowEvents.set(type, callback),
    removeEventListener: type => windowEvents.delete(type),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; mutations.push(this); this.targets = []; }
      observe(target, options) { this.targets.push({target, options}); }
      disconnect() { this.disconnected = true; }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; resizes.push(this); this.targets = new Set(); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.disconnected = true; this.targets.clear(); }
    }
  };
  function node(tag, rect, selected = false) {
    const classes = new Set(selected ? ['active'] : []), properties = new Map(), events = new Map(), attrs = new Map();
    return {
      tagName: tag.toUpperCase(), rect, dataset: {}, children: [], isConnected: true,
      style: {getPropertyValue: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key)},
      classList: {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)},
      getAttribute: key => attrs.get(key) || null, setAttribute: (key, value) => attrs.set(key, value),
      getBoundingClientRect() { return this.rect; },
      addEventListener: (name, callback, options) => events.set(name, {callback, options}), removeEventListener: name => events.delete(name),
      focus() { assert.fail('Decorative markers must never move focus.'); }, click() { assert.fail('Decorative markers must never trigger a selection.'); },
      events, properties
    };
  }
  const group = node('div', {left: 10, top: 20, width: 320, height: 60});
  Object.assign(group, {clientLeft: 2, clientTop: 2, clientWidth: 316, clientHeight: 56, scrollWidth: 316, scrollHeight: 56, scrollLeft: 0, scrollTop: 0});
  const first = node('button', {left: 18, top: 28, width: 120, height: 44}, true);
  const last = node('button', {left: 146, top: 28, width: 176, height: 44});
  group.children.push(first, last);
  const tick = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  const select = target => { group.children.forEach(button => button.classList.remove('active')); target.classList.add('active'); mutations[0].callback([{type: 'attributes', target, attributeName: 'class'}]); };
  return {env, frames, mutations, resizes, windowEvents, node, group, first, last, tick, select};
}

test('rapid reversals coalesce to the latest selected button, with no input interception or focus changes', () => {
  const h = harness(), control = createGroup(h.env, h.group);
  h.tick(); h.tick();
  assert.equal(h.group.dataset.slideAnimate, 'true');
  for (let i = 0; i < 101; i++) h.select(i % 2 ? h.first : h.last);
  assert.equal(h.frames.size, 1);
  h.tick();
  assert.equal(h.group.style.getPropertyValue('--slide-x'), '134px');
  assert.equal(h.group.style.getPropertyValue('--slide-width'), '176px');
  assert.equal(h.group.dataset.slideAnimate, 'true');
  assert.deepEqual([...h.group.events.keys()], ['scroll']);
  assert.equal(h.group.events.get('scroll').options.passive, true);
  control.dispose();
});

test('replacing dynamic segmented choices keeps marker motion; initial ResizeObserver notifications do not cancel it', () => {
  const h = harness(), control = createGroup(h.env, h.group); h.tick(); h.tick();
  const replacement = h.node('button', {left: 146, top: 28, width: 176, height: 44}, true);
  replacement.style.setProperty('--filter-color', '#E57373');
  h.group.children = [h.node('button', h.first.rect), replacement];
  h.mutations[0].callback([{type: 'childList', target: h.group}]); h.tick();
  assert.equal(h.group.dataset.slideAnimate, 'true');
  assert.equal(h.group.style.getPropertyValue('--slide-fill'), '#E57373');
  assert.equal(h.group.style.getPropertyValue('--slide-ink'), '#111');
  assert.equal(h.resizes[0].targets.has(h.last), false);
  h.resizes[0].callback(h.group.children.map(target => ({target})));
  assert.equal(h.frames.size, 0, 'the initial observer notification must not snap a valid transition');
  control.dispose();
});

test('native scrolling keeps content coordinates and does not interrupt a selection transition', () => {
  const h = harness(); h.group.scrollWidth = 600;
  const control = createGroup(h.env, h.group); h.tick(); h.tick();
  h.select(h.last); h.tick();
  h.group.scrollLeft = 80;
  h.group.children.forEach(button => { button.rect.left -= 80; });
  h.group.events.get('scroll').callback(); h.tick();
  assert.equal(h.group.style.getPropertyValue('--slide-x'), '134px');
  assert.equal(h.group.dataset.slideAnimate, 'true');
  assert.equal(h.frames.size, 0, 'scrolling cannot disarm or re-arm a valid transition');
  control.dispose();
});

test('ancestor state changes preserve motion when layout is unchanged, but a real layout move snaps', () => {
  const h = harness();
  const body = {contains: node => node === h.group};
  const doc = {body, querySelectorAll: selector => selector === '[data-segment-for]' ? [] : [h.group]};
  const manager = bind(h.env, doc); h.tick(); h.tick();
  const rootObserver = h.mutations.find(observer => observer.targets.some(item => item.target === body));
  const groupObserver = h.mutations.find(observer => observer.targets.some(item => item.target === h.group));
  h.first.classList.remove('active'); h.last.classList.add('active');
  groupObserver.callback([{type: 'attributes', target: h.last, attributeName: 'class'}]);
  rootObserver.callback([{type: 'attributes', target: body, attributeName: 'class'}]); h.tick();
  assert.equal(h.group.dataset.slideAnimate, 'true');
  assert.equal(h.frames.size, 0, 'a theme/parent state update must not interrupt the slide');
  h.last.rect.left -= 14;
  rootObserver.callback([{type: 'attributes', target: body, attributeName: 'class'}]); h.tick();
  assert.equal(h.group.style.getPropertyValue('--slide-x'), '120px');
  assert.equal(h.group.dataset.slideAnimate, 'false', 'changed geometry still needs a safe snap');
  h.tick(); assert.equal(h.group.dataset.slideAnimate, 'true');
  manager.dispose();
});

test('actual resize snaps safely within the new bounds, then later selections animate again', () => {
  const h = harness(), control = createGroup(h.env, h.group); h.tick(); h.tick(); h.select(h.last); h.tick();
  h.group.rect.width = 260; h.group.clientWidth = h.group.scrollWidth = 256;
  h.last.rect.left = 120; h.last.rect.width = 142;
  h.resizes[0].callback([{target: h.group}, {target: h.last}]); h.tick();
  assert.equal(h.group.dataset.slideAnimate, 'false');
  assert.equal(Number.parseFloat(h.group.style.getPropertyValue('--slide-x')) + Number.parseFloat(h.group.style.getPropertyValue('--slide-width')), 250);
  h.tick(); assert.equal(h.group.dataset.slideAnimate, 'true');
  h.select(h.first); h.tick(); assert.equal(h.group.style.getPropertyValue('--slide-x'), '6px');
  control.dispose();
});

test('hidden-to-visible groups start at the selected button and teardown removes all work', () => {
  const h = harness(), control = createGroup(h.env, h.group);
  h.group.rect.width = 0; h.tick(); assert.equal(h.group.dataset.slideReady, 'false');
  h.last.classList.add('active'); h.first.classList.remove('active'); h.group.rect.width = 320;
  control.refresh(true); h.tick(); assert.equal(h.group.dataset.slideReady, 'true'); assert.equal(h.group.dataset.slideAnimate, 'false');
  assert.equal(h.group.style.getPropertyValue('--slide-x'), '134px');
  h.mutations[0].callback([{type: 'attributes', target: h.group, attributeName: 'style'}]);
  assert.equal(h.frames.size, 1, 'own CSS variable writes cannot schedule another paint');
  control.dispose(); control.dispose();
  assert.equal(h.frames.size, 0); assert.equal(h.group.events.size, 0); assert.equal(h.group.properties.size, 0);
  assert.equal(h.group.classList.contains('sliding-control'), false); assert.equal(h.group.dataset.slideReady, undefined);
  assert.equal(h.resizes[0].disconnected, true); assert.equal(h.mutations[0].disconnected, true);
  control.refresh(); assert.equal(h.frames.size, 0);
});

test('manager discovers replacement controls and disposes disconnected groups and global listeners', () => {
  const h = harness(); let groups = [h.group];
  const body = {contains: () => true}, doc = {body, querySelectorAll: () => groups};
  const manager = bind(h.env, doc); h.tick(); h.tick();
  const rootObserver = h.mutations.find(observer => observer.targets.some(item => item.target === body));
  const fresh = h.node('div', h.group.rect); Object.assign(fresh, {clientWidth: 320, clientHeight: 60, scrollWidth: 320, scrollHeight: 60, children: [h.node('button', h.first.rect, true)], nodeType: 1, matches: () => true});
  h.group.isConnected = false; groups = [fresh];
  rootObserver.callback([{type: 'childList', addedNodes: [fresh], removedNodes: [], target: body}]); h.tick();
  assert.equal(h.group.classList.contains('sliding-control'), false); assert.equal(fresh.classList.contains('sliding-control'), true);
  manager.dispose(); assert.equal(h.windowEvents.size, 0); assert.equal(h.frames.size, 0);
  assert.equal(rootObserver.disconnected, true); assert.equal(fresh.classList.contains('sliding-control'), false);
});
