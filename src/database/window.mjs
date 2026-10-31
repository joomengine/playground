// The owner retains PHP/MariaDB and initializes this same-origin companion.
if (window.opener) window.opener.postMessage({ type: 'joomengine-database-window-ready' }, location.origin);
else document.querySelector('#database-window-content').textContent = 'Open Database from a running JoomEngine Playground site.';
