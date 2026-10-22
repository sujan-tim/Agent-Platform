// Applies the saved theme before the page draws: dark (the default), light,
// or system (follow the device). Loaded as a plain script in <head>, since the
// page's security policy allows no inline scripts. app.js changes it later.
(() => {
  let theme = 'dark';
  try {
    theme = localStorage.getItem('theme') || 'dark';
  } catch {
    // Storage blocked: stay dark.
  }
  document.documentElement.dataset.theme = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
})();
