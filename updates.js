/* Automatic, guarded Home Screen app updates. No workout data is read or changed. */
(() => {
  "use strict";
  const MARKER = "__liftlog_update";
  const CHECK_INTERVAL = 5 * 60 * 1000;
  const RETRY_DELAYS = [5000, 15000];
  const scope = new URL("./", document.baseURI).href;
  const workerURL = new URL("./sw.js", scope).href;
  const ERROR_CODES = new Set(["network", "timeout", "http", "mime", "empty", "manifest", "hash", "storage", "registration", "install", "control", "unsupported"]);
  let options = null, registration = null, checking = null, lastCheck = 0;
  let pendingReload = false, prepared = null, unlockTimer = null, reloading = false;
  let hasController = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
  let offlineReady = false, targetScriptURL = null, failed = false, retries = 0, retryTimer = null;
  const watchedRegistrations = new WeakSet(), watchedWorkers = new WeakSet();
  const requests = new Map(), installErrors = new Map();
  let requestSequence = 0, lastStatus = null;

  function failure(code, asset = "") { const error = new Error(code); error.code = code; error.asset = asset; return error; }
  function safeError(error, fallback = "network") {
    return {errorCode: ERROR_CODES.has(error && error.code) ? error.code : error && error.name === "AbortError" ? "timeout" : fallback,
      asset: error && typeof error.asset === "string" && /^\.\/[a-zA-Z0-9_./-]+$/.test(error.asset) && !error.asset.includes("..") ? error.asset : ""};
  }
  function status(state, detail = "", metadata = {}) {
    lastStatus = {state, detail, stage: state, completed: 0, total: 0, bytes: 0, errorCode: "", asset: "", retryable: false, offlineReady, ...metadata};
    if (options && options.onStatus) options.onStatus({...lastStatus});
  }
  function bounded(work, duration, code, onTimeout) {
    let timer;
    return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { if (onTimeout) onTimeout(); reject(failure(code)); }, duration); })]).finally(() => clearTimeout(timer));
  }
  function canReload() { try { return Boolean(options && options.canReload && options.canReload()); } catch (_) { return false; } }
  function cancelPreparation(token) {
    if (token && token !== prepared) return;
    prepared = null; clearTimeout(unlockTimer); unlockTimer = null;
    if (options && options.cancelUpdate) options.cancelUpdate();
  }
  async function prepare(token, expiresAt) {
    if (!canReload() || Date.now() >= expiresAt || (prepared && prepared !== token)) return false;
    prepared = token;
    try {
      const safe = options.prepareForUpdate ? await options.prepareForUpdate() : true;
      if (!safe || Date.now() >= expiresAt || !canReload()) { cancelPreparation(token); return false; }
      prepared = token;
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => cancelPreparation(token), 15000);
      return true;
    } catch (_) { cancelPreparation(); return false; }
  }
  async function reloadWhenSafe() {
    if (!pendingReload || reloading || !canReload()) return;
    if (!prepared && !await prepare("controller-change", Date.now() + 6000)) return;
    if (!canReload()) { cancelPreparation(); return; }
    reloading = true;
    status("updating", "Opening the latest version. Your workouts stay saved.", {stage: "activating"});
    location.reload();
  }
  function requestActivation() {
    const waiting = registration && registration.waiting;
    const controller = navigator.serviceWorker.controller;
    if (waiting && waiting.state === "installed" && (!controller || waiting.scriptURL !== controller.scriptURL)) {
      status("waiting", "An update is ready. It will open when workouts and edits are finished.");
      waiting.postMessage({type: "LIFTLOG_ACTIVATE_IF_SAFE"});
    }
  }
  function watchRegistration(value) {
    registration = value;
    const watch = worker => {
      if (!worker || watchedWorkers.has(worker)) return;
      watchedWorkers.add(worker);
      worker.addEventListener("statechange", () => { if (worker.state === "installed") requestActivation(); });
    };
    watch(value.installing);
    if (!watchedRegistrations.has(value)) {
      watchedRegistrations.add(value);
      value.addEventListener("updatefound", () => watch(value.installing));
    }
    requestActivation();
  }
  function responseError(response, path) {
    if (!response.ok || response.status !== 200 || response.type === "opaque" || response.redirected) return "http";
    const type = response.headers.get("content-type") || "";
    if (/\.js$/.test(path) && !/(?:javascript|ecmascript)/i.test(type)) return "mime";
    if (/\.css$/.test(path) && !/text\/css/i.test(type)) return "mime";
    if (/\.html$/.test(path) && !/text\/html/i.test(type)) return "mime";
    if (/\.json$/.test(path) && !/(?:application\/json|text\/json)/i.test(type)) return "mime";
    return "";
  }
  async function digest(bytes) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async function probeAsset(path, probe) {
    const url = new URL(path, scope); url.searchParams.set(MARKER, probe);
    const controller = new AbortController();
    try {
      return await bounded((async () => {
        const response = await fetch(url.href, {cache: "no-store", credentials: "same-origin", signal: controller.signal});
        const code = responseError(response, path);
        if (code) throw failure(code, path);
        const bytes = await response.arrayBuffer();
        if (!bytes.byteLength) throw failure("empty", path);
        return {path, hash: await digest(bytes), size: bytes.byteLength, bytes: path === "./sw.js" ? bytes : null};
      })(), 15000, "timeout", () => controller.abort());
    } catch (error) { throw failure(safeError(error).errorCode, path); }
  }
  async function mapLimited(values, task) {
    const results = new Array(values.length); let next = 0, stopped = false;
    let firstError;
    await Promise.all(Array.from({length: Math.min(3, values.length)}, async () => {
      while (!stopped && next < values.length) { const index = next++; try { results[index] = await task(values[index]); } catch (error) { stopped = true; if (!firstError) firstError = error; } }
    }));
    if (firstError) throw firstError;
    return results;
  }
  function verifyWorker(worker) {
    if (!worker || !worker.scriptURL.startsWith(workerURL + "?release=")) return Promise.reject(failure("control"));
    const requestId = String(Date.now()) + ":" + (++requestSequence);
    const release = new URL(worker.scriptURL).searchParams.get("release");
    const reply = new Promise((resolve, reject) => {
      requests.set(requestId, {scriptURL: worker.scriptURL, release, resolve, reject});
      worker.postMessage({type: "LIFTLOG_VERIFY_CACHE", requestId, release});
    });
    return bounded(reply, 10000, "timeout").finally(() => requests.delete(requestId));
  }
  function installedWorker(value, scriptURL) {
    return [value.installing, value.waiting, value.active].find(worker => worker && worker.scriptURL === scriptURL && ["installed", "activating", "activated"].includes(worker.state));
  }
  function waitForInstall(value, scriptURL) {
    let timer, watched = new WeakSet();
    return new Promise((resolve, reject) => {
      const inspect = () => {
        const error = installErrors.get(scriptURL);
        if (error) { clearTimeout(timer); reject(error); return; }
        const ready = installedWorker(value, scriptURL);
        if (ready) { clearTimeout(timer); resolve(ready); return; }
        for (const worker of [value.installing, value.waiting, value.active]) {
          if (!worker || worker.scriptURL !== scriptURL || watched.has(worker)) continue;
          watched.add(worker);
          worker.addEventListener("statechange", () => {
            if (worker.state === "redundant") { clearTimeout(timer); reject(installErrors.get(scriptURL) || failure("install")); }
            else inspect();
          });
          if (worker.state === "redundant") { clearTimeout(timer); reject(failure("install")); }
        }
      };
      timer = setTimeout(() => reject(failure("timeout")), 90000);
      value.addEventListener("updatefound", inspect);
      inspect();
    });
  }
  async function confirmController() {
    const controller = navigator.serviceWorker.controller;
    await verifyWorker(controller);
    if (navigator.serviceWorker.controller !== controller) throw failure("control");
    offlineReady = true;
    return controller;
  }
  function scheduleRetry() {
    if (offlineReady || retryTimer || retries >= RETRY_DELAYS.length || navigator.onLine === false || document.visibilityState !== "visible") return;
    retryTimer = setTimeout(() => { retryTimer = null; if (failed && navigator.onLine !== false && document.visibilityState === "visible") void check(true); }, RETRY_DELAYS[retries]);
  }
  async function check(force = false, manual = false) {
    if (!options || !("serviceWorker" in navigator) || !window.isSecureContext || !crypto.subtle) return;
    if (checking) return checking;
    if (manual) { retries = 0; clearTimeout(retryTimer); retryTimer = null; }
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL && (!failed || offlineReady)) { requestActivation(); return; }
    if (failed && !manual && !offlineReady) {
      if (retries >= RETRY_DELAYS.length) return;
      retries++; clearTimeout(retryTimer); retryTimer = null;
    }
    lastCheck = Date.now();
    checking = (async () => {
      try {
        status("checking", "Checking the app files needed for offline access.");
        const probe = String(Date.now());
        const worker = await probeAsset("./sw.js", probe);
        const manifest = new TextDecoder().decode(worker.bytes).match(/\/\* LIFTLOG_ASSET_MANIFEST_START \*\/\s*(\[[\s\S]*?\])\s*\/\* LIFTLOG_ASSET_MANIFEST_END \*\//);
        if (!manifest) throw failure("manifest");
        let paths; try { paths = JSON.parse(manifest[1]); } catch (_) { throw failure("manifest"); }
        if (!Array.isArray(paths) || paths.length > 128 || paths.length < 3 || paths.some(path => typeof path !== "string" || !/^\.\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes("..")) || new Set(paths).size !== paths.length || !["./index.html", "./updates.js", "./sw.js"].every(path => paths.includes(path))) throw failure("manifest");
        let completed = 1, bytes = worker.size;
        status("checking", "Checking the app files needed for offline access.", {completed, total: paths.length, bytes, asset: "./sw.js"});
        const assets = await mapLimited(paths, async path => {
          if (path === "./sw.js") return worker;
          const asset = await probeAsset(path, probe);
          completed++; bytes += asset.size;
          status("checking", "Checking the app files needed for offline access.", {completed, total: paths.length, bytes, asset: path});
          return asset;
        });
        const release = await digest(new TextEncoder().encode(assets.map(asset => asset.path + ":" + asset.hash).join("\n")));
        const current = await navigator.serviceWorker.getRegistration(scope);
        const currentRelease = current && current.active && new URL(current.active.scriptURL).searchParams.get("release");
        if (current && currentRelease === release) {
          watchRegistration(current);
          try {
            await verifyWorker(current.active);
            if (navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL === current.active.scriptURL) {
              offlineReady = true; failed = false; retries = 0;
              status("current", "Offline app ready.", {stage: "ready", completed: paths.length, total: paths.length, bytes});
              return;
            }
          } catch (_) { offlineReady = false; }
          // The URL must differ to reinstall identical worker bytes after cache eviction.
        }
        const repair = currentRelease === release ? "&repair=" + Date.now() : "";
        targetScriptURL = new URL("./sw.js?release=" + release + repair, scope).href;
        installErrors.delete(targetScriptURL);
        status("downloading", "Downloading app files for offline access.", {total: paths.length});
        let candidate;
        try { candidate = await bounded(navigator.serviceWorker.register(targetScriptURL, {scope, updateViaCache: "none"}), 20000, "timeout"); }
        catch (error) { throw failure(safeError(error, "registration").errorCode); }
        watchRegistration(candidate);
        const installed = await waitForInstall(candidate, targetScriptURL);
        status("verifying", "Verifying the saved offline files.", {total: paths.length});
        await verifyWorker(installed);
        failed = false; retries = 0;
        if (navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL === installed.scriptURL) {
          await confirmController();
          status("current", "Offline app ready.", {stage: "ready", completed: paths.length, total: paths.length, bytes});
        } else if (candidate.waiting) requestActivation();
        else {
          status("activating", "Finishing offline setup.");
          // Installation can finish before Safari assigns the new controller.
          await bounded(new Promise(resolve => {
            const inspect = () => { if (navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL === installed.scriptURL) resolve(); };
            navigator.serviceWorker.addEventListener("controllerchange", inspect, {once: true}); inspect();
          }), 10000, "control");
          await confirmController();
          status("current", "Offline app ready.", {stage: "ready", completed: paths.length, total: paths.length, bytes});
        }
      } catch (error) {
        failed = true;
        const metadata = safeError(error);
        status(offlineReady ? "deferred" : "failed", offlineReady ? "Update could not finish. Your saved offline app is still available." : "Offline setup did not finish. Stay online and retry.", {stage: "error", ...metadata, retryable: true});
        scheduleRetry();
      }
    })().finally(() => { checking = null; });
    return checking;
  }
  function notifySafe() { requestActivation(); void reloadWhenSafe(); }
  function configure(value) {
    if (options) { options = value; return; }
    options = value;
    if (!("serviceWorker" in navigator) || !window.isSecureContext || !crypto.subtle) { status("unavailable", "Offline installation requires a supported secure browser.", {stage: "error", errorCode: "unsupported"}); return; }
    navigator.serviceWorker.addEventListener("message", async event => {
      const message = event.data || {};
      if (!event.source || !event.source.scriptURL || !event.source.scriptURL.startsWith(workerURL + "?release=")) return;
      const sourceRelease = new URL(event.source.scriptURL).searchParams.get("release");
      if (message.type === "LIFTLOG_CACHE_VERIFIED") {
        const request = requests.get(message.requestId);
        if (request && request.scriptURL === event.source.scriptURL && request.release === message.release) {
          if (message.ok === true) request.resolve(); else request.reject(failure(ERROR_CODES.has(message.errorCode) ? message.errorCode : "storage"));
        }
        return;
      }
      if (message.type === "LIFTLOG_INSTALL_STATUS") {
        if (event.source.scriptURL !== targetScriptURL || message.release !== sourceRelease) return;
        if (message.stage === "error") installErrors.set(targetScriptURL, failure(ERROR_CODES.has(message.errorCode) ? message.errorCode : "install", safeError(message).asset));
        else if (checking && ["downloading", "caching", "verifying"].includes(message.stage) && Number.isInteger(message.completed) && Number.isInteger(message.total) && message.total > 0 && message.total <= 128 && message.completed >= 0 && message.completed <= message.total && Number.isFinite(message.bytes) && message.bytes >= 0) {
          status(message.stage, message.stage === "caching" ? "Saving app files for offline access." : message.stage === "verifying" ? "Verifying the saved offline files." : "Downloading app files for offline access.", {stage: message.stage, completed: message.completed, total: message.total, bytes: message.bytes, asset: safeError(message).asset});
        }
        return;
      }
      const controller = navigator.serviceWorker.controller;
      if (controller && event.source.scriptURL === controller.scriptURL) return;
      if (message.type === "LIFTLOG_PREPARE_UPDATE") {
        const safe = await prepare(message.token, message.expiresAt);
        event.source.postMessage({type: "LIFTLOG_UPDATE_APPROVAL", token: message.token, safe});
      }
      if (message.type === "LIFTLOG_CANCEL_UPDATE" && message.token === prepared) { cancelPreparation(message.token); status("waiting", "Update ready; your current workout or edit is protected."); }
      if (message.type === "LIFTLOG_UPDATE_ACTIVATING" && message.token === prepared) status("updating", "Opening the latest version. Your workouts stay saved.", {stage: "activating"});
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hasController) {
        hasController = true; cancelPreparation();
        void confirmController().then(() => { failed = false; status("current", "Offline app ready.", {stage: "ready"}); }).catch(error => {
          failed = true; status("failed", "Offline setup did not finish. Stay online and retry.", {stage: "error", ...safeError(error, "control"), retryable: true}); scheduleRetry();
        });
        return;
      }
      pendingReload = true; void reloadWhenSafe();
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { void check(); notifySafe(); } });
    window.addEventListener("online", () => { if (offlineReady || !failed || retries < RETRY_DELAYS.length) void check(true); });
    // Verify an existing installation even when the network is unavailable.
    navigator.serviceWorker.getRegistration(scope).then(async value => {
      if (value) watchRegistration(value);
      const initialController = navigator.serviceWorker.controller;
      if (initialController) {
        try { await confirmController(); if (!checking) status("current", "Offline app ready.", {stage: "ready"}); }
        catch (_) { if (navigator.serviceWorker.controller === initialController) offlineReady = false; }
      }
    }).catch(() => {});
    void check(true);
  }
  window.LiftLogUpdates = {configure, check: () => check(true, true), notifySafe, getStatus: () => lastStatus && ({...lastStatus})};
})();
