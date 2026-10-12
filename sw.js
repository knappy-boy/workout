/* LiftLog's app shell is immutable within a release. Workout data lives in
 * browser storage, never in these caches. updates.js derives the release from
 * the actual deployed files, so publishing does not need a manual version bump. */
const SHELL_ASSETS = /* LIFTLOG_ASSET_MANIFEST_START */ [
  "./index.html",
  "./style.css",
  "./theme-runtime.js",
  "./purple-themes.css",
  "./storage.js",
  "./dates.js",
  "./logging.js",
  "./exercise-load.js",
  "./app.js",
  "./updates.js",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg",
  "./icon-maskable.svg",
  "./apple-touch-icon.png",
  "./sw.js",
  "./interface.css",
  "./stats-polish.css",
  "./history-editor.css",
  "./recaps.css",
  "./chart-motion.js",
  "./history-editor.js",
  "./recaps.js",
  "./assets/recap/cover.webp",
  "./assets/recap/muscle-back.webp",
  "./assets/recap/muscle-biceps.webp",
  "./assets/recap/muscle-calves.webp",
  "./assets/recap/muscle-cardio.webp",
  "./assets/recap/muscle-chest.webp",
  "./assets/recap/muscle-core.webp",
  "./assets/recap/muscle-forearms.webp",
  "./assets/recap/muscle-glutes.webp",
  "./assets/recap/muscle-hamstrings.webp",
  "./assets/recap/muscle-other.webp",
  "./assets/recap/muscle-quads.webp",
  "./assets/recap/muscle-shoulders.webp",
  "./assets/recap/muscle-triceps.webp",
  "./assets/recap/time.webp",
  "./assets/recap/trophy.webp",
  "./assets/recap/weeks.webp",
  "./assets/recap/workouts.webp",
  "./assets/recap/female/workouts.webp",
  "./assets/recap/female/muscle-back.webp",
  "./assets/recap/female/muscle-biceps.webp",
  "./assets/recap/female/muscle-calves.webp",
  "./assets/recap/female/muscle-cardio.webp",
  "./assets/recap/female/muscle-chest.webp",
  "./assets/recap/female/muscle-core.webp",
  "./assets/recap/female/muscle-forearms.webp",
  "./assets/recap/female/muscle-glutes.webp",
  "./assets/recap/female/muscle-hamstrings.webp",
  "./assets/recap/female/muscle-other.webp",
  "./assets/recap/female/muscle-quads.webp",
  "./assets/recap/female/muscle-shoulders.webp",
  "./assets/recap/female/muscle-triceps.webp",
  "./workout-motion.js",
  "./workout-motion.css",
  "./library-history.css",
  "./routine-editor.css",
  "./picker.css",
  "./logger-polish.css",
  "./sliding-controls.css",
  "./sliding-controls.js",
  "./assets/icons/file-bold.svg",
  "./assets/icons/copy-original.jpg",
  "./assets/icons/arrow-elbow-down-right-bold.svg",
  "./assets/icons/shuffle-bold.svg",
  "./assets/icons/x-bold.svg",
  "./assets/icons/plus-bold.svg",
  "./assets/icons/caret-down-bold.svg",
  "./assets/icons/PHOSPHOR-LICENSE.txt",
  "./tap-feedback.js"
]  /* LIFTLOG_ASSET_MANIFEST_END */;
const CACHE_PREFIX = "liftlog-shell-";
const RELEASE = new URL(self.location.href).searchParams.get("release");
const CACHE_NAME = CACHE_PREFIX + RELEASE;
const UPDATE_MARKER = "__liftlog_update";
const scope = self.registration.scope;
const assetURLs = new Set(SHELL_ASSETS.map(path => new URL(path, scope).href));

const ERROR_CODES = new Set(["network", "timeout", "http", "mime", "empty", "manifest", "hash", "storage"]);
function safeCode(error, fallback = "storage") { return ERROR_CODES.has(error && error.code) ? error.code : error && error.name === "AbortError" ? "timeout" : fallback; }
function failure(code, asset = "") { const error = new Error(code); error.code = code; error.asset = asset; return error; }
function responseError(response, path) {
  if (!response.ok || response.status !== 200 || response.type === "opaque" || response.redirected) return "http";
  const type = response.headers.get("content-type") || "";
  if (/\.js$/.test(path) && !/(?:javascript|ecmascript)/i.test(type)) return "mime";
  if (/\.css$/.test(path) && !/text\/css/i.test(type)) return "mime";
  if (/\.html$/.test(path) && !/text\/html/i.test(type)) return "mime";
  if (/\.json$/.test(path) && !/(?:application\/json|text\/json)/i.test(type)) return "mime";
  return "";
}
async function digest(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
function bounded(work, duration, code, onTimeout) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { if (onTimeout) onTimeout(); reject(failure(code)); }, duration); })]).finally(() => clearTimeout(timer));
}
async function publishInstall(stage, completed, bytes, asset = "", errorCode = "") {
  const clients = (await self.clients.matchAll({type: "window", includeUncontrolled: true})).filter(inScope);
  clients.forEach(client => client.postMessage({type: "LIFTLOG_INSTALL_STATUS", release: RELEASE, stage, completed, total: SHELL_ASSETS.length, bytes, asset, errorCode}));
}
async function downloadAsset(path, probe) {
  const url = new URL(path, scope); url.searchParams.set(UPDATE_MARKER, probe);
  const controller = new AbortController();
  try {
    return await bounded((async () => {
      const response = await fetch(url.href, {cache: "no-store", credentials: "same-origin", signal: controller.signal});
      const code = responseError(response, path);
      if (code) throw failure(code, path);
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) throw failure("empty", path);
      return {path, response: new Response(bytes, {status: 200, headers: response.headers}), hash: await digest(bytes), size: bytes.byteLength};
    })(), 15000, "timeout", () => controller.abort());
  } catch (error) { throw failure(safeCode(error, "network"), path); }
}
async function verifyCache() {
  if (!(await caches.keys()).includes(CACHE_NAME)) throw failure("storage");
  const cache = await caches.open(CACHE_NAME), hashes = [];
  let verifiedIndex;
  // Sequential reads keep peak memory low on mobile devices.
  for (const path of SHELL_ASSETS) {
    const response = await cache.match(new URL(path, scope).href);
    if (!response || responseError(response, path)) throw failure("storage", path);
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw failure("storage", path);
    hashes.push(path + ":" + await digest(bytes));
    if (path === "./index.html") verifiedIndex = {bytes, headers: response.headers};
  }
  if (await digest(new TextEncoder().encode(hashes.join("\n"))) !== RELEASE) throw failure("hash");
  return verifiedIndex;
}
async function installRelease() {
  let completed = 0, bytes = 0, createdCache = false;
  try {
    // Legacy unversioned registrations cannot activate without a verified release.
    if (!/^[a-f0-9]{64}$/.test(RELEASE || "")) throw failure("manifest");
    await publishInstall("downloading", completed, bytes);
    const assets = new Array(SHELL_ASSETS.length); let next = 0, stopped = false, firstError;
    await Promise.all(Array.from({length: 3}, async () => {
      while (!stopped && next < SHELL_ASSETS.length) {
        const index = next++;
        try {
          assets[index] = await downloadAsset(SHELL_ASSETS[index], RELEASE);
          completed++; bytes += assets[index].size;
          await publishInstall("downloading", completed, bytes, SHELL_ASSETS[index]);
        } catch (error) { stopped = true; if (!firstError) firstError = error; }
      }
    }));
    if (firstError) throw firstError;
    const actualRelease = await digest(new TextEncoder().encode(assets.map(asset => asset.path + ":" + asset.hash).join("\n")));
    if (actualRelease !== RELEASE) throw failure("hash");
    createdCache = !(await caches.keys()).includes(CACHE_NAME);
    const cache = await caches.open(CACHE_NAME);
    completed = 0;
    await publishInstall("caching", completed, bytes);
    for (const asset of assets) {
      try { await cache.put(new URL(asset.path, scope).href, asset.response); }
      catch (_) { throw failure("storage", asset.path); }
      await publishInstall("caching", ++completed, bytes, asset.path);
    }
    await publishInstall("verifying", completed, bytes);
    await verifyCache();
  } catch (error) {
    // A repair can share the same immutable release cache as an active worker.
    // Preserve its surviving entries if a repair write fails.
    if (createdCache) await caches.delete(CACHE_NAME).catch(() => {});
    await publishInstall("error", completed, bytes, error.asset || "", safeCode(error)).catch(() => {});
    throw error;
  }
}
self.addEventListener("install", event => event.waitUntil(bounded(installRelease(), 90000, "timeout")));

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // Installation already verified this release. Housekeeping must not stop
    // an otherwise usable worker from controlling the app.
    await self.clients.claim();
    try {
      await bounded((async () => {
        const keys = await caches.keys();
        await Promise.allSettled(keys.filter(key => key !== CACHE_NAME && (key.startsWith(CACHE_PREFIX) || key.startsWith("liftlog-ultra-"))).map(key => caches.delete(key)));
      })(), 2000, "timeout");
    } catch (_) { /* A future activation can retry old-cache cleanup. */ }
  })());
});

// Every open LiftLog window must agree before an update activates. Unknown old
// clients cannot reply and therefore defer the update until they are closed.
let preparation = null;
const approvals = new Map();
function inScope(client) {
  return client.url.startsWith(scope);
}
async function activateWhenSafe() {
  if (self.registration.active && self.registration.active.scriptURL === self.location.href) return;
  if (preparation) return preparation;
  preparation = (async () => {
    const clients = (await self.clients.matchAll({type: "window", includeUncontrolled: true})).filter(inScope);
    const token = RELEASE + ":" + Date.now() + ":" + Math.random();
    const expiresAt = Date.now() + 6000;
    const results = await Promise.all(clients.map(client => new Promise(resolve => {
      const key = token + ":" + client.id;
      const timeout = setTimeout(() => { approvals.delete(key); resolve(false); }, 6000);
      approvals.set(key, safe => { clearTimeout(timeout); approvals.delete(key); resolve(safe); });
      client.postMessage({type: "LIFTLOG_PREPARE_UPDATE", token, expiresAt, release: RELEASE});
    })));
    // Catch a newly opened window that was not present for the preparation.
    const currentClients = (await self.clients.matchAll({type: "window", includeUncontrolled: true})).filter(inScope);
    const known = new Set(clients.map(client => client.id));
    const safe = results.every(Boolean) && currentClients.every(client => known.has(client.id));
    if (safe && (!self.registration.active || self.registration.active.scriptURL !== self.location.href)) {
      currentClients.forEach(client => client.postMessage({type: "LIFTLOG_UPDATE_ACTIVATING", token, release: RELEASE}));
      await self.skipWaiting();
    } else {
      clients.forEach(client => client.postMessage({type: "LIFTLOG_CANCEL_UPDATE", token, release: RELEASE}));
    }
  })().finally(() => { preparation = null; });
  return preparation;
}
self.addEventListener("message", event => {
  const message = event.data || {};
  if (message.type === "LIFTLOG_UPDATE_APPROVAL" && event.source && typeof message.token === "string") {
    const resolve = approvals.get(message.token + ":" + event.source.id);
    if (resolve) resolve(message.safe === true);
  }
  if (message.type === "LIFTLOG_VERIFY_CACHE" && message.release === RELEASE && typeof message.requestId === "string" && message.requestId.length < 100 && event.source && inScope(event.source)) {
    event.waitUntil((async () => {
      let errorCode = "";
      try { await bounded(verifyCache(), 8000, "timeout"); } catch (error) { errorCode = safeCode(error); }
      event.source.postMessage({type: "LIFTLOG_CACHE_VERIFIED", requestId: message.requestId, release: RELEASE, ok: !errorCode, errorCode});
    })());
  }
  if (message.type === "LIFTLOG_ACTIVATE_IF_SAFE") event.waitUntil(activateWhenSafe());
});

// A missing shell cannot boot the normal app's updater. This isolated page
// loads only the fresh updater, which verifies a complete release before repair.
// It never loads app.js or reads/writes workout storage.
function recoveryPage() {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><base href="${scope}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiftLog · Restore offline access</title>
<style>body{font:17px system-ui;margin:0;padding:32px 24px;background:#f7f8fa;color:#18202a}main{max-width:32rem;margin:10vh auto}h1{font-size:1.7rem}p{line-height:1.5}button{padding:14px 22px;font:inherit;font-weight:650;border:0;border-radius:12px;background:#233c68;color:white}button:disabled{opacity:.6}#status{min-height:4.5em}</style>
<main><h1>Restore offline access</h1><p>Some app files are missing from this device. Connect to the internet to download them again. Your saved workout data is separate and will not be cleared.</p><p id="status" role="status" aria-live="polite">Connecting to download the app files…</p><button id="retry" type="button">Retry download</button></main>
<script>(()=>{
const label=document.getElementById('status'),button=document.getElementById('retry');let loading=false,attempt=0,updater=null;
function show(value){label.textContent=value.detail||(value.state==='checking'?'Checking app files…':'Preparing offline access…');if(value.total)label.textContent+=' '+value.completed+' / '+value.total+' files.';button.disabled=!value.retryable&&!['waiting','unavailable','current'].includes(value.state);if(value.state==='current'&&value.offlineReady)location.reload();}
function start(){
  if(loading)return;if(updater){void updater.check();return;}
  loading=true;button.disabled=true;label.textContent='Connecting to download the app files…';
  const id=++attempt,script=document.createElement('script');let settled=false;
  const timer=setTimeout(()=>finish(false),15000);
  function finish(ok){
    if(settled||id!==attempt)return;settled=true;clearTimeout(timer);loading=false;
    script.onload=null;script.onerror=null;script.remove();
    if(ok&&window.LiftLogUpdates){updater=window.LiftLogUpdates;updater.configure({canReload:()=>true,onStatus:show});}
    else{button.disabled=false;label.textContent='Could not connect. Reconnect to the internet and tap Retry download. Your saved workouts have not been changed.';}
  }
  script.src=new URL('./updates.js?__liftlog_update=recovery-'+Date.now(),${JSON.stringify(scope)}).href;
  script.onload=()=>finish(true);script.onerror=()=>finish(false);document.head.appendChild(script);
}
button.addEventListener('click',start);window.addEventListener('online',start);start();})();</script></html>`;
  return new Response(html, {status: 503, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
}

// Share simultaneous navigation checks, but re-read the cache on later opens:
// browser eviction or corruption must not be hidden by a stale success flag.
let navigationVerification = null;
function verifiedNavigation() {
  if (!navigationVerification) navigationVerification = bounded(verifyCache(), 8000, "timeout").finally(() => { navigationVerification = null; });
  return navigationVerification;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== new URL(scope).origin || !url.href.startsWith(scope)) return;
  if (url.searchParams.has(UPDATE_MARKER)) {
    // A probe must reach the server; neither cached HTML nor old cached JS may
    // masquerade as a successful update download.
    event.respondWith(fetch(request, {cache: "no-store"}));
    return;
  }
  url.search = "";
  url.hash = "";
  const key = request.mode === "navigate" ? new URL("./index.html", scope).href : url.href;
  if (request.mode !== "navigate" && !assetURLs.has(key)) return;
  event.respondWith((async () => {
    if (request.mode === "navigate") {
      try { const index = await verifiedNavigation(); return new Response(index.bytes, {status: 200, headers: index.headers}); }
      catch (_) { return recoveryPage(); }
    }
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    // Never mix an incomplete/evicted shell with a newer release from network.
    // A failed asset is explicit and updates.js can reinstall on the next load.
    return cached || new Response("LiftLog offline files are unavailable. Reopen while online.", {status: 503, headers: {"content-type": "text/plain"}});
  })());
});
