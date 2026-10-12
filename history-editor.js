/* Completed-workout editor. Drafts stay separate until the caller commits them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logging.js'), require('./exercise-load.js'));
  else root.LiftLogHistoryEditor = factory(root.LiftLogLogging, root.LiftLogExerciseLoad);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logging, loads) {
  'use strict';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const text = value => String(value ?? '');
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
  }
  function localDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function parseLocalDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text(value));
    if (!match) return NaN;
    const [year, month, day, hour, minute] = match.slice(1).map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : NaN;
  }
  function descriptor(id, exercises, sets) {
    return clone(exercises?.[id] || { id, name: 'Unavailable exercise', type: (sets || []).some(set => own(set, 'time') || own(set, 'dist')) ? 'cardio' : 'strength' });
  }
  function makeItem(id, exercise, sets, notes, unit) {
    const rows = logging.rowsFromSets(exercise, sets || [], unit).map((row, index) => ({ ...clone(row), sourceIndex: index, note: text(sets[index]?.note) }));
    return { id, exercise: clone(exercise), rows, notes: text(notes) };
  }
  function rowMode(row, exercise) {
    return row.originalSet ? loads.resolveSetMode(row.originalSet, exercise)
      : loads.MODES.includes(row.loadType) ? row.loadType : loads.resolveMode(exercise);
  }
  function nextHistoryRow(item) {
    const row = { ...logging.nextRow(item.exercise, item.rows), note: '' };
    delete row.originalSet;
    if (item.exercise.type === 'cardio') return row;
    const previous = item.rows[item.rows.length - 1];
    const source = previous?.originalSet || previous;
    row.loadType = previous ? rowMode(previous, item.exercise) : loads.resolveMode(item.exercise);
    if (previous && row.loadType !== 'bodyweight') {
      row.a = previous.a;
      if (previous.originalKg !== undefined) { row.originalKg = previous.originalKg; row.originalDisplay = previous.originalDisplay; }
    }
    for (const key of ['bodyweightKg', 'bodyweightDate', 'bodyweightSourceId']) {
      delete row[key];
      if (source && loads.MODES.includes(source.loadType) && own(source, key)) row[key] = clone(source[key]);
    }
    if (row.loadType === 'bodyweight') row.a = '';
    return row;
  }
  function rowEstimate(row, exercise, unit) {
    if (exercise.type === 'cardio' || rowMode(row, exercise) === 'external') return '';
    if (row.originalSet && !loads.MODES.includes(row.originalSet.loadType)) return 'No bodyweight snapshot for an estimate.';
    const set = { ...clone(row.originalSet || row), loadType: rowMode(row, exercise) };
    if (set.loadType !== 'bodyweight') {
      const entered = String(row.a ?? '').trim().replace(',', '.');
      const raw = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(entered) ? Number(entered) : NaN;
      if (!Number.isFinite(raw)) return '';
      set.w = row.originalKg !== undefined && row.a === row.originalDisplay ? row.originalKg : unit === 'lbs' ? raw / 2.20462 : raw;
    }
    const estimate = loads.estimatedLoad(set);
    if (estimate === null) return 'No estimate available for this set.';
    return `Estimated load ${logging.displayWeight(estimate, unit)} ${unit} · uses the bodyweight saved with this set.`;
  }
  function editable(draft) {
    return { start: draft.start, durationMinutes: draft.durationMinutes, notes: draft.notes, order: draft.order,
      items: Object.fromEntries(draft.order.map(id => [id, { rows: draft.items[id]?.rows, notes: draft.items[id]?.notes }])) };
  }
  function createDraft(session, exercises = {}, unit = 'kg') {
    if (!session || !validId(session.id) || !logging) throw new Error('A saved workout and the logger helpers are required.');
    const baseline = clone(session);
    const entries = baseline.entries || {};
    const order = [...new Set([...(baseline.order || []), ...Object.keys(entries), ...Object.keys(baseline.exerciseNotes || {})])];
    if (order.some(id => !validId(id))) throw new Error('This workout contains an invalid exercise reference.');
    const duration = baseline.end ? (Date.parse(baseline.end) - Date.parse(baseline.start)) / 60000 : NaN;
    const draft = { baseline, unit: unit === 'lbs' ? 'lbs' : 'kg', start: localDateTime(baseline.start), durationMinutes: Number.isFinite(duration) && duration >= 0 ? String(Math.round(duration)) : '', notes: text(baseline.notes), order, items: {} };
    order.forEach(id => { draft.items[id] = makeItem(id, descriptor(id, exercises, entries[id]), entries[id] || [], baseline.exerciseNotes?.[id], draft.unit); });
    draft.initial = clone(editable(draft));
    return draft;
  }
  function isDirty(draft) { return !equal(editable(draft), draft.initial); }
  function addExercise(draft, id, exercise) {
    if (!validId(id) || !exercise) throw new Error('Choose an available exercise.');
    if (draft.order.includes(id)) return false;
    // Re-adding an exercise removed during this edit restores its local sets/notes.
    if (!draft.items[id]) draft.items[id] = makeItem(id, exercise, [], '', draft.unit);
    draft.order.push(id);
    return true;
  }
  function removeExercise(draft, id) { draft.order = draft.order.filter(value => value !== id); }
  function moveExercise(draft, id, direction) {
    const index = draft.order.indexOf(id), target = index + direction;
    if (![1, -1].includes(direction) || index < 0 || target < 0 || target >= draft.order.length) return false;
    [draft.order[index], draft.order[target]] = [draft.order[target], draft.order[index]];
    return true;
  }
  function moveExerciseTo(draft, id, target) {
    const index = draft.order.indexOf(id);
    if (index < 0 || !Number.isInteger(target) || target < 0 || target >= draft.order.length || target === index) return false;
    draft.order.splice(index, 1);
    draft.order.splice(target, 0, id);
    return true;
  }
  function failure(error, field, exerciseId, row) { return { session: null, error, field, exerciseId, row }; }
  function applyDraft(draft) {
    const next = clone(draft.baseline);
    if (!validId(next?.id) || !Array.isArray(draft.order) || new Set(draft.order).size !== draft.order.length || draft.order.some(id => !validId(id) || !draft.items[id])) return failure('The exercise list is invalid.', 'order');
    const startChanged = draft.start !== draft.initial.start;
    const durationChanged = draft.durationMinutes !== draft.initial.durationMinutes;
    let startMs = Date.parse(next.start);
    if (startChanged) {
      startMs = parseLocalDateTime(draft.start);
      if (!Number.isFinite(startMs)) return failure('Choose a valid workout start date and time.', 'start');
      next.start = new Date(startMs).toISOString();
    }
    if (durationChanged) {
      const value = text(draft.durationMinutes).trim();
      const minutes = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(minutes) || minutes < 0) return failure('Duration must be a whole number of minutes, 0 or more.', 'duration');
      const endMs = startMs + minutes * 60000;
      if (!Number.isFinite(new Date(endMs).getTime())) return failure('That duration is too large.', 'duration');
      next.end = new Date(endMs).toISOString();
    } else if (startChanged && draft.baseline.end != null) {
      const durationMs = Date.parse(draft.baseline.end) - Date.parse(draft.baseline.start);
      const endMs = startMs + durationMs;
      if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(new Date(endMs).getTime())) return failure('Enter a valid duration for this workout.', 'duration');
      next.end = new Date(endMs).toISOString();
    }
    if (draft.notes !== draft.initial.notes) next.notes = text(draft.notes);
    if (!equal(draft.order, draft.initial.order)) next.order = draft.order.slice();
    next.entries ||= {};
    for (const id of draft.initial.order) {
      if (!draft.order.includes(id)) {
        delete next.entries[id];
        if (next.exerciseNotes) delete next.exerciseNotes[id];
        if (next.logDrafts) delete next.logDrafts[id];
      }
    }
    for (const id of draft.order) {
      const item = draft.items[id], initial = draft.initial.items[id];
      if (!initial || !equal(item.rows, initial.rows)) {
        const result = [];
        for (let index = 0; index < item.rows.length; index++) {
          const row = item.rows[index];
          const source = initial?.rows.find(previous => previous.sourceIndex === row.sourceIndex && row.sourceIndex !== undefined);
          // Preserve unchanged legacy sets even when another row is edited.
          if (source && row.a === source.a && row.b === source.b) {
            const entry = clone(row.originalSet);
            if (text(row.note) !== text(row.originalSet?.note)) entry.note = text(row.note);
            result.push(entry); continue;
          }
          const parsed = logging.parseRows(item.exercise, [row], draft.unit);
          if (parsed.error) return failure(`${item.exercise.name}: ${parsed.error.replace(/^Set 1:/, `Set ${index + 1}:`)}`, 'set', id, index);
          if (!parsed.entries.length) {
            if (text(row.note).trim()) return failure(`${item.exercise.name}, set ${index + 1}: enter the set values or remove its note.`, 'set', id, index);
            // Clearing a previously stored row is explicit removal only via its Remove button.
            if (row.originalSet) return failure(`${item.exercise.name}, set ${index + 1}: enter the values or use Remove set.`, 'set', id, index);
            continue;
          }
          const entry = { ...clone(row.originalSet || {}), ...parsed.entries[0] };
          // An untouched legacy metric remains absent rather than gaining a zero.
          if (source) {
            const firstKey = item.exercise.type === 'cardio' ? 'time' : 'w';
            const secondKey = item.exercise.type === 'cardio' ? 'dist' : 'r';
            if (row.a === source.a && !own(source.originalSet, firstKey)) delete entry[firstKey];
            if (row.b === source.b && !own(source.originalSet, secondKey)) delete entry[secondKey];
          }
          if (text(row.note) !== text(row.originalSet?.note)) entry.note = text(row.note);
          result.push(entry);
        }
        next.entries[id] = result;
      }
      if ((!initial && item.notes) || (initial && item.notes !== initial.notes)) {
        next.exerciseNotes ||= {};
        next.exerciseNotes[id] = text(item.notes);
      }
    }
    return { session: next, error: null };
  }
  function validateDraft(draft) { const result = applyDraft(draft); return { error: result.error, field: result.field, exerciseId: result.exerciseId, row: result.row }; }
  function replaceSession(db, nextSession, baseline) {
    if (!nextSession || !baseline || !validId(baseline.id) || nextSession.id !== baseline.id) throw new Error('The workout identity cannot change.');
    const matches = (db.sessions || []).filter(session => session.id === baseline.id);
    if (matches.length !== 1 || !equal(matches[0], baseline)) {
      const error = new Error('This workout changed in another window. Your edits are still here. Close and reopen it to review the latest version.');
      error.code = 'CONFLICT'; throw error;
    }
    const next = clone(db);
    next.sessions = next.sessions.map(session => session.id === baseline.id ? clone(nextSession) : session);
    return next;
  }

  let defaults = {}, active = null;
  function configure(options) { defaults = { ...defaults, ...options }; }
  function open(sessionOrId, options = {}) {
    const deps = { ...defaults, ...options };
    if (active) { active.focus(); return active; }
    const doc = deps.document || globalThis.document;
    const win = deps.window || globalThis.window;
    if (!doc || !win) throw new Error('The history editor needs a document.');
    const session = typeof sessionOrId === 'string' ? deps.getSession?.(sessionOrId) : sessionOrId;
    const exercises = () => deps.getExercises?.() || deps.exercises || {};
    const draft = createDraft(session, exercises(), deps.unit || 'kg');
    const root = doc.createElement('div'); root.id = 'historyEditorModal'; root.className = 'overlay modal he-overlay';
    root.innerHTML = '<section class="he-editor" role="dialog" aria-modal="true" aria-labelledby="historyEditorTitle"><header class="he-header"><h2 id="historyEditorTitle" tabindex="-1">Edit workout</h2><button class="he-close" type="button" aria-label="Close workout editor">×</button></header><div class="he-body drawer-body"></div><footer class="he-footer"><p class="he-error" role="alert"></p><div class="he-footer-actions"><button type="button" class="he-secondary he-cancel">Cancel</button><button type="button" class="he-primary he-save">Save changes</button></div></footer></section>';
    doc.body.appendChild(root);
    const body = root.querySelector('.he-body'), errorBox = root.querySelector('.he-error'), saveButton = root.querySelector('.he-save');
    const oldFocus = doc.activeElement;
    const scrollLock = deps.scrollLock || logging.createScrollLock(win, doc);
    const lockOwner = 'history-editor'; scrollLock.acquire(lockOwner);
    let busy = false, confirming = false, destroyed = false, picking = false;
    let drag = null, dragFrame = null;
    const collapsed = new Set();
    const inputs = new Map();
    const element = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const button = (label, className, action, aria) => { const node = element('button', className, label); node.type = 'button'; if (aria) node.setAttribute('aria-label', aria); node.addEventListener('click', action); return node; };
    const changed = () => { errorBox.textContent = ''; };
    const dragStatus = element('p', 'he-drag-status'); dragStatus.setAttribute('role', 'status'); dragStatus.setAttribute('aria-live', 'polite'); root.appendChild(dragStatus);
    function clearDropMarkers() { body.querySelectorAll('.he-drop-before, .he-drop-after').forEach(node => node.classList.remove('he-drop-before', 'he-drop-after')); }
    function updateDragTarget() {
      if (!drag?.started) return;
      const bounds = body.getBoundingClientRect();
      const inside = drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
      clearDropMarkers();
      const others = [...body.querySelectorAll('.he-exercise')].filter(node => node.dataset.exerciseId !== drag.id);
      if (!inside || !others.length) { drag.target = null; return; }
      let slot = others.findIndex(node => { const rect = node.getBoundingClientRect(); return drag.y < rect.top + rect.height / 2; });
      if (slot < 0) slot = others.length;
      const marker = others[Math.min(slot, others.length - 1)];
      marker.classList.add(slot === others.length ? 'he-drop-after' : 'he-drop-before');
      if (drag.target !== slot) dragStatus.textContent = `${draft.items[drag.id].exercise.name}, position ${slot + 1} of ${draft.order.length}. Release to move; Escape cancels.`;
      drag.target = slot;
    }
    function dragStep() {
      if (!drag?.started) { dragFrame = null; return; }
      const bounds = body.getBoundingClientRect();
      const inWidth = drag.x >= bounds.left - 24 && drag.x <= bounds.right + 24;
      let speed = 0;
      if (inWidth && drag.y < bounds.top + 56) speed = -Math.min(15, (bounds.top + 56 - drag.y) * 0.3);
      else if (inWidth && drag.y > bounds.bottom - 56) speed = Math.min(15, (drag.y - bounds.bottom + 56) * 0.3);
      if (speed) body.scrollTop += speed;
      updateDragTarget();
      dragFrame = win.requestAnimationFrame(dragStep);
    }
    function finishDrag(commit = false) {
      if (!drag) return false;
      const current = drag; drag = null;
      if (dragFrame !== null) { win.cancelAnimationFrame(dragFrame); dragFrame = null; }
      clearDropMarkers(); current.section.classList.remove('he-is-dragging'); current.ghost?.remove(); root.classList.remove('he-reordering');
      try { if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId); } catch (_) { /* The browser may already have cancelled this pointer. */ }
      const moved = commit && current.started && current.target !== null && moveExerciseTo(draft, current.id, current.target);
      if (moved) { changed(); render(`drag:${current.id}`); dragStatus.textContent = `${draft.items[current.id].exercise.name} moved to position ${current.target + 1} of ${draft.order.length}. Save changes to keep this order.`; }
      else if (current.started) dragStatus.textContent = commit ? 'The exercise order is unchanged.' : 'Reordering cancelled. The exercise order is unchanged.';
      return current.started;
    }
    function startDrag(event, id, section, handle) {
      if (busy || confirming || picking || drag || draft.order.length < 2 || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      drag = { id, section, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, started: false, target: null, ghost: null };
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* Document listeners still complete or cancel the gesture. */ }
    }
    function moveDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.started && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
      if (event.cancelable) event.preventDefault();
      if (!drag.started) {
        drag.started = true;
        if (doc.activeElement?.matches('input, textarea')) doc.activeElement.blur();
        drag.section.classList.add('he-is-dragging'); root.classList.add('he-reordering');
        drag.ghost = element('div', 'he-drag-ghost', `↕  ${draft.items[drag.id].exercise.name}`);
        drag.ghost.setAttribute('aria-hidden', 'true'); drag.ghost.style.width = `${Math.min(320, body.clientWidth - 20)}px`; root.appendChild(drag.ghost);
        dragFrame = win.requestAnimationFrame(dragStep);
      }
      const width = Math.min(320, body.clientWidth - 20);
      drag.ghost.style.left = `${Math.max(10, Math.min(win.innerWidth - width - 10, drag.x - width / 2))}px`;
      drag.ghost.style.top = `${drag.y - 24}px`;
      updateDragTarget();
    }
    function endDrag(event) { if (drag && event.pointerId === drag.pointerId) { updateDragTarget(); finishDrag(true); } }
    function cancelDrag(event) { if (drag && (!event || event.pointerId === undefined || event.pointerId === drag.pointerId)) finishDrag(false); }
    function visibilityChanged() { if (doc.hidden) cancelDrag(); }

    function field(label, value, change, config = {}) {
      const wrapper = element('label', `he-field ${config.className || ''}`);
      wrapper.appendChild(element('span', '', label));
      const input = element(config.multiline ? 'textarea' : 'input', 'he-input');
      if (!config.multiline) input.type = config.type || 'text';
      else input.rows = config.rows || 2;
      if (config.inputMode) input.inputMode = config.inputMode;
      input.value = value; input.autocomplete = 'off';
      input.setAttribute('aria-label', config.aria || label);
      input.addEventListener('input', () => { if (!busy) { change(input.value); changed(); } });
      wrapper.appendChild(input);
      if (config.key) inputs.set(config.key, input);
      return wrapper;
    }
    function render(focusKey) {
      cancelDrag();
      const scrollTop = body.scrollTop;
      inputs.clear(); body.replaceChildren();
      const timing = element('section', 'he-section');
      timing.appendChild(element('h3', '', 'Workout details'));
      const times = element('div', 'he-time-fields');
      times.appendChild(field('Started', draft.start, value => { draft.start = value; }, { type: 'datetime-local', key: 'start', className: 'he-start-field' }));
      times.appendChild(field('Duration (minutes)', draft.durationMinutes, value => { draft.durationMinutes = value; }, { inputMode: 'numeric', key: 'duration', className: 'he-duration-field' }));
      timing.appendChild(times);
      timing.appendChild(field('Workout notes', draft.notes, value => { draft.notes = value; }, { multiline: true, key: 'notes' }));
      body.appendChild(timing);
      const heading = element('div', 'he-exercises-heading'); heading.appendChild(element('h3', '', 'Exercises'));
      heading.appendChild(button('+ Exercise', 'he-secondary', pickExercise)); body.appendChild(heading);
      if (!draft.order.length) body.appendChild(element('p', 'he-muted', 'No exercises in this workout.'));
      draft.order.forEach((id, position) => {
        const item = draft.items[id], exercise = item.exercise;
        const section = element('section', 'he-exercise'); section.dataset.exerciseId = id;
        const header = element('div', 'he-exercise-header');
        const titleRow = element('div', 'he-exercise-title-row');
        const handle = button('⠿', 'he-drag-handle', () => {}, `Reorder ${exercise.name}. Drag, or use Up and Down arrow keys.`);
        handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
        handle.disabled = draft.order.length < 2; inputs.set(`drag:${id}`, handle);
        handle.addEventListener('pointerdown', event => startDrag(event, id, section, handle));
        handle.addEventListener('lostpointercapture', cancelDrag);
        handle.addEventListener('keydown', event => {
          if (busy || confirming || picking || drag || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (moveExercise(draft, id, event.key === 'ArrowUp' ? -1 : 1)) {
            changed(); render(`drag:${id}`);
            dragStatus.textContent = `${exercise.name} moved to position ${draft.order.indexOf(id) + 1} of ${draft.order.length}. Save changes to keep this order.`;
          }
        });
        titleRow.appendChild(handle);
        const toggle = button(exercise.name || 'Unavailable exercise', 'he-exercise-title', () => { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render(`toggle:${id}`); });
        toggle.setAttribute('aria-expanded', String(!collapsed.has(id))); inputs.set(`toggle:${id}`, toggle); titleRow.appendChild(toggle); header.appendChild(titleRow);
        const actions = element('div', 'he-exercise-actions');
        actions.append(button('×', 'he-icon he-remove-exercise', async () => {
          if (busy || confirming) return;
          if (item.rows.length || item.notes) { if (!await confirm('Remove exercise?', `Remove ${exercise.name} and its sets and notes from this workout?`)) return; }
          removeExercise(draft, id); changed(); render();
        }, `Remove ${exercise.name} from workout`)); titleRow.appendChild(actions); section.appendChild(header);
        const contents = element('div', 'he-exercise-body'); contents.hidden = collapsed.has(id);
        item.rows.forEach((row, index) => {
          const set = element('div', 'he-set');
          const setHeading = element('div', 'he-set-heading'); setHeading.appendChild(element('strong', '', `Set ${index + 1}`));
          setHeading.appendChild(button('×', 'he-icon', async () => {
            if (busy || confirming) return;
            if ((row.a || row.b || row.note) && !await confirm('Remove set?', `Remove set ${index + 1} from ${exercise.name}?`)) return;
            item.rows.splice(index, 1); changed(); render();
          }, `Remove set ${index + 1} from ${exercise.name}`)); set.appendChild(setHeading);
          const values = element('div', 'he-set-values');
          const mode = rowMode(row, exercise);
          const first = exercise.type === 'cardio' ? 'Time (minutes)' : `${loads.rawLabel(mode)} (${draft.unit})`;
          const second = exercise.type === 'cardio' ? `Distance (${exercise.cardioMetric || 'km'})` : 'Reps';
          const estimate = element('p', 'he-load-estimate', rowEstimate(row, exercise, draft.unit));
          if (exercise.type === 'cardio' || mode !== 'bodyweight') values.appendChild(field(first, row.a, value => { row.a = value; estimate.textContent = rowEstimate(row, exercise, draft.unit); }, { inputMode: 'decimal', aria: `${exercise.name}, set ${index + 1}: ${first}`, key: `set:${id}:${index}` }));
          else { values.classList.add('he-reps-only'); setHeading.appendChild(element('span', 'he-load-type', 'Bodyweight')); }
          values.appendChild(field(second, row.b, value => { row.b = value; }, { inputMode: exercise.type === 'cardio' ? 'decimal' : 'numeric', aria: `${exercise.name}, set ${index + 1}: ${second}`, key: mode === 'bodyweight' ? `set:${id}:${index}` : undefined }));
          set.appendChild(values);
          if (exercise.type !== 'cardio' && mode !== 'external') set.appendChild(estimate);
          set.appendChild(field('Set note', row.note, value => { row.note = value; }, { aria: `${exercise.name}, set ${index + 1}: note`, className: 'he-set-note' })); contents.appendChild(set);
        });
        contents.appendChild(button('+ Set', 'he-secondary he-add-set', () => { if (busy) return; item.rows.push(nextHistoryRow(item)); changed(); render(`set:${id}:${item.rows.length - 1}`); }));
        contents.appendChild(field('Exercise notes', item.notes, value => { item.notes = value; }, { multiline: true, aria: `${exercise.name}: exercise notes`, className: 'he-exercise-notes' }));
        section.appendChild(contents); body.appendChild(section);
      });
      body.scrollTop = scrollTop;
      if (focusKey && inputs.has(focusKey)) {
        const target = inputs.get(focusKey); target.focus({ preventScroll: true });
        if (focusKey.startsWith('drag:')) {
          const bounds = body.getBoundingClientRect(), rect = target.getBoundingClientRect();
          if (rect.top < bounds.top + 8 || rect.bottom > bounds.bottom - 8) body.scrollTop += rect.top - bounds.top - 12;
        }
      }
    }
    async function confirm(title, message) {
      if (confirming || busy) return false;
      confirming = true;
      try { return Boolean(deps.confirm ? await deps.confirm(title, message) : win.confirm(`${title}\n${message}`)); }
      finally { confirming = false; }
    }
    function otherOverlayOpen() { return Boolean(doc.querySelector('.overlay:not(.hidden):not(#historyEditorModal), dialog[open]')); }
    function resumePicker() {
      if (!picking || otherOverlayOpen()) return;
      picking = false; root.inert = false;
      const target = root.querySelector('.he-exercises-heading button'); target?.focus();
    }
    const pickerObserver = new win.MutationObserver(() => { if (picking) win.requestAnimationFrame(resumePicker); });
    pickerObserver.observe(doc.body, { attributes: true, attributeFilter: ['class', 'open'], childList: true, subtree: true });
    function pickExercise() {
      if (busy || !deps.openExercisePicker) { if (!deps.openExercisePicker) errorBox.textContent = 'The exercise picker is unavailable.'; return; }
      picking = true; root.inert = true;
      try { deps.openExercisePicker(id => {
        if (destroyed) return;
        const exercise = exercises()[id];
        if (!exercise) { errorBox.textContent = 'That exercise is no longer available.'; }
        else { addExercise(draft, id, exercise); collapsed.delete(id); changed(); render(); }
        // The shared picker hides itself after this callback returns.
        win.requestAnimationFrame(resumePicker);
      }, () => win.requestAnimationFrame(resumePicker)); }
      catch (error) { picking = false; root.inert = false; errorBox.textContent = error?.message || 'The exercise picker could not open.'; }
    }
    function destroy(saved) {
      if (destroyed) return;
      cancelDrag();
      doc.removeEventListener('pointermove', moveDrag); doc.removeEventListener('pointerup', endDrag); doc.removeEventListener('pointercancel', cancelDrag); doc.removeEventListener('visibilitychange', visibilityChanged); win.removeEventListener('blur', cancelDrag);
      destroyed = true; pickerObserver.disconnect(); doc.removeEventListener('keydown', keydown, true); win.removeEventListener('beforeunload', beforeUnload);
      root.remove(); scrollLock.release(lockOwner); active = null;
      if (oldFocus?.isConnected) oldFocus.focus();
      deps.onClose?.({ saved });
    }
    async function requestClose() {
      if (drag) { cancelDrag(); return false; }
      if (busy || confirming || picking) return false;
      if (isDirty(draft) && !await confirm('Discard changes?', 'Your saved workout will stay unchanged.')) return false;
      destroy(false); return true;
    }
    function setBusy(value) {
      busy = value;
      root.querySelectorAll('input, textarea, button').forEach(control => {
        if (value) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
        else { control.disabled = control.dataset.wasDisabled === 'true'; delete control.dataset.wasDisabled; }
      });
      saveButton.textContent = value ? 'Saving…' : 'Save changes';
    }
    async function save() {
      cancelDrag();
      if (busy || confirming || picking) return false;
      const result = applyDraft(draft);
      if (result.error) {
        errorBox.textContent = result.error;
        const key = result.field === 'set' ? `set:${result.exerciseId}:${result.row}` : result.field;
        if (result.exerciseId) { collapsed.delete(result.exerciseId); render(key); } else inputs.get(key)?.focus();
        return false;
      }
      if (!isDirty(draft)) { destroy(false); return true; }
      if (typeof deps.saveSession !== 'function') { errorBox.textContent = 'Saving is unavailable. Your changes have not been applied.'; return false; }
      setBusy(true);
      try {
        const outcome = await deps.saveSession(clone(result.session), clone(draft.baseline));
        if (outcome !== true && outcome?.ok !== true) throw new Error(outcome?.error?.message || outcome?.error || 'The changes could not be saved. Your edits are still here.');
        const saved = clone(result.session);
        destroy(true);
        deps.onSaved?.(saved);
        return true;
      } catch (error) { errorBox.textContent = error?.message || 'The changes could not be saved. Your edits are still here.'; return false; }
      finally { if (!destroyed) setBusy(false); }
    }
    function keydown(event) {
      if (destroyed || picking || otherOverlayOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (drag) { cancelDrag(); return; } requestClose(); }
      if (event.key === 'Tab') {
        const focusable = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(node => !node.closest('[hidden]') && node.getClientRects().length);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (doc.activeElement === first || !root.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (doc.activeElement === last || !root.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
      }
    }
    function beforeUnload(event) { if (isDirty(draft)) { event.preventDefault(); event.returnValue = ''; } }
    root.querySelector('.he-close').addEventListener('click', requestClose);
    root.querySelector('.he-cancel').addEventListener('click', requestClose);
    saveButton.addEventListener('click', save);
    root.addEventListener('click', event => { if (event.target === root) requestClose(); });
    doc.addEventListener('pointermove', moveDrag, { passive: false }); doc.addEventListener('pointerup', endDrag); doc.addEventListener('pointercancel', cancelDrag); doc.addEventListener('visibilitychange', visibilityChanged); win.addEventListener('blur', cancelDrag);
    doc.addEventListener('keydown', keydown, true); win.addEventListener('beforeunload', beforeUnload);
    render();
    const controller = { close: requestClose, save, isDirty: () => isDirty(draft), focus: () => root.querySelector('#historyEditorTitle').focus(), getDraft: () => clone(draft) };
    active = controller; controller.focus();
    return controller;
  }
  return { createDraft, applyDraft, validateDraft, isDirty, addExercise, removeExercise, moveExercise, moveExerciseTo, replaceSession, equal, localDateTime, parseLocalDateTime, nextHistoryRow, rowMode, rowEstimate, configure, open, isOpen: () => Boolean(active) };
});
