import { mountWorkbench } from './workbench.mjs';

// This page is a trusted same-origin view. Runtime ownership remains in the host;
// the supplied workspace object exposes only the confined worker operations.
// Provider credentials are never part of this view or its mount arguments.
Object.defineProperty(window, 'JoomEngineCode', {
  value: Object.freeze({ mount: options => mountWorkbench({ ...options, container: document.getElementById('workbench') }) }),
  writable: false,
});
