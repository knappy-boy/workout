/* A single decorative marker follows the existing selected button. No input is intercepted. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LiftLogSlidingControls = api;
    const start = () => api.bind(root, root.document);
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, {once: true});
    else start();
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const SELECTOR = '.tabs, #librarySwitch, .bw-period-tabs, .progress-period-tabs, .chart-segments';
  const PROPERTIES = ['x', 'y', 'width', 'height', 'radius', 'fill', 'ink'].map(name => `--slide-${name}`);
  const finite = value => Number.isFinite(value) ? value : 0;
  function markerBounds({container, button, clientLeft = 0, clientTop = 0, clientWidth, clientHeight, scrollWidth, scrollHeight, scrollLeft = 0, scrollTop = 0}) {
    const widthLimit = Math.max(0, finite(clientWidth), finite(scrollWidth));
    const heightLimit = Math.max(0, finite(clientHeight), finite(scrollHeight));
    if (!container || !button || container.width <= 0 || container.height <= 0 || button.width <= 0 || button.height <= 0 || !widthLimit || !heightLimit) return null;
    const width = Math.min(button.width, widthLimit), height = Math.min(button.height, heightLimit);
    // Absolute positioning starts at the container's padding edge. Include its
    // own scroll offset, but never include the border twice (the old overspill).
    const x = Math.max(0, Math.min(widthLimit - width, button.left - container.left - clientLeft + scrollLeft));
    const y = Math.max(0, Math.min(heightLimit - height, button.top - container.top - clientTop + scrollTop));
    if (![x, y, width, height].every(Number.isFinite)) return null;
    return {x, y, width, height};
  }
  function createGroup(env, container) {
    let frame = null, armFrame = null, disposed = false, positioned = false, snapPending = true, previousLayout = null;
    let observed = new Set();
    const sizes = new Map();
    const buttons = () => [...container.children].filter(node => node.tagName === 'BUTTON');
    const selected = items => items.find(node => node.getAttribute('aria-pressed') === 'true' || node.getAttribute('aria-current') === 'page' || node.classList.contains('active'));
    const rememberSize = node => { const rect = node.getBoundingClientRect(); sizes.set(node, {width: rect.width, height: rect.height}); };
    const resize = env.ResizeObserver ? new env.ResizeObserver(entries => {
      let changed = false;
      for (const {target} of entries) {
        const before = sizes.get(target), rect = target.getBoundingClientRect();
        if (!before || before.width !== rect.width || before.height !== rect.height) changed = true;
        sizes.set(target, {width: rect.width, height: rect.height});
      }
      // Initial notifications for replacement filter buttons are not a resize.
      // Their marker should continue gliding from the previous selected button.
      if (changed) refresh(true);
    }) : null;
    function set(name, value) { if (container.style.getPropertyValue(name) !== value) container.style.setProperty(name, value); }
    function paint() {
      frame = null;
      if (disposed) return;
      const items = buttons(), nextObserved = new Set(items);
      if (resize) {
        observed.forEach(node => { if (!nextObserved.has(node)) { resize.unobserve(node); sizes.delete(node); } });
        nextObserved.forEach(node => { if (!observed.has(node)) { rememberSize(node); resize.observe(node); } });
      }
      observed = nextObserved;
      const active = selected(items), containerRect = container.getBoundingClientRect();
      // Parent class changes can update labels/panels without moving this track.
      // Compare content coordinates so those changes (and native scrolling) do
      // not reset a transition that is already travelling to the selected item.
      const layout = JSON.stringify([container.clientWidth, container.clientHeight, container.scrollWidth, container.scrollHeight,
        ...items.map(button => {
          const rect = button.getBoundingClientRect();
          return [rect.left - containerRect.left + container.scrollLeft,
            rect.top - containerRect.top + container.scrollTop, rect.width, rect.height];
        })]);
      const layoutChanged = previousLayout !== null && previousLayout !== layout;
      previousLayout = layout;
      const bounds = active && markerBounds({container: containerRect, button: active.getBoundingClientRect(),
        clientLeft: container.clientLeft, clientTop: container.clientTop, clientWidth: container.clientWidth, clientHeight: container.clientHeight,
        scrollWidth: container.scrollWidth, scrollHeight: container.scrollHeight, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop});
      if (!bounds) {
        container.dataset.slideReady = 'false'; positioned = false; snapPending = true; previousLayout = null;
        if (armFrame !== null) { env.cancelAnimationFrame(armFrame); armFrame = null; }
        return;
      }
      const snap = snapPending || !positioned || layoutChanged; snapPending = false;
      if (snap) container.dataset.slideAnimate = 'false';
      const tint = active.style.getPropertyValue('--filter-color') || active.style.backgroundColor || active.style.background;
      set('--slide-fill', tint || 'var(--black)'); set('--slide-ink', tint ? '#111' : 'var(--white)');
      set('--slide-radius', env.getComputedStyle(active).borderRadius || '999px');
      for (const [name, value] of Object.entries(bounds)) set(`--slide-${name}`, `${value}px`);
      container.dataset.slideReady = 'true'; positioned = true;
      if (snap) {
        if (armFrame !== null) env.cancelAnimationFrame(armFrame);
        armFrame = env.requestAnimationFrame(() => {
          armFrame = null;
          if (!disposed && positioned) container.dataset.slideAnimate = 'true';
        });
      }
    }
    function refresh(snap = false) {
      if (disposed) return;
      snapPending ||= snap;
      if (frame === null) frame = env.requestAnimationFrame(paint);
    }
    const mutation = env.MutationObserver ? new env.MutationObserver(records => {
      // Our own CSS variables are the only inline styles on the container that
      // this controller changes. Ignoring them avoids an observer/render loop.
      if (records.some(record => record.target !== container || record.attributeName !== 'style')) refresh();
    }) : null;
    container.classList.add('sliding-control');
    mutation?.observe(container, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-current', 'style']});
    rememberSize(container); resize?.observe(container);
    const scroll = () => refresh();
    container.addEventListener('scroll', scroll, {passive: true});
    refresh(true);
    return {
      refresh,
      dispose() {
        if (disposed) return;
        disposed = true; mutation?.disconnect(); resize?.disconnect();
        if (frame !== null) env.cancelAnimationFrame(frame);
        if (armFrame !== null) env.cancelAnimationFrame(armFrame);
        container.removeEventListener('scroll', scroll);
        container.classList.remove('sliding-control');
        delete container.dataset.slideReady; delete container.dataset.slideAnimate;
        PROPERTIES.forEach(name => container.style.removeProperty(name));
        observed.clear(); sizes.clear();
      }
    };
  }
  // Backing selects retain the chart's existing change handlers and its dynamic
  // grouping options. The buttons are just another accessible way to choose.
  function bindSelect(env, doc, select, track) {
    let disposed = false;
    const choices = new Map();
    const row = track.parentElement;
    const unavailable = () => select.hidden || select.classList.contains('hidden');
    function activate(value) {
      const option = [...select.options].find(item => item.value === value);
      if (disposed || unavailable() || select.disabled || !option || option.disabled || option.hidden) return;
      if (select.value !== value) {
        select.value = value;
        select.dispatchEvent(new env.Event('change', {bubbles: true}));
      }
      sync();
    }
    function sync() {
      if (disposed) return;
      const options = [...select.options].filter(option => !option.hidden);
      const values = new Set(options.map(option => option.value));
      for (const [value, item] of choices) if (!values.has(value)) {
        item.button.removeEventListener('click', item.click); item.button.remove(); choices.delete(value);
      }
      options.forEach((option, index) => {
        let item = choices.get(option.value);
        if (!item) {
          const button = doc.createElement('button'); button.type = 'button'; button.dataset.selectValue = option.value;
          const click = () => activate(option.value);
          button.addEventListener('click', click); item = {button, click}; choices.set(option.value, item);
        }
        const button = item.button;
        const label = option.label || option.textContent;
        if (button.textContent !== label) button.textContent = label;
        button.disabled = Boolean(select.disabled || option.disabled);
        const selected = option.value === select.value;
        button.classList.toggle('active', selected);
        const pressed = String(selected);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        if (track.children[index] !== button) track.insertBefore(button, track.children[index] || null);
      });
      const hidden = unavailable() || !options.length;
      track.hidden = hidden;
      if (row?.classList.contains('chart-segment-row')) row.hidden = hidden;
    }
    function keydown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...track.children].filter(button => !button.disabled);
      const index = buttons.indexOf(event.target);
      if (index < 0 || !buttons.length || unavailable()) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      activate(buttons[next].dataset.selectValue); buttons[next].focus({preventScroll: true});
    }
    select.classList.add('segmented-backing');
    select.addEventListener('change', sync); track.addEventListener('keydown', keydown);
    const observer = env.MutationObserver ? new env.MutationObserver(sync) : null;
    observer?.observe(select, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'selected', 'value', 'label']});
    sync();
    return {sync, dispose() {
      if (disposed) return;
      disposed = true; observer?.disconnect(); select.removeEventListener('change', sync); track.removeEventListener('keydown', keydown);
      choices.forEach(item => item.button.removeEventListener('click', item.click)); choices.clear();
      track.replaceChildren(); track.hidden = true; select.classList.remove('segmented-backing');
      if (row?.classList.contains('chart-segment-row')) row.hidden = false;
    }};
  }
  function bind(env, doc) {
    const groups = new Map(), selects = new Map();
    let disposed = false;
    function discover() {
      if (disposed) return;
      for (const [node, control] of groups) if (!node.isConnected) { control.dispose(); groups.delete(node); }
      for (const [node, control] of selects) if (!node.isConnected) { control.dispose(); selects.delete(node); }
      doc.querySelectorAll('[data-segment-for]').forEach(track => {
        const id = track.dataset?.segmentFor;
        if (!id || selects.has(track)) return;
        const select = doc.getElementById(id);
        if (select?.tagName === 'SELECT') selects.set(track, bindSelect(env, doc, select, track));
      });
      doc.querySelectorAll(SELECTOR).forEach(node => { if (!groups.has(node)) groups.set(node, createGroup(env, node)); });
    }
    const observer = env.MutationObserver ? new env.MutationObserver(records => {
      let changedGroups = false;
      for (const record of records) {
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches(SELECTOR) || node.querySelector(SELECTOR)))) changedGroups = true;
        if (record.type === 'attributes') groups.forEach((control, node) => { if (record.target !== node && record.target.contains(node)) control.refresh(); });
      }
      if (changedGroups) discover();
    }) : null;
    const refresh = () => { selects.forEach(control => control.sync()); groups.forEach(control => control.refresh(true)); };
    discover();
    observer?.observe(doc.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden']});
    env.addEventListener('resize', refresh, {passive: true});
    doc.fonts?.ready?.then(() => { if (!disposed) refresh(); });
    return { refresh, dispose() { if (disposed) return; disposed = true; observer?.disconnect(); env.removeEventListener('resize', refresh); groups.forEach(control => control.dispose()); groups.clear(); selects.forEach(control => control.dispose()); selects.clear(); } };
  }
  return {markerBounds, createGroup, bindSelect, bind};
});
