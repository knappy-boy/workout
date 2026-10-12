(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiftLogChartMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const ease = value => 1 - Math.pow(1 - value, 3);

  // Each chart retains only its current picture and latest target. A new render
  // cancels the old frame before starting from what is actually on screen.
  function createAnimator({ requestFrame, cancelFrame, now, reduced = () => false }) {
    const charts = new Map();
    function cancel(key, clear = false) {
      const state = charts.get(key);
      if (!state) return;
      if (state.frame !== null) cancelFrame(state.frame);
      state.frame = null;
      state.version++;
      if (clear) charts.delete(key);
    }
    function finish(key) {
      const state = charts.get(key);
      if (!state) return;
      cancel(key);
      state.current = new Map(state.rows.map(row => [row.key, row.value]));
      state.draw(state.rows.map(row => row.value), true);
    }
    function animate(key, rows, draw, { duration = 380, stagger = 24, cascade = false, reset = false } = {}) {
      const previous = charts.get(key);
      cancel(key);
      const targets = rows.map(row => ({ ...row, value: Number.isFinite(row.value) ? Math.max(0, row.value) : 0 }));
      const from = targets.map(row => reset ? 0 : previous?.current.get(row.key) ?? 0);
      const current = new Map(targets.map((row, i) => [row.key, from[i]]));
      const state = { current, rows: targets, draw, frame: null, version: 0 };
      charts.set(key, state);
      if (reduced() || duration <= 0 || targets.every((row, i) => row.value === from[i])) {
        finish(key);
        return;
      }
      const started = now();
      const version = state.version;
      const frame = time => {
        if (charts.get(key) !== state || state.version !== version) return;
        if (reduced()) { finish(key); return; }
        let finished = true;
        const values = targets.map((row, i) => {
          const delay = cascade ? Math.min(160, (row.delayIndex ?? i) * stagger) : 0;
          const progress = clamp((time - started - delay) / duration, 0, 1);
          if (progress < 1) finished = false;
          const value = progress === 1 ? row.value : from[i] + (row.value - from[i]) * ease(progress);
          state.current.set(row.key, value);
          return value;
        });
        state.draw(values, finished);
        state.frame = finished ? null : requestFrame(frame);
      };
      state.draw(from, false);
      state.frame = requestFrame(frame);
    }
    return { animate, cancel, finish, finishAll() { for (const key of charts.keys()) finish(key); }, cancelAll() { for (const key of charts.keys()) cancel(key, true); } };
  }

  // A fractional viewport makes dragging continuous rather than whole-record jumps.
  function viewport(total, zoom, offset) {
    const count = Math.min(total, Math.max(2, total / clamp(zoom, 1, 10)));
    return { count, offset: clamp(offset, 0, Math.max(0, total - count)) };
  }
  function anchoredZoom(total, oldZoom, oldOffset, nextZoom, anchor = 0.5) {
    const before = viewport(total, oldZoom, oldOffset);
    const after = viewport(total, nextZoom, 0);
    const fraction = clamp(anchor, 0, 1);
    return viewport(total, nextZoom, before.offset + fraction * Math.max(0, before.count - 1) - fraction * Math.max(0, after.count - 1)).offset;
  }
  // Canvas geometry is expressed in CSS pixels, independent of display density.
  function plotGeometry(width, height, padding = { top: 20, right: 20, bottom: 40, left: 40 }) {
    return { left: padding.left, top: padding.top,
      width: Math.max(0, Number(width) - padding.left - padding.right || 0),
      height: Math.max(0, Number(height) - padding.top - padding.bottom || 0) };
  }
  function hitTest(items, x, y, radius = 24) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    let found = -1, distance = radius;
    items.forEach((item, index) => {
      if (item.width !== undefined) {
        if (item.width > 0 && item.height > 0 && x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) found = index;
      } else {
        const next = Math.hypot(item.x - x, item.y - y);
        if (next <= distance) { distance = next; found = index; }
      }
    });
    return found;
  }
  function niceRange(values) {
    const numbers = values.filter(Number.isFinite);
    const low = Math.min(...numbers, Infinity), high = Math.max(...numbers, -Infinity);
    if (!numbers.length) return { min: 0, max: 1, step: .2 };
    const raw = Math.max(high - low, Math.abs(high) * .1, 1) / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].find(n => n * magnitude >= raw) * magnitude;
    const min = Math.max(0, Math.floor(low / step) * step - step);
    const max = Math.max(min + step, Math.ceil(high / step) * step + step);
    return { min, max, step };
  }
  function spacedAxisLabels(candidates, minGap = 12) {
    if (!candidates.length) return [];
    // Reserve the latest date first. A forced final label must never crowd a
    // preceding tick, even when the number of records is not divisible by its step.
    const last = candidates[candidates.length - 1], selected = [];
    const finalLeft = last.x - last.width / 2;
    let previousRight = -Infinity;
    for (const item of candidates.slice(0, -1)) {
      const left = item.x - item.width / 2, right = item.x + item.width / 2;
      if (left >= previousRight + minGap && right + minGap <= finalLeft) {
        selected.push(item); previousRight = right;
      }
    }
    selected.push(last);
    return selected;
  }
  return { createAnimator, viewport, anchoredZoom, plotGeometry, hitTest, niceRange, spacedAxisLabels };
});
