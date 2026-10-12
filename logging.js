/* Pure logger conversions and history selection. Stored strength weights use kg. */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require('./exercise-load.js') : root.LiftLogExerciseLoad);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LiftLogLogging = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Load) {
  const KG_TO_LBS = 2.20462;

  function number(value) {
    const text = String(value ?? "").trim().replace(",", ".");
    return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : null;
  }

  function displayWeight(kg, unit) {
    return unit === "lbs" ? Number((Number(kg) * KG_TO_LBS).toFixed(1)) : Number(Number(kg).toFixed(2));
  }

  function rowsFromSets(exercise, sets, unit) {
    return (sets || []).map(set => exercise.type === "cardio"
      ? { a: String(set.time ?? "0"), b: String(set.dist ?? "0"), originalSet: { ...set } }
      : { a: Load.resolveSetMode(set, exercise) === 'bodyweight' ? '' : String(displayWeight(set.w || 0, unit)), b: String(set.r ?? ""), loadType: Load.resolveSetMode(set, exercise),
        originalKg: set.w ?? 0, originalDisplay: String(displayWeight(set.w || 0, unit)), originalSet: { ...set } });
  }

  function rowsForCopy(exercise, sets, unit) {
    return rowsFromSets(exercise, sets, unit).map(row => {
      if (exercise.type === 'cardio') return { a: row.a, b: row.b };
      // A new workout keeps the previous load and row count, not its completed
      // reps, notes or bodyweight snapshot. Exact kg survives display rounding.
      return { a: row.a, b: '', loadType: row.loadType,
        originalKg: row.originalKg, originalDisplay: row.originalDisplay };
    });
  }

  function hasExerciseWork(session, exId) {
    const draft = session?.logDrafts?.[exId];
    return !!(session?.entries?.[exId]?.length || String(session?.exerciseNotes?.[exId] ?? '').length
      || String(draft?.notes ?? '').length || draft?.rows?.some(row =>
        String(row.a ?? '').trim() || String(row.b ?? '').trim() || row.originalSet));
  }

  function planExerciseSwap(session, sourceId, targetId) {
    const order = [...(session?.order || [])];
    const index = order.indexOf(sourceId);
    if (index < 0 || !targetId || sourceId === targetId) return null;
    const keepSource = hasExerciseWork(session, sourceId);
    // Choosing an existing exercise opens it without moving or duplicating its
    // recorded work, and without removing the exercise the user came from.
    if (order.includes(targetId)) return { order, keepSource: true, alreadyPresent: true };
    order.splice(index + (keepSource ? 1 : 0), keepSource ? 0 : 1, targetId);
    return { order, keepSource, alreadyPresent: false };
  }

  function nextRow(exercise, rows) {
    const previous = rows?.[rows.length - 1];
    const row = { a: '', b: '' };
    const mode = Load.resolveMode(exercise);
    if (exercise.type !== 'cardio' && Load.MODES.includes(exercise.loadType)) row.loadType = mode;
    if (exercise.type === 'cardio' || mode === 'bodyweight' || !previous) return row;
    const previousMode = previous.originalSet ? Load.resolveSetMode(previous.originalSet, exercise) : previous.loadType || mode;
    if (previousMode !== mode) return row;
    row.a = String(previous.a ?? '');
    // Keep an unchanged display value tied to its exact kg value, without copying
    // reps, completion flags, notes, or any other metadata into the new set.
    if (previous.originalKg !== undefined) {
      row.originalKg = previous.originalKg;
      row.originalDisplay = previous.originalDisplay;
    }
    return row;
  }

  function createScrollLock(win, doc) {
    const owners = new Set();
    let saved;
    const remember = (style, properties) => properties.map(property => ({
      property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property)
    }));
    const restore = (style, properties) => properties.forEach(({ property, value, priority }) => {
      if (value) style.setProperty(property, value, priority);
      else style.removeProperty(property);
    });
    return {
      acquire(owner) {
        if (owners.has(owner)) return;
        owners.add(owner);
        if (owners.size > 1) return;
        const body = doc.body.style;
        const html = doc.documentElement.style;
        const x = win.scrollX || 0;
        const y = win.scrollY || 0;
        saved = { x, y,
          body: remember(body, ['position', 'top', 'left', 'width', 'overflow']),
          html: remember(html, ['overflow', 'scroll-behavior']) };
        // iOS can scroll the page behind a drawer despite overflow:hidden alone.
        body.setProperty('position', 'fixed');
        body.setProperty('top', `${-y}px`);
        body.setProperty('left', `${-x}px`);
        body.setProperty('width', '100%');
        body.setProperty('overflow', 'hidden');
        html.setProperty('overflow', 'hidden');
      },
      release(owner) {
        if (!owners.delete(owner) || owners.size || !saved) return;
        const { x, y, body, html } = saved;
        saved = null;
        restore(doc.body.style, body);
        restore(doc.documentElement.style, html);
        doc.documentElement.style.setProperty('scroll-behavior', 'auto');
        win.scrollTo(x, y);
        restore(doc.documentElement.style, html.filter(item => item.property === 'scroll-behavior'));
      }
    };
  }

  function parseRows(exercise, rows, unit, options = {}) {
    const entries = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const original = row.originalSet && typeof row.originalSet === 'object' ? row.originalSet : null;
      const mode = original ? Load.resolveSetMode(original, exercise) : Load.MODES.includes(row.loadType) ? row.loadType
        : Load.MODES.includes(options.loadType) ? options.loadType : Load.resolveMode(exercise);
      const bodyweight = exercise.type !== 'cardio' && mode === 'bodyweight';
      const a = bodyweight ? '' : String(row.a ?? "").trim();
      const b = String(row.b ?? "").trim();
      if (!a && !b) continue;
      const first = bodyweight ? 0 : number(a);
      const second = number(b);
      const cardio = exercise.type === "cardio";
      let reason = "";
      if ((!a && !bodyweight) || !b) reason = cardio
        ? "enter both time and distance; use 0 for a metric you did not track."
        : mode === 'assisted' ? "enter assistance and reps." : mode === 'weighted' ? "enter added weight and reps."
          : bodyweight ? "enter reps." : "enter weight and reps; use 0 for bodyweight sets.";
      else if (first === null || second === null) reason = "use non-negative numbers with one decimal separator.";
      else if (cardio && first === 0 && second === 0) reason = "time or distance must be greater than 0.";
      else if (!cardio && (!Number.isInteger(second) || second <= 0)) reason = "reps must be a positive whole number.";
      if (reason) return { entries: [], error: `Set ${index + 1}: ${reason}`, row: index };
      if (cardio) entries.push({ ...original,
        time: number(original?.time) === first ? original.time : String(first),
        dist: number(original?.dist) === second ? original.dist : String(second) });
      else {
        const unchanged = row.originalKg !== undefined && number(row.originalKg) !== null
          && first === number(row.originalDisplay);
        const kg = bodyweight ? original && number(original.w) === 0 ? original.w : 0
          : unchanged ? row.originalKg : String(unit === "lbs" ? first / KG_TO_LBS : first);
        let set = { ...original, w: kg, r: number(original?.r) === second ? original.r : String(second) };
        // Imported legacy records may represent an unweighted set with no w,
        // a blank string or null. An unchanged displayed zero must not rewrite it.
        if (original && (bodyweight || first === number(row.originalDisplay))) {
          if (Object.hasOwn(original, 'w')) set.w = original.w;
          else delete set.w;
        }
        if (!original && (options.snapshotNew || Load.MODES.includes(row.loadType) || Load.MODES.includes(exercise.loadType))) {
          const snapshot = Object.hasOwn(row, 'bodyweightKg') ? {kg: row.bodyweightKg, date: row.bodyweightDate, sourceId: row.bodyweightSourceId}
            : options.bodyweightSnapshot;
          set = Load.snapshotSet(set, mode, snapshot);
        }
        entries.push(set);
      }
    }
    return { entries, error: null };
  }

  function unchangedDraft(exercise, draft, entries = [], notes = '') {
    if (draft.rows.length !== entries.length || draft.notes !== notes) return false;
    const parsed = parseRows(exercise, draft.rows, draft.unit);
    return !parsed.error && JSON.stringify(parsed.entries) === JSON.stringify(entries);
  }

  function actualSets(exercise, sets) {
    if (!Array.isArray(sets)) return [];
    return sets.filter(set => {
      if (!set || set.completed === false) return false;
      if (exercise.type === "cardio") {
        const time = number(set.time);
        const distance = number(set.dist);
        return (time !== null && time > 0) || (distance !== null && distance > 0);
      }
      const reps = number(set.r);
      const weight = set.w === "" || set.w === undefined || set.w === null ? 0 : number(set.w);
      return weight !== null && reps !== null && Number.isInteger(reps) && reps > 0;
    });
  }

  function sameRoutine(session, context) {
    if (!context) return false;
    if (context.templateId) return session.templateId === context.templateId;
    if (context.templateName) return !session.templateId && session.templateName === context.templateName;
    return !session.templateId && !session.templateName;
  }

  function findLast(exId, exercise, sessions, context = null) {
    const candidates = (sessions || []).filter(session => session.id !== context?.id)
      .map(session => ({ session, sets: actualSets(exercise, session.entries?.[exId]).filter(set => exercise.type === 'cardio'
        || Load.resolveSetMode(set, exercise) === Load.resolveMode(exercise)) }))
      .filter(item => item.sets.length)
      .sort((a, b) => (Date.parse(b.session.start) || 0) - (Date.parse(a.session.start) || 0));
    const match = context && candidates.find(item => sameRoutine(item.session, context));
    const selected = match || candidates[0];
    if (!selected) return null;
    const session = selected.session;
    const previousPosition = (session.order || []).indexOf(exId);
    const currentPosition = (context?.order || []).indexOf(exId);
    const orderChanged = previousPosition >= 0 && currentPosition >= 0
      && JSON.stringify(session.order.slice(0, previousPosition)) !== JSON.stringify(context.order.slice(0, currentPosition));
    return { date: session.start, sets: selected.sets, session, sameRoutine: sameRoutine(session, context),
      orderChanged, previousPosition, currentPosition };
  }

  function formatStrengthSet(set, exercise, unit) {
    const mode = Load.resolveSetMode(set, exercise);
    const load = mode === 'bodyweight' ? 'Bodyweight' : `${displayWeight(set.w || 0, unit)}${unit}${mode === 'assisted' ? ' assistance' : mode === 'weighted' ? ' added' : ''}`;
    return `${load} × ${set.r}`;
  }
  function estimatedSetText(set, unit) {
    const estimate = Load.estimatedLoad(set);
    return set.loadType && set.loadType !== 'external' && estimate !== null ? `≈ ${displayWeight(estimate, unit)}${unit} estimated load` : '';
  }
  function parseBodyweightInput(input, workoutStart) {
    const value = number(input?.value);
    if (value === null || value <= 0) return null;
    const unchanged = number(input.originalKg) > 0 && value === number(input.originalDisplay);
    const result = {kg: unchanged ? Number(input.originalKg) : input.unit === 'lbs' ? value / KG_TO_LBS : value,
      date: unchanged && input.originalDate ? input.originalDate : workoutStart};
    if (unchanged && input.originalSourceId) result.sourceId = input.originalSourceId;
    return result;
  }
  return { displayWeight, rowsFromSets, rowsForCopy, hasExerciseWork, planExerciseSwap, nextRow, createScrollLock, parseRows, unchangedDraft, actualSets, findLast, formatStrengthSet, estimatedSetText, parseBodyweightInput };
});
