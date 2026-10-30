/* Run before the stylesheet: the full controller subscribes to changes later. */
(() => {
  let preference = 'system';
  try { preference = sessionStorage.getItem('joomengine.appearance.session.v1') || 'system'; } catch { /* Storage is optional. */ }
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  const theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
})();
