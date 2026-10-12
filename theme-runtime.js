/* Appearance only. Workout storage and saved drafts stay owned by storage.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = {createThemeRuntime: factory};
  else root.LiftLogTheme = factory(root);
})(typeof window === 'object' ? window : globalThis, function (root) {
  'use strict';
  const MODES = Object.freeze(['light', 'dark', 'purple']);
  let current = 'light';
  function normalize(mode) { return MODES.includes(mode) ? mode : 'light'; }
  function next(mode) { return MODES[(MODES.indexOf(normalize(mode)) + 1) % MODES.length]; }
  function apply(mode) {
    current = normalize(mode);
    const doc = root.document;
    if (!doc?.body) return current;
    const body = doc.body, dark = current === 'dark';
    body.classList.remove('theme-light', 'theme-dark', 'theme-purple');
    body.classList.add(`theme-${current}`);
    body.dataset.themeMode = current;
    doc.documentElement.dataset.themeMode = current;
    body.style.colorScheme = doc.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    const button = doc.querySelector('#btnTheme');
    if (button) {
      const names = {light:'Light', dark:'Dark', purple:'Purple'};
      const label = `${names[current]} theme. Switch to ${names[next(current)]} theme`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.dataset.themeMode = current;
      button.textContent = current === 'light' ? '◑' : current === 'dark' ? '☾' : '◈';
    }
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = chartColors().surface;
    return current;
  }
  function chartColors() {
    const dark = current === 'dark';
    const fallback = {ink:dark ? '#ffffff' : '#000000', grid:dark ? '#333333' : '#dddddd',
      accent:'#FF3333', outline:'#111111', surface:dark ? '#1e1e1e' : '#f4f4f4'};
    if (current !== 'purple' || !root.document?.body || !root.getComputedStyle) return fallback;
    const style = root.getComputedStyle(root.document.body);
    const get = (token, alternate) => style.getPropertyValue(token).trim() || alternate;
    return {ink:get('--purple-chart-ink', fallback.ink), grid:get('--purple-chart-grid', fallback.grid),
      accent:get('--purple-chart-accent', get('--red', fallback.accent)),
      outline:get('--purple-chart-outline', fallback.outline), surface:get('--gray', fallback.surface)};
  }
  return Object.freeze({modes:MODES, normalize, next, apply, chartColors,
    getTheme:() => current, isDark:() => current === 'dark'});
});
