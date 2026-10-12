/* LiftLog durable storage. Keep this database name stable across app releases. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LiftLogStorage = api.createStorage(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const LEGACY_KEY = "liftlog_ultra_v1";
  const DATABASE_NAME = "liftlog-durable";
  const SCHEMA_VERSION = 1;
  const MISSING = Symbol("missing");
  const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
  const BASE_DEFAULTS = {
    user: { theme: "light", increment: 2.5, useLbs: false, showSuggestions: false,
      includeCompound: true, trainingGoal: "hypertrophy", bodyweight: null },
    exercises: {}, templates: {}, sessions: [], bodyweight: [], goals: {}
  };

  class StorageError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "LiftLogStorageError";
      this.code = code;
      if (cause) this.cause = cause;
    }
  }
  const fail = (message) => { throw new StorageError("VALIDATION", message); };
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  function safeJSON(value, path = "data", depth = 0) {
    if (depth > 40) fail(`${path} is nested too deeply.`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => safeJSON(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail(`${path} must contain ordinary JSON values.`);
    }
    for (const key of Object.keys(value)) {
      if (BAD_KEYS.has(key)) fail(`${path} contains an unsafe key.`);
      safeJSON(value[key], `${path}.${key}`, depth + 1);
    }
  }
  function id(value, path) {
    if (typeof value !== "string" || !ID_PATTERN.test(value) || BAD_KEYS.has(value)) fail(`${path} has an invalid ID.`);
  }
  function object(value, path) { if (!record(value)) fail(`${path} must be an object.`); }
  function array(value, path) { if (!Array.isArray(value)) fail(`${path} must be a list.`); }
  function optionalString(value, path) {
    if (value !== undefined && value !== null && typeof value !== "string") fail(`${path} must be text.`);
  }
  function date(value, path) {
    if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) fail(`${path} has an invalid date.`);
  }
  function numeric(value, path, allowEmpty = false) {
    if (allowEmpty && (value === "" || value === null)) return;
    if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0) {
      fail(`${path} must be a non-negative number.`);
    }
  }
  function optionalLoadType(value, path) {
    if (value !== undefined && !["external", "bodyweight", "assisted", "weighted"].includes(value)) {
      fail(`${path} has an unsupported exercise load type.`);
    }
  }
  function validateLoadSnapshot(set, path) {
    optionalLoadType(set.loadType, `${path}.loadType`);
    if (set.bodyweightKg !== undefined && set.bodyweightKg !== null) {
      numeric(set.bodyweightKg, `${path}.bodyweightKg`);
      if (Number(set.bodyweightKg) <= 0) fail(`${path}.bodyweightKg must be positive.`);
    }
    if (set.bodyweightDate !== undefined && set.bodyweightDate !== null) {
      date(set.bodyweightDate, `${path}.bodyweightDate`);
      const day = set.bodyweightDate.slice(0, 10);
      const parts = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.split("-").map(Number) : [];
      const check = new Date(0);
      check.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
      if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() !== parts[1] - 1 || check.getUTCDate() !== parts[2]
        || (set.bodyweightDate.length > 10 && set.bodyweightDate[10] !== "T")) {
        fail(`${path}.bodyweightDate has an invalid date.`);
      }
    }
    if (set.bodyweightSourceId !== undefined && set.bodyweightSourceId !== null) id(set.bodyweightSourceId, `${path}.bodyweightSourceId`);
  }
  function validateSession(session, path, draft = false) {
    object(session, path);
    id(session.id, `${path}.id`);
    date(session.start, `${path}.start`);
    if (session.bodyweightSnapshot !== undefined && session.bodyweightSnapshot !== null) {
      const snapshot = session.bodyweightSnapshot, snapshotPath = `${path}.bodyweightSnapshot`;
      object(snapshot, snapshotPath);
      numeric(snapshot.kg, `${snapshotPath}.kg`);
      date(snapshot.date, `${snapshotPath}.date`);
      validateLoadSnapshot({ bodyweightKg: snapshot.kg, bodyweightDate: snapshot.date,
        bodyweightSourceId: snapshot.sourceId }, snapshotPath);
    }
    if (session.end !== undefined && session.end !== null) date(session.end, `${path}.end`);
    ["name", "notes", "templateName"].forEach(key => optionalString(session[key], `${path}.${key}`));
    if (session.templateId !== undefined && session.templateId !== null) id(session.templateId, `${path}.templateId`);
    object(session.entries, `${path}.entries`);
    for (const [exId, sets] of Object.entries(session.entries)) {
      id(exId, `${path}.entries`);
      array(sets, `${path}.entries.${exId}`);
      sets.forEach((set, index) => {
        const itemPath = `${path}.entries.${exId}[${index}]`;
        object(set, itemPath);
        for (const key of ["w", "r", "time", "dist"]) {
          if (own(set, key)) numeric(set[key], `${itemPath}.${key}`, true);
        }
        for (const key of ["note", "type"]) optionalString(set[key], `${itemPath}.${key}`);
        validateLoadSnapshot(set, itemPath);
        if (!["w", "r", "time", "dist"].some(key => own(set, key))) fail(`${itemPath} is not a workout set.`);
      });
    }
    if (session.order !== undefined) {
      array(session.order, `${path}.order`);
      session.order.forEach(exId => id(exId, `${path}.order`));
      if (new Set(session.order).size !== session.order.length) fail(`${path}.order has duplicate exercises.`);
    }
    // Draft editor fields may contain partially typed input; committed entries above stay validated.
    if (!draft && session.end && Date.parse(session.end) < Date.parse(session.start)) fail(`${path} ends before it starts.`);
  }
  function validateDB(value) {
    safeJSON(value);
    object(value, "data");
    object(value.exercises, "data.exercises");
    array(value.sessions, "data.sessions");
    if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) {
      throw new StorageError("UNSUPPORTED", "This data needs a newer version of LiftLog.");
    }
    for (const [exId, ex] of Object.entries(value.exercises)) {
      id(exId, "data.exercises"); object(ex, `exercise ${exId}`);
      if (ex.id !== exId) fail(`Exercise ${exId} has a mismatched ID.`);
      if (typeof ex.name !== "string" || !ex.name.trim()) fail(`Exercise ${exId} needs a name.`);
      if (!["strength", "cardio"].includes(ex.type)) fail(`Exercise ${exId} has an unsupported type.`);
      optionalLoadType(ex.loadType, `exercise ${exId}.loadType`);
      for (const key of ["muscle", "equip", "cardioMetric", "cardioGoal"]) optionalString(ex[key], `exercise ${exId}.${key}`);
      if (ex.increment !== undefined && ex.increment !== null) numeric(ex.increment, `exercise ${exId}.increment`);
      for (const key of ["isAssisted", "isCompound"]) {
        if (ex[key] !== undefined && typeof ex[key] !== "boolean") fail(`Exercise ${exId}.${key} must be true or false.`);
      }
      if (ex.secondaryMuscles !== undefined) {
        array(ex.secondaryMuscles, `exercise ${exId}.secondaryMuscles`);
        ex.secondaryMuscles.forEach(muscle => optionalString(muscle, `exercise ${exId}.secondaryMuscles`));
      }
    }
    if (value.templates !== undefined) {
      object(value.templates, "data.templates");
      for (const [templateId, template] of Object.entries(value.templates)) {
        id(templateId, "data.templates"); object(template, `routine ${templateId}`);
        if (template.id !== templateId) fail(`Routine ${templateId} has a mismatched ID.`);
        if (typeof template.name !== "string" || !template.name.trim()) fail(`Routine ${templateId} needs a name.`);
        array(template.exercises, `routine ${templateId}.exercises`);
        template.exercises.forEach(item => {
          object(item, `routine ${templateId}.exercise`); id(item.exId, `routine ${templateId}.exercise`);
          if (item.sets !== undefined) numeric(item.sets, `routine ${templateId}.sets`);
        });
      }
    }
    const sessionIds = new Set();
    value.sessions.forEach((session, index) => {
      validateSession(session, `workout ${index + 1}`);
      if (sessionIds.has(session.id)) fail(`Duplicate workout ID ${session.id}.`);
      sessionIds.add(session.id);
    });
    if (value.bodyweight !== undefined) {
      array(value.bodyweight, "data.bodyweight");
      value.bodyweight.forEach((entry, index) => {
        object(entry, `bodyweight ${index + 1}`); date(entry.date, `bodyweight ${index + 1}`);
        numeric(entry.kg, `bodyweight ${index + 1}.kg`);
        if (entry.id !== undefined) id(entry.id, `bodyweight ${index + 1}.id`);
      });
    }
    if (value.goals !== undefined) object(value.goals, "data.goals");
    if (value.user !== undefined) {
      object(value.user, "data.user");
      if (value.user.theme !== undefined && !["light", "dark", "purple"].includes(value.user.theme)) fail("Unknown theme.");
      for (const key of ["useLbs", "showSuggestions", "includeCompound"]) {
        if (value.user[key] !== undefined && typeof value.user[key] !== "boolean") fail(`Setting ${key} must be true or false.`);
      }
      if (value.user.trainingGoal !== undefined && !["hypertrophy", "strength"].includes(value.user.trainingGoal)) fail("Unknown training goal.");
      if (value.user.increment !== undefined) numeric(value.user.increment, "user.increment");
      if (value.user.bodyweight !== undefined && value.user.bodyweight !== null) numeric(value.user.bodyweight, "user.bodyweight");
    }
    return value;
  }

  function migrateDB(value, defaults = BASE_DEFAULTS) {
    validateDB(value);
    safeJSON(defaults);
    const result = clone(value);
    result.user = Object.assign({}, BASE_DEFAULTS.user, defaults.user || {}, result.user || {});
    if (!own(value.user || {}, "useLbs") && value.user && value.user.unit === "lbs") result.user.useLbs = true;
    delete result.user.unit;
    for (const key of ["templates", "bodyweight", "goals"]) {
      if (!own(result, key)) result[key] = clone(BASE_DEFAULTS[key]);
    }
    result.sessions.forEach(session => { if (!session.order) session.order = Object.keys(session.entries); });
    result.sessions.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    return validateDB(result);
  }
  function parseBackupEnvelope(input, defaults = BASE_DEFAULTS) {
    let parsed;
    try { parsed = typeof input === "string" ? JSON.parse(input) : input; }
    catch (cause) { throw new StorageError("VALIDATION", "This backup is not valid JSON. Your saved data has not changed.", cause); }
    safeJSON(parsed);
    object(parsed, "backup");
    let value = parsed, draft = null;
    if (own(parsed, "version") || own(parsed, "data")) {
      if (parsed.version !== 1) throw new StorageError("UNSUPPORTED", "This backup version is not supported. Your saved data has not changed.");
      value = parsed.data;
      if (own(parsed, "draft")) draft = validateDraft(parsed.draft);
    }
    const db = migrateDB(value, defaults);
    if (draft && db.sessions.some(session => session.id === draft.id)) fail("The backup contains the same workout as both unfinished and completed.");
    return { db, draft };
  }
  function parseBackup(input, defaults = BASE_DEFAULTS) {
    return parseBackupEnvelope(input, defaults).db;
  }
  function validateDraft(draft) {
    if (draft === null) return null;
    safeJSON(draft, "draft"); validateSession(draft, "unfinished workout", true);
    return clone(draft);
  }
  function equal(a, b) {
    if (a === b) return true;
    if (a === MISSING || b === MISSING || a === null || b === null || typeof a !== typeof b) return false;
    if (typeof a !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(key => own(b, key) && equal(a[key], b[key]));
  }
  function conflict(path) {
    throw new StorageError("CONFLICT", `Another open LiftLog changed ${path}. Your saved data was kept. Reload the latest data before trying again.`);
  }
  function mergeValue(base, edited, current, path) {
    if (equal(edited, base)) return current;
    if (equal(current, base) || equal(edited, current)) return edited;
    if (record(base) && record(edited) && record(current)) {
      const result = {};
      for (const key of new Set([...Object.keys(base), ...Object.keys(edited), ...Object.keys(current)])) {
        const value = mergeValue(own(base, key) ? base[key] : MISSING, own(edited, key) ? edited[key] : MISSING,
          own(current, key) ? current[key] : MISSING, `${path}.${key}`);
        if (value !== MISSING) result[key] = value;
      }
      return result;
    }
    conflict(path);
  }
  function mergeCollection(base, edited, current, keyOf, path) {
    const map = values => {
      const entries = values.map(value => [keyOf(value), value]);
      if (new Set(entries.map(entry => entry[0])).size !== entries.length) return null;
      return Object.fromEntries(entries);
    };
    const b = map(base), e = map(edited), c = map(current);
    // Legacy bodyweight readings can share a date; never silently collapse them.
    if (!b || !e || !c) return mergeValue(base, edited, current, path);
    return Object.values(mergeValue(b, e, c, path));
  }
  function mergeDB(base, edited, current) {
    validateDB(base); validateDB(edited); validateDB(current);
    const b = clone(base), e = clone(edited), c = clone(current);
    const sessions = mergeCollection(b.sessions, e.sessions, c.sessions, value => value.id, "workouts");
    const bodyweight = mergeCollection(b.bodyweight || [], e.bodyweight || [], c.bodyweight || [], value => value.id || value.date, "bodyweight");
    delete b.sessions; delete e.sessions; delete c.sessions;
    delete b.bodyweight; delete e.bodyweight; delete c.bodyweight;
    const merged = mergeValue(b, e, c, "data");
    merged.sessions = sessions.slice().sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
    merged.bodyweight = bodyweight.slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return validateDB(merged);
  }

  function createStorage(environment, options = {}) {
    const env = environment || globalThis;
    let connection = null;
    let opening = null;
    let defaults = clone(BASE_DEFAULTS);
    let queue = Promise.resolve();
    let channel = null;
    let versionChanged = false;
    let ready = false;
    const listeners = new Set();
    const name = options.databaseName || DATABASE_NAME;
    const legacyKey = options.legacyKey || LEGACY_KEY;
    const notificationKey = `${legacyKey}:changed`;

    const storageError = error => error instanceof StorageError ? error : new StorageError("STORAGE",
      "LiftLog could not save to this device. Keep this page open and export a backup before retrying.", error);
    function enqueue(operation) {
      const pending = queue.then(operation);
      queue = pending.catch(() => {});
      return pending;
    }
    function notify(revision) {
      try { if (channel) { channel.postMessage({ revision }); return; } }
      catch (_) { /* A notification failure must not report a committed save as a failure. */ }
      {
        try { env.localStorage.setItem(notificationKey, JSON.stringify({ revision, at: Date.now(), random: Math.random() })); }
        catch (_) { /* Notifications are optional. Transactions provide the conflict protection. */ }
      }
    }
    function onChange(message) {
      const revision = message && message.revision;
      for (const listener of listeners) {
        try { listener({ revision }); } catch (error) { if (env.console) env.console.error(error); }
      }
    }
    function validateState(value) {
      if (!value || value.schemaVersion !== SCHEMA_VERSION) throw new StorageError("UNSUPPORTED", "Saved data needs a different version of LiftLog. It has not been changed.");
      if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail("Saved data has an invalid revision.");
      if (!Number.isSafeInteger(value.epoch) || value.epoch < 1) fail("Saved data has an invalid generation.");
      validateDB(value.db); validateDraft(value.draft);
      return value;
    }
    function snapshot(value) {
      return clone({ db: value.db, draft: value.draft, revision: value.revision, epoch: value.epoch, updatedAt: value.updatedAt });
    }
    function transact(mode, operation) {
      return new Promise((resolve, reject) => {
        let transaction, result, failure;
        try {
          if (!connection || versionChanged) throw new StorageError("STORAGE", "LiftLog storage is closed. Reload this page before saving.");
          transaction = connection.transaction(["state", "recovery"], mode);
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = () => reject(storageError(failure || transaction.error || new Error("Transaction aborted")));
          transaction.onerror = () => {}; // onabort reports the final failure; do not cancel the abort.
          const state = transaction.objectStore("state");
          const recovery = transaction.objectStore("recovery");
          const request = state.get("active");
          request.onsuccess = () => {
            try { result = operation(request.result, state, recovery, transaction); }
            catch (error) { failure = error; transaction.abort(); }
          };
        } catch (error) { reject(storageError(error)); }
      });
    }
    function mutate(operation) {
      return enqueue(async () => {
        const result = await transact("readwrite", (saved, state, recovery) => {
          validateState(saved);
          const next = operation(clone(saved), recovery);
          validateState(next);
          next.revision = saved.revision + 1;
          next.updatedAt = new Date().toISOString();
          state.put(next, "active");
          return snapshot(next);
        });
        notify(result.revision);
        return result;
      });
    }
    async function open(initialDefaults = BASE_DEFAULTS) {
      if (opening) return opening;
      if (ready && connection) return load();
      if (connection) connection.close();
      defaults = migrateDB(initialDefaults);
      opening = (async () => {
        try {
          if (!env.indexedDB) throw new StorageError("STORAGE", "This browser cannot open LiftLog's offline database. Your existing data has not been changed.");
          connection = await new Promise((resolve, reject) => {
            const request = env.indexedDB.open(name, SCHEMA_VERSION);
            request.onupgradeneeded = () => {
              const database = request.result;
              if (!database.objectStoreNames.contains("state")) database.createObjectStore("state");
              if (!database.objectStoreNames.contains("recovery")) database.createObjectStore("recovery", { keyPath: "id", autoIncrement: true });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new StorageError("STORAGE", "Close other LiftLog windows and retry opening the database."));
          });
          versionChanged = false;
          connection.onversionchange = () => { versionChanged = true; ready = false; connection.close(); onChange({}); };
          const result = await transact("readwrite", (saved, state, recovery) => {
            if (saved) return snapshot(validateState(saved));
            // Read inside the transaction. Never treat unreadable/corrupt legacy storage as an empty account.
            let raw;
            try { raw = env.localStorage.getItem(legacyKey); }
            catch (cause) { throw new StorageError("STORAGE", "Existing LiftLog storage could not be read. Nothing has been replaced.", cause); }
            const migrated = raw === null ? { db: clone(defaults), draft: null } : parseBackupEnvelope(raw, defaults);
            const at = new Date().toISOString();
            if (raw !== null) recovery.add({ kind: "legacy-migration", at, raw });
            const initial = { schemaVersion: SCHEMA_VERSION, revision: 1, epoch: 1, updatedAt: at, db: migrated.db, draft: migrated.draft };
            state.put(initial, "active");
            return snapshot(initial);
          });
          if (typeof env.BroadcastChannel === "function") {
            try {
              channel = new env.BroadcastChannel(`${name}:changes`);
              channel.onmessage = event => onChange(event.data);
            } catch (_) { /* Transactions still protect data without notification support. */ }
          } else if (env.addEventListener) {
            env.addEventListener("storage", event => {
              if (event.key === notificationKey && event.newValue) {
                try { onChange(JSON.parse(event.newValue)); } catch (_) {}
              }
            });
          }
          ready = true;
          opening = null;
          return result;
        } catch (error) {
          // A failed legacy import leaves the empty database open for raw recovery export
          // and an explicit validated restore. Never manufacture a fresh empty account.
          opening = null;
          throw storageError(error);
        }
      })();
      return opening;
    }
    function load() { return enqueue(() => transact("readonly", saved => snapshot(validateState(saved)))); }
    function assertEpoch(saved, options) {
      if (!options || !Number.isSafeInteger(options.epoch)) fail("Reload saved data before making changes.");
      if (saved.epoch !== options.epoch) conflict("data restored in another window");
    }
    function saveDB(edited, base, options) {
      const proposed = migrateDB(edited, defaults), expected = migrateDB(base, defaults);
      return mutate(saved => { assertEpoch(saved, options); saved.db = mergeDB(expected, proposed, saved.db); return saved; });
    }
    function editSession(nextSession, baselineSession, options) {
      safeJSON(nextSession); validateSession(nextSession, "edited workout");
      safeJSON(baselineSession); validateSession(baselineSession, "original workout");
      if (nextSession.id !== baselineSession.id) fail("The edited workout must keep its original ID.");
      const proposed = clone(nextSession), expected = clone(baselineSession);
      const generation = { epoch: options && options.epoch };
      return mutate(saved => {
        assertEpoch(saved, generation);
        const index = saved.db.sessions.findIndex(session => session.id === expected.id);
        // Check the entire workout inside the write transaction, including fields this editor did not change.
        // Unrelated database edits and an unfinished workout are retained from the latest saved state.
        if (index < 0 || !equal(saved.db.sessions[index], expected)) conflict("this completed workout");
        saved.db.sessions[index] = proposed;
        saved.db.sessions.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
        return saved; // mutate validates the complete proposed state before committing it.
      });
    }
    function saveDraft(edited, base, options) {
      const proposed = validateDraft(edited), expected = validateDraft(base);
      return mutate(saved => {
        assertEpoch(saved, options);
        if (!equal(saved.draft, expected) && !equal(saved.draft, proposed)) conflict("the unfinished workout");
        // A stale tab must not resurrect a workout which was already completed elsewhere.
        if (proposed && saved.db.sessions.some(session => session.id === proposed.id)) conflict("this completed workout");
        saved.draft = proposed;
        return saved;
      });
    }
    function finishWorkout(session, baseDraft, options) {
      safeJSON(session); validateSession(session, "completed workout");
      if (!session.end) fail("The completed workout needs an end time.");
      const completed = clone(session), expected = validateDraft(baseDraft);
      if (!expected || completed.id !== expected.id) fail("The completed workout does not match the unfinished workout.");
      return mutate(saved => {
        assertEpoch(saved, options);
        const existing = saved.db.sessions.find(item => item.id === completed.id);
        if (existing && equal(existing, completed) && saved.draft === null) return saved;
        if (!equal(saved.draft, expected)) conflict("the unfinished workout");
        if (existing) conflict("this completed workout");
        saved.db.sessions.unshift(completed);
        saved.db.sessions.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
        saved.draft = null;
        return saved;
      });
    }
    function restore(backup, expectedRevision) {
      const imported = parseBackupEnvelope(backup, defaults); // Validate before entering any write transaction.
      if (!Number.isSafeInteger(expectedRevision)) fail("Reload saved data before restoring a backup.");
      return enqueue(async () => {
        const result = await transact("readwrite", (saved, state, recovery) => {
          if ((saved ? saved.revision : 0) !== expectedRevision) conflict("saved data since you opened the restore dialog");
          const at = new Date().toISOString();
          let legacyRaw = null;
          try { legacyRaw = env.localStorage.getItem(legacyKey); } catch (_) {}
          recovery.add({ kind: "before-restore", at, state: saved ? clone(saved) : null, legacyRaw });
          const next = { schemaVersion: SCHEMA_VERSION, revision: (saved ? saved.revision : 0) + 1,
            epoch: (saved && Number.isSafeInteger(saved.epoch) ? saved.epoch : 0) + 1,
            updatedAt: at, db: imported.db, draft: imported.draft };
          validateState(next);
          state.put(next, "active");
          return snapshot(next);
        });
        notify(result.revision);
        return result;
      });
    }
    function exportRecovery() {
      return enqueue(() => new Promise((resolve, reject) => {
        let transaction;
        function legacyOnly(error) {
          let legacyRaw = null;
          try { legacyRaw = env.localStorage.getItem(legacyKey); }
          catch (_) { reject(storageError(error)); return; }
          resolve({ format: "liftlog-recovery-v1", exportedAt: new Date().toISOString(), current: null,
            recovery: [], legacyRaw, databaseUnavailable: true,
            warning: "The offline database could not be read. This file contains only the readable legacy backup." });
        }
        try {
          if (!connection) { legacyOnly(new Error("The recovery database is not open.")); return; }
          transaction = connection.transaction(["state", "recovery"], "readonly");
          const current = transaction.objectStore("state").get("active");
          const recovery = transaction.objectStore("recovery").getAll();
          transaction.oncomplete = () => {
            let legacyRaw = null;
            try { legacyRaw = env.localStorage.getItem(legacyKey); } catch (_) {}
            resolve(clone({ format: "liftlog-recovery-v1", exportedAt: new Date().toISOString(), current: current.result || null, recovery: recovery.result, legacyRaw }));
          };
          transaction.onabort = () => legacyOnly(transaction.error);
        } catch (error) { legacyOnly(error); }
      }));
    }
    return {
      open, load, saveDB, editSession, saveDraft, finishWorkout, restore, exportRecovery,
      reset: revision => restore(clone(defaults), revision),
      validateBackup: backup => parseBackup(backup, defaults),
      parseBackup: backup => parseBackup(backup, defaults),
      parseBackupEnvelope: backup => parseBackupEnvelope(backup, defaults),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      whenIdle: () => queue,
      close() { if (channel) channel.close(); if (connection) connection.close(); connection = null; opening = null; ready = false; },
      clone, equal, StorageError
    };
  }

  return { createStorage, validateDB, validateDraft, migrateDB, parseBackup, parseBackupEnvelope, mergeDB, equal, clone,
    StorageError, LEGACY_KEY, DATABASE_NAME, SCHEMA_VERSION, BASE_DEFAULTS };
});
