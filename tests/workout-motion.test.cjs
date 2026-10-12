const test = require('node:test');
const assert = require('node:assert/strict');
const { completionTransition } = require('../workout-motion.js');

test('the first saved exercise reveals its segment and pulses the next node without changing order', () => {
  const order = ['bench', 'row', 'curl'];
  assert.deepEqual(completionTransition(order, [], ['bench'], 'bench'), { tick: 'bench', segments: ['bench'], next: 'row' });
  assert.deepEqual(order, ['bench', 'row', 'curl']);
});

test('out-of-order completion ticks its own node without drawing across an unfinished gap', () => {
  assert.deepEqual(completionTransition(['bench', 'row', 'curl'], [], ['curl'], 'curl'), { tick: 'curl', segments: [], next: null });
  assert.deepEqual(completionTransition(['bench', 'row', 'curl'], ['curl'], ['bench', 'curl'], 'bench'), { tick: 'bench', segments: ['bench'], next: 'row' });
});

test('closing a gap connects newly completed segments and never invents a next exercise after the end', () => {
  assert.deepEqual(completionTransition(['bench', 'row', 'curl', 'press'], ['row', 'curl'], ['bench', 'row', 'curl'], 'bench'),
    { tick: 'bench', segments: ['bench', 'row', 'curl'], next: 'press' });
  assert.deepEqual(completionTransition(['bench', 'row', 'curl'], ['bench', 'curl'], ['bench', 'row', 'curl'], 'row'),
    { tick: 'row', segments: ['row'], next: null });
  assert.deepEqual(completionTransition(['bench'], [], ['bench'], 'bench'), { tick: 'bench', segments: [], next: null });
});

test('relogging, changing notes, incomplete input, and reload/reorder state do not replay completion', () => {
  const order = ['curl', 'bench'];
  assert.equal(completionTransition(order, ['bench'], ['bench'], 'bench'), null);
  assert.equal(completionTransition(order, [], [], 'bench'), null);
  assert.equal(completionTransition(order, [], ['bench'], undefined), null);
  assert.equal(completionTransition(order, ['bench'], ['bench'], 'curl'), null);
  assert.equal(completionTransition(order, [], ['unknown'], 'unknown'), null);
});
