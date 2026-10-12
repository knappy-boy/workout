const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(new URL('../sw.js', 'file://' + __filename), 'utf8');
const scope = 'https://example.test/workout/';
const manifest = source.match(/\/\* LIFTLOG_ASSET_MANIFEST_START \*\/\s*(\[[\s\S]*?\])\s*\/\* LIFTLOG_ASSET_MANIFEST_END \*\//);
assert.ok(manifest, 'The worker must publish its release manifest.');
const assets = JSON.parse(manifest[1]);
const rootURL = new URL('../', 'file://' + __filename);
const bodies = Object.fromEntries(assets.map(path => [path, fs.readFileSync(new URL(path, rootURL))]));
const mime = path => path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/svg+xml';
async function digest(bytes) { return Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex'); }
async function releaseFor(values = bodies) { return digest(Buffer.from((await Promise.all(assets.map(async path => path + ':' + await digest(Buffer.from(values[path]))))).join('\n'))); }
async function harness(overrides = {}) {
  const release = overrides.release === undefined ? await releaseFor() : overrides.release;
  const handlers = {};
  const buckets = new Map();
  const requests = [];
  const state = {claimed: 0, skipped: 0};
  const cacheAPI = {
    async keys() { if (state.failKeys) throw Error("cache listing failed"); return Array.from(buckets.keys()); },
    async delete(key) { if (overrides.failDelete) throw Error("cache deletion failed"); if (overrides.hungDelete) return new Promise(() => {}); return buckets.delete(key); },
    async open(key) {
      if (!buckets.has(key)) buckets.set(key, new Map());
      const entries = buckets.get(key);
      return {
        async put(key, value) {
          if (overrides.failPut) throw Error('quota');
          // CacheStorage serializes bytes; it does not retain a live Response stream.
          entries.set(String(key), {body: await value.arrayBuffer(), status: value.status, headers: value.headers});
        },
        async match(key) {
          if (state.hungMatch) return new Promise(() => {});
          let value = entries.get(String(key));
          if (!value) return undefined;
          if (value instanceof Response) {
            value = {body: await value.arrayBuffer(), status: value.status, headers: value.headers}; entries.set(String(key), value);
          }
          return new Response(value.body, {status: value.status, headers: value.headers});
        }
      };
    }
  };
  let clients = overrides.clients || [];
  const self = {
    location: {href: scope + 'sw.js' + (release ? '?release=' + release : '')}, registration: {scope},
    clients: {async matchAll() { return clients; }, async claim() { state.claimed++; }},
    async skipWaiting() { state.skipped++; },
    addEventListener(type, handler) { handlers[type] = handler; }
  };
  const fetch = async (url, options) => {
    requests.push({url: String(url.url || url), options});
    const path = './' + new URL(url.url || url).pathname.slice(new URL(scope).pathname.length);
    if (overrides.network) return overrides.network(path, url, options);
    return new Response(bodies[path] || 'not found', {status: bodies[path] ? 200 : 404, headers: {'content-type': mime(path)}});
  };
  vm.runInNewContext(source, {self, caches: cacheAPI, fetch, URL, Response, AbortController, TextEncoder, Uint8Array, crypto: webcrypto, setTimeout: (fn, delay) => setTimeout(fn, overrides.quickApprovalTimeout && delay === 6000 || overrides.fastRecoveryTimeouts && [2000, 8000].includes(delay) ? 5 : delay), clearTimeout, Date, Math, Map, Set, console});
  const lifetime = async (type, props = {}) => {
    let pending;
    handlers[type]({...props, waitUntil(value) { pending = value; }});
    await pending;
  };
  const request = async (path, extra = {}) => {
    let pending;
    handlers.fetch({request: {url: new URL(path, scope).href, method: 'GET', mode: 'cors', ...extra}, respondWith(value) { pending = value; }});
    return pending ? await pending : undefined;
  };
  return {handlers, lifetime, request, buckets, requests, state, release, setClients(value) { clients = value; }};
}

test('installs the complete validated release without skipping a waiting workout', async () => {
  const h = await harness();
  await h.lifetime('install');
  assert.equal(h.buckets.get('liftlog-shell-' + h.release).size, assets.length);
  assert.equal(h.state.skipped, 0);
  assert.ok(h.requests.every(({url, options}) => url.includes('__liftlog_update=') && options.cache === 'no-store'));
});
test('rejects unversioned registrations left by the legacy app', async () => {
  const h = await harness({release: null});
  await assert.rejects(h.lifetime('install'), /manifest/);
  assert.equal(h.buckets.size, 0);
});
test('a server error cannot poison the current cached app', async () => {
  const h = await harness({network: path => new Response('server error', {status: 500, headers: {'content-type': mime(path)}})});
  h.buckets.set('liftlog-shell-previous', new Map([['saved', new Response('old app')]]));
  await assert.rejects(h.lifetime('install'), /http/);
  assert.equal(await h.buckets.get('liftlog-shell-previous').get('saved').text(), 'old app');
  assert.equal(h.buckets.size, 1);
});
test('HTML fallback for a missing JavaScript asset rejects the release', async () => {
  const h = await harness({network: path => new Response(bodies[path], {headers: {'content-type': path === './app.js' ? 'text/html' : mime(path)}})});
  await assert.rejects(h.lifetime('install'), /mime/);
  assert.equal(h.buckets.size, 0);
});
test('a file changing during deployment rejects a mixed-version install', async () => {
  const h = await harness({network: path => new Response(path === './style.css' ? 'changed after probe' : bodies[path], {headers: {'content-type': mime(path)}})});
  await assert.rejects(h.lifetime('install'), /hash/);
  assert.equal(h.buckets.size, 0);
});
test('changed binary recap bytes reject a mixed-version install even with a valid WebP MIME type', async () => {
  const imagePath = './assets/recap/workouts.webp';
  const changed = Buffer.from(bodies[imagePath]);
  changed[changed.length - 1] ^= 1;
  const h = await harness({network: path => new Response(path === imagePath ? changed : bodies[path], {headers: {'content-type': mime(path)}})});
  await assert.rejects(h.lifetime('install'), /hash/);
  assert.equal(h.buckets.size, 0);
});
test('failed cache writes remove only the incomplete candidate', async () => {
  const h = await harness({failPut: true});
  h.buckets.set('liftlog-shell-previous', new Map());
  await assert.rejects(h.lifetime('install'), /storage/);
  assert.deepEqual(Array.from(h.buckets.keys()), ['liftlog-shell-previous']);
});
test('navigation and assets use one immutable cached release while offline', async () => {
  const h = await harness();
  await h.lifetime('install');
  const count = h.requests.length;
  assert.equal(await (await h.request('./?page=workout', {mode: 'navigate'})).text(), bodies['./index.html'].toString('utf8'));
  assert.equal(await (await h.request('./app.js?legacy=1')).text(), bodies['./app.js'].toString('utf8'));
  for (const path of assets.filter(path => path.endsWith('.webp'))) {
    const response = await h.request(path);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bodies[path]);
  }
  assert.equal(h.requests.length, count);
  assert.equal(await h.request('https://elsewhere.test/app.js'), undefined);
  assert.equal(await h.request('./api.json'), undefined);
  assert.equal(await h.request('./app.js', {method: 'POST'}), undefined);
});
test('update probes always reach the network and never substitute cached HTML', async () => {
  const h = await harness();
  await h.lifetime('install');
  const count = h.requests.length;
  const response = await h.request('./missing.js?__liftlog_update=123');
  assert.equal(response.status, 404);
  assert.equal(h.requests.length, count + 1);
});
test('activation removes only LiftLog caches, never another app namespace', async () => {
  const h = await harness();
  await h.lifetime('install');
  for (const key of ['liftlog-ultra-v35', 'liftlog-shell-previous', 'other-app-cache']) h.buckets.set(key, new Map());
  await h.lifetime('activate');
  assert.deepEqual(Array.from(h.buckets.keys()).sort(), ['liftlog-shell-' + h.release, 'other-app-cache'].sort());
  assert.equal(h.state.claimed, 1);
});
function replyingClient(h, id, safe) {
  return {id, url: scope, messages: [], postMessage(message) {
    this.messages.push(message);
    if (message.type === 'LIFTLOG_PREPARE_UPDATE') h.handlers.message({data: {type: 'LIFTLOG_UPDATE_APPROVAL', token: message.token, safe}, source: {id}});
  }};
}
test('one active or dirty window defers activation in all windows', async () => {
  const h = await harness();
  const idle = replyingClient(h, 'idle', true);
  const active = replyingClient(h, 'active', false);
  h.setClients([idle, active]);
  await h.lifetime('message', {data: {type: 'LIFTLOG_ACTIVATE_IF_SAFE'}});
  assert.equal(h.state.skipped, 0);
  assert.ok(idle.messages.some(message => message.type === 'LIFTLOG_CANCEL_UPDATE'));
  assert.ok(active.messages.some(message => message.type === 'LIFTLOG_CANCEL_UPDATE'));
});
test('all idle windows approving permits activation', async () => {
  const h = await harness();
  const a = replyingClient(h, 'one', true);
  const b = replyingClient(h, 'two', true);
  h.setClients([a, b]);
  await h.lifetime('message', {data: {type: 'LIFTLOG_ACTIVATE_IF_SAFE'}});
  assert.equal(h.state.skipped, 1);
  assert.ok(a.messages.some(message => message.type === 'LIFTLOG_UPDATE_ACTIVATING'));
});
test('a newly opened window prevents activation until it has approved too', async () => {
  const h = await harness();
  const original = replyingClient(h, 'one', true);
  const newcomer = replyingClient(h, 'new', false);
  const reply = original.postMessage;
  original.postMessage = function(message) { reply.call(this, message); if (message.type === 'LIFTLOG_PREPARE_UPDATE') h.setClients([original, newcomer]); };
  h.setClients([original]);
  await h.lifetime('message', {data: {type: 'LIFTLOG_ACTIVATE_IF_SAFE'}});
  assert.equal(h.state.skipped, 0);
});
test('no open windows allows a staged release to activate', async () => {
  const h = await harness();
  await h.lifetime('message', {data: {type: 'LIFTLOG_ACTIVATE_IF_SAFE'}});
  assert.equal(h.state.skipped, 1);
});

test('an unknown legacy window times out without forcing activation', async () => {
  const h = await harness({quickApprovalTimeout: true});
  const legacy = {id: 'legacy', url: scope, messages: [], postMessage(message) { this.messages.push(message); }};
  h.setClients([legacy]);
  await h.lifetime('message', {data: {type: 'LIFTLOG_ACTIVATE_IF_SAFE'}});
  assert.equal(h.state.skipped, 0);
  assert.ok(legacy.messages.some(message => message.type === 'LIFTLOG_CANCEL_UPDATE'));
});


test('installation reports bounded progress and a safe error without exception text', async () => {
  const client = {id: 'one', url: scope, messages: [], postMessage(message) { this.messages.push(message); }};
  const h = await harness({clients: [client], failPut: true});
  await assert.rejects(h.lifetime('install'), /storage/);
  const progress = client.messages.filter(message => message.type === 'LIFTLOG_INSTALL_STATUS');
  assert.ok(progress.some(message => message.stage === 'downloading' && message.completed === assets.length));
  assert.equal(progress.at(-1).errorCode, 'storage');
  assert.ok(progress.every(message => message.release === h.release && message.total === assets.length && message.completed <= message.total));
  assert.ok(!JSON.stringify(progress).includes('quota'));
});
test('worker limits simultaneous downloads to three', async () => {
  let active = 0, maximum = 0;
  const h = await harness({network: async path => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return new Response(bodies[path], {headers: {'content-type': mime(path)}});
  }});
  await h.lifetime('install');
  assert.equal(maximum, 3);
});
test('cache verification detects eviction and corrupted bytes even for matching release', async () => {
  const client = {id: 'one', url: scope, messages: [], postMessage(message) { this.messages.push(message); }};
  const h = await harness(); await h.lifetime('install');
  const verify = async () => {
    await h.lifetime('message', {data: {type: 'LIFTLOG_VERIFY_CACHE', requestId: 'readiness', release: h.release}, source: client});
    return client.messages.at(-1);
  };
  assert.equal((await verify()).ok, true);
  const bucket = h.buckets.get('liftlog-shell-' + h.release);
  bucket.set(scope + 'app.js', new Response('corrupt', {headers: {'content-type': 'text/javascript'}}));
  assert.equal((await verify()).errorCode, 'hash');
  bucket.delete(scope + 'app.js');
  assert.equal((await verify()).errorCode, 'storage');
});
test('failed same-release repair preserves surviving cache entries', async () => {
  const h = await harness({failPut: true});
  h.buckets.set('liftlog-shell-' + h.release, new Map([[scope + 'index.html', new Response(bodies['./index.html'])]]));
  await assert.rejects(h.lifetime('install'), /storage/);
  assert.equal(await h.buckets.get('liftlog-shell-' + h.release).get(scope + 'index.html').text(), bodies['./index.html'].toString('utf8'));
});
test('cache verification requests with unrelated release or outside scope are ignored', async () => {
  const h = await harness();
  const client = {id: 'other', url: 'https://example.test/other/', messages: [], postMessage(message) { this.messages.push(message); }};
  await h.lifetime('message', {data: {type: 'LIFTLOG_VERIFY_CACHE', requestId: 'x', release: h.release}, source: client});
  assert.equal(client.messages.length, 0);
});


test('a missing navigation shell returns an isolated online recovery page', async () => {
  const h = await harness();
  const response = await h.request('./', {mode: 'navigate'});
  assert.equal(response.status, 503); assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Restore offline access/); assert.match(html, /updates\.js\?__liftlog_update=recovery-/);
  assert.ok(!html.includes('<script src="./app.js')); assert.ok(!html.includes('localStorage')); assert.ok(!html.includes('indexedDB')); assert.ok(!html.includes('unregister'));
  assert.equal(h.requests.length, 0);
});
test('partial shell eviction also uses recovery instead of starting an incomplete app', async () => {
  const h = await harness(); await h.lifetime('install');
  h.buckets.get('liftlog-shell-' + h.release).delete(scope + 'app.js');
  assert.match(await (await h.request('./', {mode: 'navigate'})).text(), /Restore offline access/);
  const missingScript = await h.request('./app.js');
  assert.equal(missingScript.status, 503); assert.match(missingScript.headers.get('content-type'), /text\/plain/);
});


for (const [path, contents] of [['./index.html', ''], ['./index.html', 'corrupted nonempty HTML'], ['./app.js', ''], ['./app.js', 'corrupted nonempty JavaScript']]) {
  test('navigation rejects cached ' + path + ' with ' + (contents ? 'corrupt' : 'empty') + ' bytes', async () => {
    const h = await harness(); await h.lifetime('install');
    assert.equal((await h.request('./', {mode: 'navigate'})).status, 200);
    h.buckets.get('liftlog-shell-' + h.release).set(new URL(path, scope).href, new Response(contents, {headers: {'content-type': mime(path)}}));
    const response = await h.request('./', {mode: 'navigate'});
    assert.equal(response.status, 503); assert.match(await response.text(), /Restore offline access/);
  });
}
test('a stalled navigation integrity check reaches recovery within a finite deadline', async () => {
  const h = await harness({fastRecoveryTimeouts: true}); await h.lifetime('install'); h.state.hungMatch = true;
  const response = await h.request('./', {mode: 'navigate'});
  assert.equal(response.status, 503); assert.match(await response.text(), /Restore offline access/);
});
test('activation claims a verified worker even when old-cache deletion rejects', async () => {
  const h = await harness({failDelete: true}); await h.lifetime('install');
  h.buckets.set('liftlog-shell-previous', new Map()); await h.lifetime('activate');
  assert.equal(h.state.claimed, 1); assert.ok(h.buckets.has('liftlog-shell-' + h.release));
});
test('activation claims a verified worker even when cache listing rejects', async () => {
  const h = await harness(); await h.lifetime('install'); h.state.failKeys = true;
  await h.lifetime('activate'); assert.equal(h.state.claimed, 1);
});
test('stalled old-cache cleanup cannot leave activation pending indefinitely', async () => {
  const h = await harness({hungDelete: true, fastRecoveryTimeouts: true}); await h.lifetime('install');
  h.buckets.set('liftlog-shell-previous', new Map()); await h.lifetime('activate');
  assert.equal(h.state.claimed, 1);
});
function recoveryHarness(html) {
  const scriptText = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const scripts = [], timers = new Map(), button = {disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }}, label = {textContent: ''};
  const window = {listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }};
  let nextTimer = 0, reloads = 0;
  const document = {getElementById(id) { return id === 'retry' ? button : label; }, createElement() { return {removed: false, remove() { this.removed = true; }}; }, head: {appendChild(script) { scripts.push(script); }}};
  vm.runInNewContext(scriptText, {document, window, location: {reload() { reloads++; }}, URL, Date, setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; }, clearTimeout(id) { timers.delete(id); }});
  return {scripts, timers, button, label, window, reloads: () => reloads, expire() { for (const {fn} of Array.from(timers.values())) fn(); }};
}
test('recovery script load times out, ignores late completion, and permits a fresh retry', async () => {
  const h = await harness(), html = await (await h.request('./', {mode: 'navigate'})).text();
  const ui = recoveryHarness(html), first = ui.scripts[0], lateLoad = first.onload;
  assert.equal(ui.button.disabled, true); assert.equal(Array.from(ui.timers.values())[0].delay, 15000);
  ui.expire(); assert.equal(ui.button.disabled, false); assert.equal(first.removed, true); assert.match(ui.label.textContent, /Could not connect/);
  let lateConfigurations = 0, configured = 0, retried = 0;
  ui.window.LiftLogUpdates = {configure() { lateConfigurations++; }}; lateLoad(); assert.equal(lateConfigurations, 0);
  ui.button.listeners.click(); assert.equal(ui.scripts.length, 2); assert.equal(ui.button.disabled, true);
  lateLoad(); assert.equal(ui.button.disabled, true); assert.equal(lateConfigurations, 0);
  ui.window.LiftLogUpdates = {configure(options) { configured++; options.onStatus({state: 'failed', retryable: true, detail: 'Try again'}); }, check() { retried++; }};
  ui.scripts[1].onload(); assert.equal(configured, 1); assert.equal(ui.timers.size, 0); assert.equal(ui.button.disabled, false);
  // A timed-out script executing late cannot replace the captured working API.
  ui.window.LiftLogUpdates = {check() { throw Error('late updater must be ignored'); }};
  ui.button.listeners.click(); assert.equal(retried, 1);
});
