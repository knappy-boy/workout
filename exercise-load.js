/* Load labels and optional estimates. Raw logged weight stays in kilograms. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiftLogExerciseLoad = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MODES = Object.freeze(['external', 'bodyweight', 'assisted', 'weighted']);
  const LABELS = { external: 'Weight', bodyweight: 'Bodyweight', assisted: 'Assistance', weighted: 'Added weight' };
  const validMode = value => MODES.includes(value);
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
  const numeric = value => (typeof value === 'number' || typeof value === 'string')
    && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const nonnegative = value => { const n = numeric(value); return n !== null && n >= 0 ? n : null; };
  const positive = value => { const n = numeric(value); return n !== null && n > 0 ? n : null; };

  function resolveMode(exercise) {
    return validMode(exercise?.loadType) ? exercise.loadType : exercise?.isAssisted === true ? 'assisted' : 'external';
  }

  function resolveSetMode(set, exercise) {
    // The library's current loadType is a default for NEW sets, never a history migration.
    // Editors must preserve an existing exercise's legacy isAssisted flag unchanged.
    return validMode(set?.loadType) ? set.loadType : exercise?.isAssisted === true ? 'assisted' : 'external';
  }

  function validCalendarDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const check = new Date(0);
    check.setUTCFullYear(year, month - 1, day);
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  }

  function timestamp(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value !== 'string' || !validCalendarDay(value.slice(0, 10))) return null;
    if (value.length === 10) {
      // A date-only reading belongs to this local calendar day, not UTC midnight.
      const [year, month, day] = value.split('-').map(Number);
      const local = new Date(0);
      local.setFullYear(year, month - 1, day);
      local.setHours(0, 0, 0, 0);
      return local.getTime();
    }
    if (value[10] !== 'T') return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }

  function latestBodyweight(readings, workoutStart) {
    const cutoff = timestamp(workoutStart);
    if (!Array.isArray(readings) || cutoff === null) return null;
    let result = null, latest = -Infinity;
    for (const reading of readings) {
      if (!reading || typeof reading.date !== 'string') continue;
      const kg = positive(reading.kg), time = timestamp(reading.date);
      if (kg === null || time === null || time > cutoff || time < latest) continue;
      // Equal timestamps use the last stored reading; do not sort or mutate the collection.
      latest = time;
      result = { kg, date: reading.date };
      if (validId(reading.id)) result.sourceId = reading.id;
    }
    return result;
  }

  function estimatedLoad(set) {
    // No exercise lookup and no current bodyweight: historical estimates use snapshots only.
    if (!set || !validMode(set.loadType)) return null;
    const weight = nonnegative(set.w);
    if (set.loadType === 'external') return weight;
    const bodyweight = positive(set.bodyweightKg);
    if (bodyweight === null) return null;
    if (set.loadType === 'bodyweight') return bodyweight;
    if (weight === null) return null;
    const estimate = set.loadType === 'assisted' ? bodyweight - weight : bodyweight + weight;
    return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    return value;
  }

  function snapshotSet(set, mode, bodyweightSnapshot) {
    if (!validMode(mode)) throw new TypeError('Choose a supported exercise load type.');
    if (!set || typeof set !== 'object' || Array.isArray(set)) throw new TypeError('A workout set must be an object.');
    // For new rows or an explicit resnapshot only. Edits to historical sets keep their own metadata.
    const result = clone(set);
    result.loadType = mode;
    for (const key of ['bodyweightKg', 'bodyweightDate', 'bodyweightSourceId']) delete result[key];
    if (mode === 'bodyweight') result.w = 0;
    const kg = positive(bodyweightSnapshot?.kg);
    if (mode !== 'external' && kg !== null && typeof bodyweightSnapshot?.date === 'string'
      && timestamp(bodyweightSnapshot.date) !== null) {
      result.bodyweightKg = kg;
      result.bodyweightDate = bodyweightSnapshot.date;
      if (validId(bodyweightSnapshot.sourceId)) result.bodyweightSourceId = bodyweightSnapshot.sourceId;
    }
    return result;
  }

  function rawLabel(mode) { return validMode(mode) ? LABELS[mode] : LABELS.external; }

  return { MODES, resolveMode, resolveSetMode, latestBodyweight, estimatedLoad, snapshotSet, rawLabel };
});
