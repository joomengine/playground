import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const browserName = (process.env.PLAYGROUND_BROWSERS || 'chromium').split(',')[0];

test(`Login details submits the current Joomla form with its CSRF token and leaves other pages in place (${browserName})`, { timeout: 30_000 }, async () => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const shell = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dialog = shell.match(/<dialog id="credentials-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dialog);
  assert.doesNotMatch(dialog, /id="copy-credentials"/);
  const submissions = [];
  const server = await createStaticServer({ directory, fixtures: {
    'login-fixture.html': `<!doctype html><html><body><button id="open">Login details</button>${dialog}
      <iframe id="site-frame" src="site/administrator/login.html"></iframe>
      <script type="module">
        import { loginFromCredentialsDialog } from './src/credentials-login.mjs';
        const dialog = document.getElementById('credentials-dialog');
        document.getElementById('open').onclick = () => dialog.showModal();
        document.getElementById('credential-login').onclick = () => {
          window.didSubmit = loginFromCredentialsDialog({dialog, frame: document.getElementById('site-frame'),
            baseURL: new URL('site/', location.href).href,
            administrator: {username:'site-admin', password:'Correct-Passphrase-123!'}});
        };
      </script></body></html>`,
    'site/administrator/login.html': `<!doctype html><html><body><form id="form-login" method="post" action="index.html">
      <input name="username" required autocomplete="username"><input type="password" name="passwd" required autocomplete="current-password">
      <input type="hidden" name="option" value="com_login"><input type="hidden" name="task" value="login">
      <input type="hidden" name="e8d73138118eb037c7ad0e1a90a712be" value="1"><input type="hidden" name="return" value="existing-return-value">
      <button type="submit" name="submitted" value="yes">Log in</button></form></body></html>`,
    'site/administrator/index.html': async request => {
      let body = '';
      for await (const chunk of request) body += chunk;
      submissions.push({ method: request.method, fields: Object.fromEntries(new URLSearchParams(body)) });
      return '<!doctype html><html><body><h1>Administrator</h1></body></html>';
    },
    'site/article.html': '<!doctype html><html><body><h1>Current article</h1><form method="post" action="administrator/index.html"><input name="username"><input type="password" name="password"><input type="hidden" name="option" value="com_users"><input type="hidden" name="task" value="registration.register"><button>Register</button></form></body></html>',
    'site/frontend-login.html': `<!doctype html><html><body><form id="login-form" method="post" action="administrator/index.html">
      <input name="username"><input type="password" name="password"><input type="hidden" name="option" value="com_users">
      <input type="hidden" name="task" value="user.login"><input type="hidden" name="front-token" value="1"><button type="submit">Login</button></form></body></html>`,
  } });
  let browser;
  try {
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}login-fixture.html`);
    await page.frameLocator('#site-frame').locator('#form-login').waitFor();
    await page.locator('#open').click();
    await page.locator('#credential-login').click();
    await page.frameLocator('#site-frame').locator('h1').filter({ hasText: 'Administrator' }).waitFor();
    assert.equal(await page.locator('#credentials-dialog').evaluate(element => element.open), false);
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0], { method: 'POST', fields: {
      username: 'site-admin', passwd: 'Correct-Passphrase-123!', option: 'com_login', task: 'login',
      e8d73138118eb037c7ad0e1a90a712be: '1', return: 'existing-return-value', submitted: 'yes',
    } });
    await page.locator('#site-frame').evaluate(frame => { frame.src = 'site/article.html'; });
    await page.frameLocator('#site-frame').locator('h1').filter({ hasText: 'Current article' }).waitFor();
    await page.locator('#open').click();
    await page.locator('#credential-login').click();
    assert.equal(await page.locator('#credentials-dialog').evaluate(element => element.open), false);
    assert.equal(await page.evaluate(() => window.didSubmit), false);
    assert.equal(await page.frameLocator('#site-frame').locator('input[name="username"]').inputValue(), '');
    assert.equal(await page.frameLocator('#site-frame').locator('input[name="password"]').inputValue(), '');
    assert.equal(submissions.length, 1);
    assert.match(await page.locator('#site-frame').evaluate(frame => frame.contentWindow.location.pathname), /\/site\/article\.html$/);
    await page.locator('#site-frame').evaluate(frame => { frame.src = 'site/frontend-login.html'; });
    await page.frameLocator('#site-frame').locator('#login-form').waitFor();
    await page.locator('#open').click();
    await page.locator('#credential-login').click();
    await page.frameLocator('#site-frame').locator('h1').filter({ hasText: 'Administrator' }).waitFor();
    assert.equal(submissions.length, 2);
    assert.equal(submissions[1].fields.password, 'Correct-Passphrase-123!');
    assert.equal(submissions[1].fields['front-token'], '1');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
