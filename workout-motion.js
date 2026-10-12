/* One-time visual feedback for a newly completed exercise; never stores workout data. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiftLogWorkoutMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function completionTransition(order, beforeCompleted, afterCompleted, savedExercise) {
    const before = new Set(beforeCompleted), after = new Set(afterCompleted);
    if (!order.includes(savedExercise) || before.has(savedExercise) || !after.has(savedExercise)) return null;
    const prefix = completed => {
      let count = 0;
      while (count < order.length && completed.has(order[count])) count++;
      return count;
    };
    const previousEnd = prefix(before), nextEnd = prefix(after);
    const segments = [];
    for (let index = previousEnd; index < nextEnd && index < order.length - 1; index++) segments.push(order[index]);
    return {
      tick: savedExercise,
      segments,
      next: nextEnd > previousEnd && nextEnd < order.length ? order[nextEnd] : null
    };
  }
  return { completionTransition };
});
