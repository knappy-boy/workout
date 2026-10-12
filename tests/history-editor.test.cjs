const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../history-editor.js');
const logging = require('../logging.js');
const exercises = {
  bench: { id: 'bench', name: 'Bench press', type: 'strength' },
  pull: { id: 'pull', name: 'Assisted pull-up', type: 'strength', isAssisted: true },
  run: { id: 'run', name: 'Run', type: 'cardio', cardioMetric: 'km' },
  body: { id: 'body', name: 'Push-up', type: 'strength' },
};
const clone = value => JSON.parse(JSON.stringify(value));
function session() {
  return { id: 'session-1', start: '2026-04-13T09:03:21.456Z', end: '2026-04-13T10:08:48.912Z', templateId: 'template-1', templateName: 'Chest & Arms', notes: 'Morning', order: ['bench', 'pull', 'run'],
    entries: { bench: [{ w: '62.5', r: 8, note: 'Pause', type: 'working', custom: { marker: true } }, { w: 60.123456789, r: '7', completed: true }], pull: [{ w: '30', r: '10' }], run: [{ time: '12.5', dist: 1.7, customCardio: 'keep' }] },
    exerciseNotes: { bench: 'Rest 90s' }, unknown: { nested: ['keep', 1] }, logDrafts: { untouched: { row: 'keep' } } };
}
function applied(draft) { const result = editor.applyDraft(draft); assert.equal(result.error, null); return result.session; }

test('opening/cancelling or applying untouched edits preserves the exact JSON and never mutates session/library', () => {
  const original = session(), library = clone(exercises), before = clone(original);
  const draft = editor.createDraft(original, library, 'lbs');
  assert.equal(editor.isDirty(draft), false);
  assert.deepEqual(applied(draft), before);
  draft.items.bench.rows[0].a = '1'; draft.notes = 'local only'; draft.items.bench.exercise.name = 'Changed local descriptor';
  assert.equal(editor.isDirty(draft), true);
  assert.deepEqual(original, before); assert.deepEqual(library, exercises);
});
test('duration correction uses the original precise start and changes only end', () => {
  const original = session(), draft = editor.createDraft(original, exercises);
  draft.durationMinutes = '45';
  const next = applied(draft);
  assert.equal(next.end, '2026-04-13T09:48:21.456Z');
  assert.deepEqual({ ...next, end: original.end }, original);
});
test('displayed rounded duration is not written when only notes change', () => {
  const original = session(), draft = editor.createDraft(original, exercises);
  assert.equal(draft.durationMinutes, '65');
  draft.notes = 'Corrected note';
  const next = applied(draft);
  assert.equal(next.start, original.start); assert.equal(next.end, original.end);
  assert.deepEqual({ ...next, notes: original.notes }, original);
});
test('start-only correction retains exact millisecond duration', () => {
  const original = session(), draft = editor.createDraft(original, exercises);
  draft.start = '2026-04-14T12:15';
  const next = applied(draft);
  assert.equal(Date.parse(next.start), editor.parseLocalDateTime(draft.start));
  assert.equal(Date.parse(next.end) - Date.parse(next.start), Date.parse(original.end) - Date.parse(original.start));
});
test('changing both start and duration creates the requested interval; zero minutes is valid', () => {
  const draft = editor.createDraft(session(), exercises);
  draft.start = '2026-04-14T12:15'; draft.durationMinutes = '0';
  let next = applied(draft); assert.equal(next.start, next.end);
  draft.durationMinutes = '120'; next = applied(draft);
  assert.equal(Date.parse(next.end) - Date.parse(next.start), 120 * 60000);
});
test('duration rejects blank, negative, fractional, exponent, nonfinite and out-of-range values', () => {
  for (const value of ['', '-1', '1.5', '1e3', 'Infinity', 'NaN', 'abc', '9007199254740992', '9007199254740000']) {
    const draft = editor.createDraft(session(), exercises); draft.durationMinutes = value;
    assert.equal(editor.applyDraft(draft).field, 'duration', value);
  }
});
test('invalid or nonexistent local date fields fail without normalizing into another month', () => {
  for (const value of ['', '2026-02-30T10:00', '2026-13-01T10:00', '2026-04-01T25:00', '2026-04-01', 'garbage']) {
    const draft = editor.createDraft(session(), exercises); draft.start = value;
    assert.equal(editor.applyDraft(draft).field, 'start', value);
  }
});
test('unfinished/legacy sessions without an end retain its absence unless duration is explicitly entered', () => {
  const original = session(); delete original.end;
  const draft = editor.createDraft(original, exercises); draft.notes = 'Edited';
  assert.equal(Object.hasOwn(applied(draft), 'end'), false);
  draft.durationMinutes = '50'; assert.equal(Date.parse(applied(draft).end) - Date.parse(original.start), 50 * 60000);
});
test('reps-only edit in pounds preserves exact kilograms and all unknown set/session metadata', () => {
  const original = session(), draft = editor.createDraft(original, exercises, 'lbs');
  draft.items.bench.rows[1].b = '9';
  const next = applied(draft);
  assert.equal(next.entries.bench[1].w, 60.123456789);
  assert.equal(next.entries.bench[1].r, '9'); assert.equal(next.entries.bench[1].completed, true);
  assert.deepEqual(next.entries.bench[0], original.entries.bench[0]);
  assert.deepEqual(next.unknown, original.unknown); assert.equal(next.templateId, original.templateId);
});
test('edited pound weight is converted once and survives subsequent unchanged history edits', () => {
  let draft = editor.createDraft(session(), exercises, 'lbs');
  draft.items.bench.rows[0].a = '140';
  let next = applied(draft), kg = next.entries.bench[0].w;
  assert.ok(Math.abs(Number(kg) - 140 / 2.20462) < 1e-10);
  for (let i = 0; i < 25; i++) { draft = editor.createDraft(next, exercises, 'lbs'); draft.notes += '.'; next = applied(draft); assert.equal(next.entries.bench[0].w, kg); }
});
test('assistance remains nonnegative assistance; explicit zero supports bodyweight', () => {
  const draft = editor.createDraft(session(), exercises);
  draft.items.pull.rows[0].a = '20';
  assert.equal(applied(draft).entries.pull[0].w, '20');
  editor.addExercise(draft, 'body', exercises.body);
  draft.items.body.rows.push({ a: '0', b: '12', note: '' });
  assert.deepEqual(applied(draft).entries.body, [{ w: '0', r: '12' }]);
  draft.items.pull.rows[0].a = '-20'; assert.match(editor.applyDraft(draft).error, /non-negative/);
});
test('cardio time/distance and exercise/set notes can be edited without changing other sets', () => {
  const original = session(), draft = editor.createDraft(original, exercises);
  draft.items.run.rows[0].a = '20,5'; draft.items.run.rows[0].b = '2.2'; draft.items.run.rows[0].note = 'Easy';
  draft.items.run.notes = 'Outdoors';
  const next = applied(draft);
  assert.deepEqual(next.entries.run, [{ time: '20.5', dist: '2.2', customCardio: 'keep', note: 'Easy' }]);
  assert.equal(next.exerciseNotes.run, 'Outdoors'); assert.deepEqual(next.entries.bench, original.entries.bench);
});
test('partial sets and invalid strength/cardio entries fail with exercise and row context', () => {
  const draft = editor.createDraft(session(), exercises);
  draft.items.bench.rows[1].b = '';
  let result = editor.applyDraft(draft); assert.equal(result.exerciseId, 'bench'); assert.equal(result.row, 1); assert.match(result.error, /Set 2/);
  draft.items.bench.rows[1].b = '7.5'; assert.match(editor.applyDraft(draft).error, /whole number/);
  draft.items.bench.rows[1].b = '7'; draft.items.run.rows[0].a = '0'; draft.items.run.rows[0].b = '0'; assert.match(editor.applyDraft(draft).error, /greater than 0/);
});
test('blank new rows are ignored, notes-only rows fail, and existing rows must be removed explicitly', () => {
  const draft = editor.createDraft(session(), exercises);
  draft.items.bench.rows.push({ a: '', b: '', note: '' });
  assert.equal(applied(draft).entries.bench.length, 2);
  draft.items.bench.rows[2].note = 'Dangling'; assert.match(editor.applyDraft(draft).error, /remove its note/);
  draft.items.bench.rows.pop(); draft.items.bench.rows[0].a = ''; draft.items.bench.rows[0].b = '';
  assert.ok(editor.applyDraft(draft).error);
});
test('legacy bodyweight/partial/incomplete entries survive note edits and edits to other rows exactly', () => {
  const original = session(); original.entries.bench = [{ r: '8', note: null, extra: true }, { w: '', r: '', completed: false, custom: 5 }];
  const draft = editor.createDraft(original, exercises, 'lbs');
  draft.items.bench.rows[0].note = 'New note';
  const next = applied(draft);
  assert.deepEqual(next.entries.bench, [{ r: '8', note: 'New note', extra: true }, original.entries.bench[1]]);
  assert.equal(Object.hasOwn(next.entries.bench[0], 'w'), false);
});
test('legacy absent zero metric is not introduced by changing the other metric', () => {
  const original = session(); original.entries.run = [{ time: '10' }];
  const draft = editor.createDraft(original, exercises); draft.items.run.rows[0].a = '15';
  assert.deepEqual(applied(draft).entries.run, [{ time: '15' }]);
});
test('exercise add/remove/reorder preserves IDs, routine association and keyed notes/sets', () => {
  const original = session(), draft = editor.createDraft(original, exercises);
  editor.moveExercise(draft, 'run', -1); editor.moveExercise(draft, 'run', -1);
  let next = applied(draft); assert.deepEqual(next.order, ['run', 'bench', 'pull']); assert.deepEqual(next.entries, original.entries); assert.equal(next.templateId, 'template-1');
  editor.removeExercise(draft, 'bench'); next = applied(draft); assert.equal(Object.hasOwn(next.entries, 'bench'), false); assert.equal(Object.hasOwn(next.exerciseNotes, 'bench'), false);
  assert.deepEqual(next.entries.pull, original.entries.pull); assert.deepEqual(next.logDrafts, original.logDrafts);
  editor.addExercise(draft, 'bench', exercises.bench); next = applied(draft); assert.deepEqual(next.entries.bench, original.entries.bench); assert.equal(next.exerciseNotes.bench, 'Rest 90s');
  assert.deepEqual(original, session());
});
test('deleting one set preserves the remaining set exact type/precision and unknown metadata', () => {
  const original = session(), draft = editor.createDraft(original, exercises, 'lbs');
  draft.items.bench.rows.splice(0, 1);
  assert.deepEqual(applied(draft).entries.bench, [original.entries.bench[1]]);
});
test('unknown/archived library references stay editable without dropping their entries', () => {
  const original = session(); original.entries.orphan = [{ time: '4', dist: 0, custom: 'orphan' }];
  const draft = editor.createDraft(original, {}); draft.notes = 'Only notes';
  assert.equal(draft.items.orphan.exercise.type, 'cardio'); assert.deepEqual(applied(draft).entries, original.entries);
});
test('an absent order/notes field stays absent when editing only duration', () => {
  const original = session(); delete original.order; delete original.notes; delete original.exerciseNotes;
  const draft = editor.createDraft(original, exercises); draft.durationMinutes = '40';
  const next = applied(draft); assert.equal(Object.hasOwn(next, 'order'), false); assert.equal(Object.hasOwn(next, 'notes'), false); assert.equal(Object.hasOwn(next, 'exerciseNotes'), false);
});
test('reverting all editable values clears dirty state', () => {
  const draft = editor.createDraft(session(), exercises); draft.notes = 'Changed'; assert.equal(editor.isDirty(draft), true);
  draft.notes = draft.initial.notes; editor.moveExercise(draft, 'run', -1); editor.moveExercise(draft, 'run', 1);
  assert.equal(editor.isDirty(draft), false);
});
test('fresh database replacement preserves unrelated workouts, active-data fields and library', () => {
  const original = session(), draft = editor.createDraft(original, exercises); draft.durationMinutes = '30';
  const unrelated = { ...session(), id: 'other', notes: 'New in another window' };
  const db = { sessions: [unrelated, original], exercises: clone(exercises), templates: { a: { keep: true } }, user: { useLbs: true }, bodyweight: [{ kg: 81 }], unknown: true };
  const before = clone(db), result = editor.replaceSession(db, applied(draft), original);
  assert.deepEqual(result.sessions[0], unrelated); assert.deepEqual(result.exercises, db.exercises); assert.deepEqual(result.user, db.user); assert.deepEqual(result.templates, db.templates); assert.deepEqual(db, before);
});
test('same-session external edit or deletion is rejected instead of rebased over silently', () => {
  const original = session(), draft = editor.createDraft(original, exercises); draft.durationMinutes = '30';
  for (const sessions of [[], [{ ...original, notes: 'Changed elsewhere' }], [{ ...original, unknown: { version: 2 } }], [original, clone(original)]]) {
    assert.throws(() => editor.replaceSession({ sessions }, applied(draft), original), error => error.code === 'CONFLICT');
  }
});
test('replacement never changes a workout identity and ignores object key insertion order for comparison', () => {
  const original = session(), next = { ...original, notes: 'Corrected' };
  assert.throws(() => editor.replaceSession({ sessions: [original] }, { ...next, id: 'other' }, original), /identity/);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(editor.replaceSession({ sessions: [reordered] }, next, original).sessions[0].notes, 'Corrected');
});
test('new row copies previous canonical weight without previous reps or metadata', () => {
  const draft = editor.createDraft(session(), exercises, 'lbs');
  const row = { ...logging.nextRow(exercises.bench, draft.items.bench.rows), note: '' };
  assert.equal(row.b, ''); assert.equal(row.originalSet, undefined);
  row.b = '6'; draft.items.bench.rows.push(row);
  assert.deepEqual(applied(draft).entries.bench[2], { w: 60.123456789, r: '6' });
});

test('drag drop can move across several positions without changing keyed sets, notes or the saved baseline', () => {
  const original = session(), draft = editor.createDraft(original, exercises);
  const before = clone(original);
  assert.equal(editor.moveExerciseTo(draft, 'bench', 2), true);
  assert.deepEqual(draft.order, ['pull', 'run', 'bench']);
  assert.deepEqual(applied(draft).entries, before.entries);
  assert.deepEqual(applied(draft).exerciseNotes, before.exerciseNotes);
  assert.deepEqual(original, before);
  assert.equal(editor.moveExerciseTo(draft, 'bench', 0), true);
  assert.deepEqual(applied(draft), before);
  assert.equal(editor.isDirty(draft), false);
});
test('invalid or unchanged drag destinations cannot remove or duplicate exercises', () => {
  const draft = editor.createDraft(session(), exercises), before = clone(draft);
  for (const [id, index] of [['bench', -1], ['bench', 3], ['bench', 1.5], ['missing', 0], ['bench', 0]]) assert.equal(editor.moveExerciseTo(draft, id, index), false);
  assert.deepEqual(draft, before);
});

test('four load modes preserve saved snapshots and unknown metadata on no-op and reps edits', () => {
  for (const mode of ['external', 'bodyweight', 'assisted', 'weighted']) {
    const original = session();
    original.entries.bench = [{ w: mode === 'bodyweight' ? 0 : '12.5', r: 8, loadType: mode,
      bodyweightKg: 81.12345, bodyweightDate: '2026-04-12', bodyweightSourceId: 'reading-1', custom: { retain: true } }];
    const library = { ...exercises, bench: { ...exercises.bench, loadType: 'weighted' } };
    const draft = editor.createDraft(original, library, 'lbs');
    assert.deepEqual(applied(draft), original);
    draft.items.bench.rows[0].b = '9';
    const edited = applied(draft).entries.bench[0];
    assert.deepEqual({ ...edited, r: 8 }, original.entries.bench[0]);
    assert.equal(editor.rowMode(draft.items.bench.rows[0], library.bench), mode);
  }
});
test('historical legacy rows ignore a new library load type and gain no inferred snapshot', () => {
  const original = session(), library = clone(exercises);
  library.bench.loadType = 'bodyweight'; library.pull.loadType = 'weighted';
  const draft = editor.createDraft(original, library);
  assert.equal(editor.rowMode(draft.items.bench.rows[0], library.bench), 'external');
  assert.equal(editor.rowMode(draft.items.pull.rows[0], library.pull), 'assisted');
  draft.items.pull.rows[0].b = '11';
  const edited = applied(draft).entries.pull[0];
  assert.deepEqual(edited, { w: '30', r: '11' });
});
test('new historical rows inherit only the same exercise explicit load snapshot without notes or custom fields', () => {
  const original = session();
  original.entries.pull[0] = { w: '30', r: '10', loadType: 'assisted', bodyweightKg: 80,
    bodyweightDate: '2026-04-10', bodyweightSourceId: 'saved-reading', note: 'Do not copy', custom: true };
  const draft = editor.createDraft(original, exercises);
  const next = editor.nextHistoryRow(draft.items.pull);
  assert.equal(next.b, ''); assert.equal(next.originalSet, undefined); assert.equal(next.note, '');
  next.b = '8'; draft.items.pull.rows.push(next);
  assert.deepEqual(applied(draft).entries.pull[1], { w: '30', r: '8', loadType: 'assisted',
    bodyweightKg: 80, bodyweightDate: '2026-04-10', bodyweightSourceId: 'saved-reading' });
  assert.match(editor.rowEstimate(next, exercises.pull, 'kg'), /50 kg/);
});
test('historical bodyweight new rows require only reps and never acquire a current bodyweight', () => {
  const draft = editor.createDraft(session(), exercises);
  editor.addExercise(draft, 'newbody', { id: 'newbody', name: 'Bodyweight pull-up', type: 'strength', loadType: 'bodyweight' });
  const row = editor.nextHistoryRow(draft.items.newbody); draft.items.newbody.rows.push(row);
  assert.equal(applied(draft).entries.newbody.length, 0);
  row.b = '7';
  assert.deepEqual(applied(draft).entries.newbody, [{ w: 0, r: '7', loadType: 'bodyweight' }]);
  assert.match(editor.rowEstimate(row, draft.items.newbody.exercise, 'kg'), /No estimate/);
});
test('history changing dates or raw assistance retains the original bodyweight snapshot', () => {
  const original = session(); original.entries.pull[0] = { w: '30', r: '10', loadType: 'assisted',
    bodyweightKg: 80, bodyweightDate: '2026-04-10', extra: 'stay' };
  const draft = editor.createDraft(original, exercises);
  draft.start = '2026-05-01T10:00'; draft.items.pull.rows[0].a = '25';
  const edited = applied(draft).entries.pull[0];
  assert.deepEqual(edited, { ...original.entries.pull[0], w: '25' });
  assert.match(editor.rowEstimate(draft.items.pull.rows[0], exercises.pull, 'kg'), /55 kg/);
});
test('adding a missed historical set follows the last legacy mode rather than today’s exercise default', () => {
  const original = session(); original.entries.pull = [{ w: 18, r: 8, custom: 'keep' }];
  const library = clone(exercises); library.pull.loadType = 'weighted';
  const draft = editor.createDraft(original, library), item = draft.items.pull;
  const row = editor.nextHistoryRow(item); row.b = '7'; item.rows.push(row);
  assert.equal(row.loadType, 'assisted'); assert.equal(row.a, '18');
  assert.deepEqual(applied(draft).entries.pull, [original.entries.pull[0], { w: 18, r: '7', loadType: 'assisted' }]);
  assert.equal(Object.hasOwn(row, 'bodyweightKg'), false);
});
