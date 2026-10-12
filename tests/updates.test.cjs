const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto, createHash} = require('node:crypto');
const source = fs.readFileSync(new URL('../updates.js', 'file://' + __filename), 'utf8');
const workerSource = fs.readFileSync(new URL('../sw.js', 'file://' + __filename), 'utf8');
const scope = 'https://example.test/workout/';
const manifestPattern = /\/\* LIFTLOG_ASSET_MANIFEST_START \*\/\s*(\[[\s\S]*?\])\s*\/\* LIFTLOG_ASSET_MANIFEST_END \*\//;
const manifest = workerSource.match(manifestPattern);
assert.ok(manifest, 'The worker must publish its release manifest.');
const assets = JSON.parse(manifest[1]);
const rootURL = new URL('../', 'file://' + __filename);
const bodies = Object.fromEntries(assets.map(path => [path, fs.readFileSync(new URL(path, rootURL))]));
const mime = path => path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.png') ? 'image/png' : 'image/svg+xml';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const releaseFor = (paths, files) => digest(Buffer.from(paths.map(path => path + ':' + digest(files[path])).join('\n')));
const futurePath = './modules/new-module.js';
function emitter(value = {}) {
  const listeners = {};
  return Object.assign(value, {addEventListener(type, callback) { (listeners[type] ||= []).push(callback); }, async emit(type, data = {}) { for (const callback of listeners[type] || []) await callback(data); }});
}
function harness(config = {}) {
  const {controlled = true, futureFile = false} = config;
  const releaseAssets = futureFile ? [...assets, futurePath] : assets;
  const futureWorker = workerSource.replace(manifest[1], JSON.stringify(releaseAssets, null, 2));
  const servedBodies = futureFile ? {...bodies, './sw.js': Buffer.from(futureWorker), [futurePath]: Buffer.from('export const newFeature = true;\n')} : bodies;
  const state = {reloads: 0, requests: [], registrations: [], networkError: config.unavailable, statuses: [], activeRequests: 0, maxRequests: 0, timers: new Set()};
  const serviceWorker = emitter();
  function makeWorker(release = 'b'.repeat(64), extra = {}) {
    const worker = emitter({state: 'installed', scriptURL: scope + 'sw.js?release=' + release, cacheValid: true, messages: [], ...extra});
    worker.postMessage = message => {
      worker.messages.push(message);
      if (message.type === 'LIFTLOG_VERIFY_CACHE' && !config.hungVerify) queueMicrotask(() => serviceWorker.emit('message', {source: worker, data: {type: 'LIFTLOG_CACHE_VERIFIED', requestId: message.requestId, release: message.release, ok: worker.cacheValid, errorCode: worker.cacheValid ? '' : 'storage'}}));
    };
    return worker;
  }
  const workers = emitter({active: controlled ? makeWorker('a'.repeat(64), {state: 'activated', cacheValid: config.oldCacheValid !== false}) : null, waiting: null, installing: null});
  serviceWorker.controller = workers.active;
  serviceWorker.getRegistration = async () => workers;
  serviceWorker.register = async (url, options) => {
    state.registrations.push({url, options});
    if (config.registrationError) throw Error('private browser failure');
    if (config.hungRegister) return new Promise(() => {});
    const candidate = makeWorker(new URL(url).searchParams.get('release'), {scriptURL: url, state: config.hungInstall ? 'installing' : config.failedInstall ? 'redundant' : 'installed'});
    workers.installing = candidate;
    if (!config.hungInstall && !config.failedInstall) {
      if (controlled) workers.waiting = candidate;
      else { candidate.state = 'activated'; workers.active = candidate; if (!config.noControl) serviceWorker.controller = candidate; }
    }
    await workers.emit('updatefound');
    if (!controlled && !config.hungInstall && !config.failedInstall && !config.noControl) queueMicrotask(() => serviceWorker.emit('controllerchange'));
    return workers;
  };
  const document = emitter({baseURI: scope, visibilityState: 'visible'});
  const window = emitter({isSecureContext: true});
  const navigator = {serviceWorker, onLine: true};
  const fetch = async url => {
    state.requests.push(String(url));
    state.activeRequests++; state.maxRequests = Math.max(state.maxRequests, state.activeRequests);
    try {
      if (config.hungFetch) return await new Promise(() => {});
      if (state.networkError) throw new Error('private origin or exception text');
      if (config.fetchDelay) await new Promise(resolve => setTimeout(resolve, config.fetchDelay));
      const path = './' + new URL(url).pathname.slice(new URL(scope).pathname.length);
      const contentType = config.badMime && path === './app.js' ? 'text/html' : mime(path);
      return new Response(servedBodies[path] || 'not found', {status: config.httpError ? 502 : servedBodies[path] ? 200 : 404, headers: {'content-type': contentType}});
    } finally { state.activeRequests--; }
  };
  const setTimer = (fn, duration) => {
    const scaled = config.fastTimeouts && [8000, 10000, 15000, 20000, 90000].includes(duration) ? 35 : config.fastRetries && [5000, 15000].includes(duration) ? 5 : duration;
    const timer = setTimeout(() => { state.timers.delete(timer); fn(); }, scaled); state.timers.add(timer); return timer;
  };
  const clearTimer = timer => { state.timers.delete(timer); clearTimeout(timer); };
  vm.runInNewContext(source, {window, document, navigator, location: {reload() { state.reloads++; }}, fetch, crypto: webcrypto, URL, Response, AbortController, TextEncoder, TextDecoder, Uint8Array, setTimeout: setTimer, clearTimeout: clearTimer, Date, WeakSet, Map, Set, console});
  const configure = (extra = {}) => window.LiftLogUpdates.configure({canReload: () => true, onStatus: value => state.statuses.push(value), ...extra});
  return {api: window.LiftLogUpdates, configure, state, workers, serviceWorker, document, window, navigator, makeWorker,
    expectedRelease: releaseFor(releaseAssets, servedBodies),
    cleanup() { for (const timer of state.timers) clearTimeout(timer); }};
}
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const send = (h, source, data) => h.serviceWorker.emit('message', {source, data});
function setup(t, config) { const h = harness(config); t.after(() => h.cleanup()); return h; }

test('worker manifest includes every app dependency and recap image within the offline size budget', () => {
  const required = ['./index.html', './style.css', './storage.js', './dates.js', './logging.js', './app.js', './updates.js',
    './manifest.json', './icon-192.svg', './icon-512.svg', './icon-maskable.svg', './apple-touch-icon.png', './sw.js',
    './interface.css', './stats-polish.css', './history-editor.css', './recaps.css', './chart-motion.js', './history-editor.js', './recaps.js'];
  assert.equal(new Set(assets).size, assets.length, 'Duplicate manifest entries waste downloads and affect release hashes.');
  for (const path of required) assert.ok(assets.includes(path), `Missing required offline dependency: ${path}`);
  const html = bodies['./index.html'].toString('utf8');
  for (const [, reference] of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
    const url = new URL(reference, scope);
    if (url.origin === new URL(scope).origin) assert.ok(assets.includes('./' + url.pathname.slice(new URL(scope).pathname.length)), `Uncached HTML dependency: ${reference}`);
  }
  const recapAssets = fs.readdirSync(new URL('./assets/recap/', rootURL), {recursive: true})
    .filter(name => name.endsWith('.webp')).map(name => './assets/recap/' + name);
  const expectedRecaps = ['cover', 'time', 'trophy', 'weeks', 'workouts', 'muscle-back', 'muscle-biceps', 'muscle-calves',
    'muscle-cardio', 'muscle-chest', 'muscle-core', 'muscle-forearms', 'muscle-glutes', 'muscle-hamstrings',
    'muscle-other', 'muscle-quads', 'muscle-shoulders', 'muscle-triceps'].map(name => './assets/recap/' + name + '.webp');
  for (const path of expectedRecaps) assert.ok(recapAssets.includes(path), `Missing recap artwork: ${path}`);
  const expectedFemaleRecaps = expectedRecaps.filter(path => /\/workouts\.webp$|\/muscle-[a-z]+\.webp$/.test(path))
    .map(path => path.replace('/recap/', '/recap/female/'));
  assert.equal(expectedFemaleRecaps.length, 14);
  for (const path of expectedFemaleRecaps) assert.ok(recapAssets.includes(path), `Missing Purple recap artwork: ${path}`);
  assert.deepEqual(assets.filter(path => path.startsWith('./assets/recap/')).sort(), recapAssets.sort());
  let bytes = 0;
  for (const path of assets) {
    assert.match(path, /^\.\/[a-zA-Z0-9_./-]+$/);
    assert.ok(!path.includes('..'), `Unsafe manifest path: ${path}`);
    const file = fs.statSync(new URL(path, rootURL));
    assert.ok(file.isFile() && file.size > 0, `Missing or empty offline file: ${path}`);
    bytes += file.size;
    if (path.endsWith('.webp')) {
      assert.equal(bodies[path].toString('ascii', 0, 4), 'RIFF', `Invalid WebP header: ${path}`);
      assert.equal(bodies[path].toString('ascii', 8, 12), 'WEBP', `Invalid WebP format: ${path}`);
    }
  }
  assert.ok(bytes < 1_000_000, `Offline shell is ${bytes} bytes; keep the first install below 1 MB.`);
});
test('an old updater discovers new files in a future worker manifest', async t => {
  const h = setup(t, {futureFile: true}); h.configure(); await h.api.check();
  assert.equal(h.state.requests.length, assets.length + 1);
  assert.ok(!assets.includes(futurePath), 'The new file must be unknown to the running updater release.');
  assert.ok(h.state.requests.some(url => url.includes('/modules/new-module.js?')));
  assert.equal(h.state.registrations.length, 1);
  assert.equal(new URL(h.state.registrations[0].url).searchParams.get('release'), h.expectedRelease);
});
test('launch probes immutable release files with no more than three concurrent fetches', async t => {
  const h = setup(t, {fetchDelay: 2}); h.configure(); await h.api.check();
  assert.equal(h.state.requests.length, assets.length);
  assert.equal(h.state.maxRequests, 3);
  assert.ok(h.state.requests.every(url => url.includes('__liftlog_update=')));
  assert.match(h.state.registrations[0].url, /sw\.js\?release=[a-f0-9]{64}$/);
  assert.equal(new URL(h.state.registrations[0].url).searchParams.get('release'), h.expectedRelease);
  assert.deepEqual(h.state.requests.map(url => './' + new URL(url).pathname.slice(new URL(scope).pathname.length)).sort(), assets.slice().sort());
  assert.equal(h.state.registrations[0].options.updateViaCache, 'none');
  assert.equal(h.state.reloads, 0);
});
test('network failure reports a safe actionable first-install error, never ready', async t => {
  const h = setup(t, {controlled: false, unavailable: true}); h.configure(); await h.api.check();
  assert.equal(h.state.registrations.length, 0);
  assert.equal(h.api.getStatus().state, 'failed');
  assert.equal(h.api.getStatus().errorCode, 'network');
  assert.equal(h.api.getStatus().offlineReady, false);
  assert.equal(h.api.getStatus().retryable, true);
  assert.ok(!JSON.stringify(h.state.statuses).includes('private'));
});
test('an offline check can still verify an existing cached app', async t => {
  const h = setup(t, {unavailable: true}); h.configure(); await h.api.check(); await tick();
  assert.equal(h.state.registrations.length, 0); assert.equal(h.state.reloads, 0);
  assert.equal(h.api.getStatus().offlineReady, true);
});
test('first successful install waits for cache verification and control, without reloading', async t => {
  const h = setup(t, {controlled: false}); h.configure(); await h.api.check();
  assert.equal(h.api.getStatus().state, 'current'); assert.equal(h.api.getStatus().offlineReady, true);
  assert.equal(h.state.reloads, 0);
  assert.ok(h.workers.active.messages.some(message => message.type === 'LIFTLOG_VERIFY_CACHE'));
  const progress = h.state.statuses.filter(value => value.total);
  assert.ok(progress.some(value => value.completed === assets.length && value.bytes > 0));
  const snapshot = h.api.getStatus(); snapshot.state = 'changed'; assert.equal(h.api.getStatus().state, 'current');
});
test('failed installation becomes an error instead of hanging on downloading', async t => {
  const h = setup(t, {controlled: false, failedInstall: true}); h.configure(); await h.api.check();
  assert.equal(h.api.getStatus().errorCode, 'install'); assert.equal(h.api.getStatus().offlineReady, false);
});
for (const [config, errorCode] of [[{hungFetch: true}, 'timeout'], [{hungRegister: true}, 'timeout'], [{hungInstall: true}, 'timeout'], [{registrationError: true}, 'registration'], [{badMime: true}, 'mime'], [{httpError: true}, 'http']]) {
  test('bounded first-install failure: ' + Object.keys(config)[0], async t => {
    const h = setup(t, {controlled: false, fastTimeouts: true, ...config}); h.configure(); await h.api.check();
    assert.equal(h.api.getStatus().errorCode, errorCode); assert.equal(h.api.getStatus().offlineReady, false);
  });
}
test('initial setup retries transient failures twice, then manual retry can recover', async t => {
  const h = setup(t, {controlled: false, unavailable: true, fastRetries: true}); h.configure(); await h.api.check(); await tick(50);
  assert.equal(h.state.requests.length, 3);
  await h.document.emit('visibilitychange'); await h.window.emit('online'); await tick();
  assert.equal(h.state.requests.length, 3);
  h.state.networkError = false; await h.api.check();
  assert.equal(h.api.getStatus().offlineReady, true);
});
test('returning to the app online retries a failed initial installation', async t => {
  const h = setup(t, {controlled: false, unavailable: true}); h.configure(); await h.api.check();
  h.state.networkError = false; await h.document.emit('visibilitychange'); await h.api.check();
  assert.equal(h.api.getStatus().offlineReady, true);
});
test('matching release still verifies caches; eviction starts a repair registration', async t => {
  const h = setup(t); h.configure(); await h.api.check();
  const first = h.workers.waiting; first.state = 'activated'; first.cacheValid = false;
  h.workers.active = first; h.workers.waiting = null; h.workers.installing = null; h.serviceWorker.controller = first;
  await h.api.check();
  assert.equal(h.state.registrations.length, 2);
  assert.match(h.state.registrations[1].url, /&repair=\d+$/);
  assert.equal(h.api.getStatus().offlineReady, false);
});
test('matching healthy controlled release is ready without reinstalling', async t => {
  const h = setup(t); h.configure(); await h.api.check();
  h.workers.active = h.workers.waiting; h.workers.active.state = 'activated'; h.serviceWorker.controller = h.workers.active;
  h.workers.waiting = null; h.workers.installing = null; await h.api.check();
  assert.equal(h.state.registrations.length, 1); assert.equal(h.api.getStatus().state, 'current');
});
test('active workout and other windows retain the guarded update handshake', async t => {
  const h = setup(t); let safe = false, prepared = 0, locked = false;
  h.configure({canReload: () => safe, prepareForUpdate: async () => { prepared++; locked = true; return true; }, cancelUpdate: () => { locked = false; }});
  await h.api.check(); const candidate = h.workers.waiting;
  await send(h, candidate, {type: 'LIFTLOG_PREPARE_UPDATE', token: 'one', expiresAt: Date.now() + 6000});
  assert.equal(candidate.messages.at(-1).safe, false); assert.equal(prepared, 0);
  await h.serviceWorker.emit('controllerchange'); await tick(); assert.equal(h.state.reloads, 0);
  safe = true; h.api.notifySafe(); await tick(); assert.equal(prepared, 1); assert.equal(h.state.reloads, 1);
  await send(h, candidate, {type: 'LIFTLOG_CANCEL_UPDATE', token: 'controller-change'}); assert.equal(locked, false);
});
test('expired requests and unrelated worker sources cannot lock the page', async t => {
  const h = setup(t); let preparations = 0; h.configure({prepareForUpdate: () => { preparations++; return true; }}); await h.api.check();
  const candidate = h.makeWorker(); await send(h, candidate, {type: 'LIFTLOG_PREPARE_UPDATE', token: 'old', expiresAt: Date.now() - 1});
  assert.equal(candidate.messages.at(-1).safe, false);
  await send(h, h.makeWorker('c'.repeat(64), {scriptURL: 'https://elsewhere.test/sw.js?release=' + 'c'.repeat(64)}), {type: 'LIFTLOG_PREPARE_UPDATE', token: 'other', expiresAt: Date.now() + 6000});
  assert.equal(preparations, 0);
});
test('late active-worker messages cannot relock the first installed page', async t => {
  const h = setup(t, {controlled: false}); let locked = false;
  h.configure({prepareForUpdate: () => { locked = true; return true; }}); await h.api.check();
  await send(h, h.workers.active, {type: 'LIFTLOG_PREPARE_UPDATE', token: 'late', expiresAt: Date.now() + 6000});
  assert.equal(locked, false); assert.equal(h.api.getStatus().state, 'current');
});
test('worker progress is accepted only for the requested script and release', async t => {
  const h = setup(t); h.configure(); await h.api.check();
  const before = h.api.getStatus(); const candidate = h.workers.waiting;
  await send(h, candidate, {type: 'LIFTLOG_INSTALL_STATUS', release: 'f'.repeat(64), stage: 'error', errorCode: 'storage'});
  assert.deepEqual(h.api.getStatus(), before);
  await send(h, h.makeWorker('e'.repeat(64)), {type: 'LIFTLOG_INSTALL_STATUS', release: 'e'.repeat(64), stage: 'downloading', completed: 1, total: assets.length, bytes: 42});
  assert.deepEqual(h.api.getStatus(), before);
});

test('installed files without browser control never report offline ready', async t => {
  const h = setup(t, {controlled: false, noControl: true, fastTimeouts: true}); h.configure(); await h.api.check();
  assert.equal(h.api.getStatus().errorCode, 'control'); assert.equal(h.api.getStatus().offlineReady, false);
  assert.ok(!h.state.statuses.some(value => value.state === 'current'));
});
test('a stalled cache verification has a finite failure, including after controllerchange', async t => {
  const h = setup(t, {controlled: false, hungVerify: true, fastTimeouts: true}); h.configure(); await h.api.check();
  assert.equal(h.api.getStatus().errorCode, 'timeout'); assert.equal(h.api.getStatus().offlineReady, false);
});
test('release-scoped worker download and cache progress reaches the status callback', async t => {
  const h = setup(t); const register = h.serviceWorker.register;
  h.serviceWorker.register = async (url, options) => {
    const result = await register(url, options), candidate = result.installing;
    for (const stage of ['downloading', 'caching', 'verifying']) {
      await send(h, candidate, {type: 'LIFTLOG_INSTALL_STATUS', release: new URL(url).searchParams.get('release'), stage, completed: 3, total: assets.length, bytes: 12345, asset: './app.js'});
    }
    return result;
  };
  h.configure(); await h.api.check();
  for (const stage of ['downloading', 'caching', 'verifying']) assert.ok(h.state.statuses.some(value => value.stage === stage && value.completed === 3 && value.bytes === 12345));
});
test('worker-reported storage errors survive registration and become actionable', async t => {
  const h = setup(t, {controlled: false, failedInstall: true}); const register = h.serviceWorker.register;
  h.serviceWorker.register = async (url, options) => {
    const result = await register(url, options);
    await send(h, result.installing, {type: 'LIFTLOG_INSTALL_STATUS', release: new URL(url).searchParams.get('release'), stage: 'error', errorCode: 'storage', asset: './app.js'});
    return result;
  };
  h.configure(); await h.api.check();
  assert.equal(h.api.getStatus().errorCode, 'storage'); assert.equal(h.api.getStatus().asset, './app.js');
});
