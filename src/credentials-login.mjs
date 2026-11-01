function insideSite(value, baseURL) {
  const url = new URL(value, baseURL);
  const base = new URL(baseURL);
  const path = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return url.origin === base.origin && url.pathname.startsWith(path);
}

/** Submit the Joomla login form already displayed by the active site. Native
 * validation, the form's CSRF token, return URL and submit handlers stay intact. */
export function submitCurrentJoomlaLogin(frame, administrator, baseURL) {
  if (!frame || !baseURL || !administrator?.username || !administrator?.password) return false;
  let doc, win;
  try {
    doc = frame.contentDocument;
    win = frame.contentWindow;
    if (!doc || !win || !insideSite(win.location.href, baseURL)) return false;
  } catch { return false; }
  for (const form of doc.forms) {
    const option = form.elements.namedItem('option')?.value;
    const task = form.elements.namedItem('task')?.value;
    const joomlaLogin = (option === 'com_login' && task === 'login') || (option === 'com_users' && task === 'user.login');
    if (!joomlaLogin || form.method.toLowerCase() !== 'post' || !insideSite(form.action, baseURL)) continue;
    const username = form.querySelector('input[name="username"]');
    const password = form.querySelector('input[type="password"][name="passwd"], input[type="password"][name="password"]');
    if (!username || !password || username.disabled || password.disabled || username.readOnly || password.readOnly) continue;
    const submitter = form.querySelector('button[type="submit"]:not(:disabled), button:not([type]):not(:disabled), input[type="submit"]:not(:disabled)');
    if (submitter && ((submitter.formMethod && submitter.formMethod.toLowerCase() !== 'post') || (submitter.hasAttribute('formaction') && !insideSite(submitter.formAction, baseURL)))) continue;
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    for (const [field, value] of [[username, administrator.username], [password, administrator.password]]) {
      setValue.call(field, value);
      field.dispatchEvent(new win.Event('input', { bubbles: true }));
      field.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    // Calling the prototype preserves submit events even if a named field
    // shadows requestSubmit on the form instance.
    win.HTMLFormElement.prototype.requestSubmit.call(form, submitter || undefined);
    return true;
  }
  return false;
}

export function loginFromCredentialsDialog({ dialog, frame, administrator, baseURL }) {
  dialog.close();
  return submitCurrentJoomlaLogin(frame, administrator, baseURL);
}
