// Workflow tests use the real theme logic without rendering a browser DOM.
// DOM class/colour behaviour is verified separately by the theme regression tests.
const {createThemeRuntime} = require('../../theme-runtime.js');
module.exports = () => createThemeRuntime({});
