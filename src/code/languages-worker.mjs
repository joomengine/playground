import { PhpProjectIndex } from './languages-php.mjs';
import { completeHtml } from './languages-html.mjs';

let index;
self.addEventListener('message', event => {
  const { id, operation, args = {} } = event.data || {};
  if (!Number.isSafeInteger(id)) return;
  try {
    let value;
    if (operation === 'configure') { index = new PhpProjectIndex({ phpVersion: args.phpVersion }); value = index.status(); }
    else if (!index) throw new Error('PHP language service is not configured.');
    else if (operation === 'update') value = { ...index.update(args.path, args.source, args.version), status: index.status() };
    else if (operation === 'remove') { index.remove(args.path); value = index.status(); }
    else if (operation === 'status') value = index.status();
    else if (operation === 'symbols') value = index.files.get(args.path)?.symbols || [];
    else if (operation === 'complete') {
      value = completeHtml(args.source, index.files.get(args.path)?.inline || [], args.offset, args.path)
        ?? index.complete(args.path, args.source, args.offset);
    } else if (operation === 'definition') value = index.definition(args.path, args.source, args.offset);
    else throw new Error(`Unknown PHP language operation: ${operation}`);
    self.postMessage({ id, value });
  } catch (error) { self.postMessage({ id, error: error.message }); }
});
