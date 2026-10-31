(() => {
  let theme = 'system';
  const media = matchMedia('(prefers-color-scheme: dark)');
  function renderTheme() {
    const dark = theme === 'dark' || (theme === 'system' && media.matches);
    document.documentElement.dataset.joomengineTheme = dark ? 'dark' : 'light';
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href, location.href);
      const file = url.searchParams.get('file');
      if (file === 'dark.css') link.media = dark ? 'all' : 'not all';
      else if (file === 'default.css') link.media = 'all';
    }
  }
  addEventListener('message', event => {
    if (event.origin !== location.origin || ![parent, opener].includes(event.source)) return;
    if (event.data?.type !== 'joomengine-database-theme' || !['light', 'dark', 'system'].includes(event.data.theme)) return;
    theme = event.data.theme;
    renderTheme();
  });
  media.addEventListener('change', renderTheme);
  addEventListener('DOMContentLoaded', renderTheme);
})();
