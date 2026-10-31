import { t } from './i18n.mjs';
import { importDynamicPackage, resolveDynamicPackage } from './dynamic-packages.mjs';

/** Browser navigation may download a ZIP even when its host disallows fetch.
 * Keep that download direct and let the user supply the exact archive locally.
 */
export async function resolvePackageSelection(entry, options) {
  try { return await resolveDynamicPackage(entry, options); }
  catch (error) {
    if (error?.code !== 'DIRECT_PACKAGE_DOWNLOAD_UNAVAILABLE') throw error;
    return chooseDownloadedPackage(entry, options);
  }
}

function chooseDownloadedPackage(entry, options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const dialog = document.createElement('dialog');
    dialog.id = 'package-download-dialog';
    dialog.className = 'rocket-dialog';
    dialog.setAttribute('aria-labelledby', 'package-download-title');
    const heading = document.createElement('div');
    heading.className = 'dialog-heading';
    const title = document.createElement('h2');
    title.id = 'package-download-title';
    title.textContent = t('title.packageDownload', { package: entry.label || entry.version || 'ZIP' });
    heading.append(title);
    const help = document.createElement('p');
    help.textContent = t('help.packageDownload');
    const download = document.createElement('a');
    download.id = 'package-download-link';
    download.className = 'button';
    download.href = entry.url;
    download.target = '_blank';
    download.rel = 'noopener noreferrer';
    download.download = new URL(entry.url).pathname.split('/').pop();
    download.textContent = `${t('action.download')} ZIP`;
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = 'package-download-file';
    label.textContent = t('label.packageFile');
    const file = document.createElement('input');
    file.id = 'package-download-file';
    file.type = 'file';
    file.accept = '.zip,application/zip';
    field.append(label, file);
    const status = document.createElement('p');
    status.className = 'field-help';
    status.setAttribute('role', 'status');
    const error = document.createElement('p');
    error.id = 'package-download-error';
    error.className = 'dialog-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.id = 'package-download-cancel';
    cancel.type = 'button';
    cancel.className = 'button';
    cancel.textContent = t('action.cancel');
    actions.append(cancel);
    dialog.append(heading, help, download, field, status, error, actions);
    const controller = new AbortController();
    let settled = false;
    const cleanUp = () => {
      options.signal?.removeEventListener('abort', onAbort);
      dialog.close(); dialog.remove(); controller.abort();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanUp();
      reject(options.signal.reason);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    dialog.addEventListener('close', () => {
      if (settled) return;
      settled = true;
      cleanUp();
      reject(new DOMException('Package selection cancelled.', 'AbortError'));
    });
    cancel.addEventListener('click', () => dialog.close());
    file.addEventListener('change', async () => {
      const archive = file.files?.[0];
      if (!archive || file.disabled) return;
      file.disabled = true;
      error.hidden = true;
      status.textContent = t('status.working');
      try {
        const selected = await importDynamicPackage(entry, archive, { ...options, signal: controller.signal });
        if (settled) return;
        settled = true;
        cleanUp();
        resolve(selected);
      } catch (failure) {
        if (settled) return;
        error.textContent = failure.message;
        error.hidden = false;
        file.value = '';
      } finally {
        file.disabled = false;
        status.textContent = '';
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
