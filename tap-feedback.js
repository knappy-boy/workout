/* Deliberate press feedback: scrolling over a routine must not look like selecting it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.LiftLogTapFeedback = api; api.bind(root, root.document); }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const SELECTOR = '.routine-start-card';
  function bind(env, doc) {
    let active = null, hold = null, release = null, pressed = null, cancelled = null;
    const downPointers = new Set();
    const listeners = [];
    const listen = (type, callback, options) => { doc.addEventListener(type, callback, options); listeners.push(() => doc.removeEventListener(type, callback, options)); };
    const now = () => env.performance?.now?.() ?? Date.now();
    const clearVisual = () => {
      if (hold !== null) env.clearTimeout(hold);
      if (release !== null) env.clearTimeout(release);
      hold = release = null;
      pressed?.classList.remove('is-pressing'); pressed = null;
    };
    function cancel(blockClick = false) {
      if (blockClick && active) cancelled = { element: active.element, until: downPointers.size ? Infinity : now() + 600 };
      active = null; clearVisual();
    }
    function show(element) { pressed = element; element.classList.add('is-pressing'); }
    listen('pointerdown', event => {
      // A fresh primary press also recovers if a browser omitted a terminal event.
      if (event.isPrimary !== false && !active) downPointers.clear();
      downPointers.add(event.pointerId);
      if (active || event.isPrimary === false) { cancel(true); return; }
      if (event.button !== 0) return;
      const element = event.target?.closest?.(SELECTOR);
      if (!element || element.disabled) return;
      clearVisual(); cancelled = null;
      active = { id: event.pointerId, element, x: event.clientX, y: event.clientY };
      if (event.pointerType === 'mouse') show(element);
      else hold = env.setTimeout(() => { hold = null; if (active?.element === element) show(element); }, 140);
    }, { passive: true });
    listen('pointermove', event => {
      if (!active || event.pointerId !== active.id) return;
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 8) cancel(true);
    }, { passive: true });
    function endPointer(event) {
      downPointers.delete(event.pointerId);
      if (cancelled && !downPointers.size) cancelled.until = now() + 600;
    }
    listen('pointerup', event => {
      endPointer(event);
      if (!active || event.pointerId !== active.id) return;
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 8) { cancel(true); return; }
      const element = active.element; active = null; clearVisual(); show(element);
      release = env.setTimeout(clearVisual, 160);
    }, { passive: true });
    listen('pointercancel', event => { endPointer(event); cancel(true); }, { passive: true });
    listen('scroll', () => cancel(true), { passive: true, capture: true });
    listen('visibilitychange', () => { if (doc.visibilityState === 'hidden') cancel(true); });
    // Native touch scrolling normally cancels clicks. Also reject any stray pointer
    // click following a cancelled gesture; keyboard/screen-reader clicks still work.
    listen('click', event => {
      if (event.detail === 0 || !cancelled || now() > cancelled.until) return;
      const element = event.target?.closest?.(SELECTOR);
      if (element === cancelled.element) { event.preventDefault(); event.stopImmediatePropagation(); cancelled = null; }
    }, true);
    return { dispose() { cancel(); downPointers.clear(); listeners.forEach(remove => remove()); } };
  }
  return { bind };
});
