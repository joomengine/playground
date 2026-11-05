import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, firefox } from 'playwright';
import { prepareBrowserEnvironment } from './server.mjs';
import { createNetworkFixture } from './network-fixture.mjs';
import { assertJcbCompiler } from './jcb-compiler-contract.mjs';
import { assertJcbDocumentAssets } from './jcb-document-contract.mjs';
import { probeSyntheticRedirect } from './firefox-redirect-probe.mjs';
import { assertLiveNetworkApi, assertLivePowerClient, assertLiveFieldImport,
  powerGuid, fieldGuid } from './jcb-network-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const receipts = path.join(root, 'test-results');
const browserNames = (process.env.PLAYGROUND_BROWSERS ?? 'chromium,firefox').split(',').map(name => name.trim());
const engines = { chromium, firefox };
const phpVersion = '8.4';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repositoryHosts = new Set(['codeberg.org', 'git.envs.net', 'tildegit.org', 'git.disroot.org', 'git.vdm.dev',
  'api.github.com', 'raw.githubusercontent.com']);

async function bounded(operation, label, timeoutMs = 240_000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Receipts intentionally contain no request headers, cookies, credentials or
// arbitrary user URLs. These are the public endpoints exercised by this gate.
function publicNetworkURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => key !== 'ref')) return null;
  if (url.hostname === 'api.joomlacomponentbuilder.com'
    && url.pathname.startsWith('/v1/network/')) return url.href;
  if (!repositoryHosts.has(url.hostname)) return null;
  if (/\/api\/v1\/repos\/joomla\//.test(url.pathname)
    || /\/repos\/joomengine\/packages\//.test(url.pathname)
    || /\/joomengine\/packages\//.test(url.pathname)) return url.href;
  return null;
}

function observeNetwork(page, record) {
  for (const event of ['request', 'response', 'requestfailed']) {
    page.on(event, item => {
      const url = publicNetworkURL(item.url());
      if (!url) return;
      record.network.push({ event, url, phase: record.phase,
        ...(event === 'request' ? { method: item.method() } : {}),
        ...(event === 'response' ? { status: item.status(), contentType: item.headers()['content-type'] ?? '' } : {}),
        ...(event === 'requestfailed' ? { error: item.failure()?.errorText } : {}) });
    });
  }
  page.on('pageerror', error => record.pageErrors.push(error.message));
}

function successfulRead(events, suffix, label) {
  // A rejected HTTP-200 challenge can precede the valid fallback response.
  // The PHP/client proof is already validated; report its final response.
  const read = events.findLast(event => event.event === 'response' && event.status === 200
    && !/text\/html/i.test(event.contentType)
    && decodeURIComponent(new URL(event.url).pathname).endsWith(suffix));
  assert.ok(read, `${label} must have an observed successful real repository response (${suffix}).`);
  const url = new URL(read.url);
  return { url: read.url, status: read.status, resolvedOrigin: url.origin,
    requestedRef: url.searchParams.get('ref') ?? null };
}

async function launchJcb(page, joomlaVersion) {
  return bounded(page.evaluate(async ({ joomlaVersion, phpVersion }) => {
    const { parseCatalog } = await import('./src/config.mjs');
    const { loadDeployCatalog, resolveDeployConfiguration } = await import('./src/deploys.mjs');
    const { createPlayground } = await import('./src/playground.mjs');
    const manifestURL = new URL('./assets/manifest.json', location.href);
    const catalog = parseCatalog(await (await fetch(manifestURL)).json(), { baseURL: manifestURL.href });
    const deployCatalog = await loadDeployCatalog();
    // The built manifest and recipe select the pinned release. No live API or
    // repository response is intercepted, substituted or cached by this test.
    const { configuration } = await resolveDeployConfiguration({ deployId: 'jcb', joomlaVersion, phpVersion,
      persistence: false, storageKey: `jcb-network-${crypto.randomUUID()}`,
      admin: { username: 'networktester', password: `Network-${crypto.randomUUID()}!` },
    }, { catalog, deployCatalog, baseURL: location.href });
    window.validationProgress = [];
    window.playground = await createPlayground(configuration, {
      onProgress(progress) { window.validationProgress.push(progress); },
    });
    return { joomlaVersion: window.playground.configuration.joomlaVersion,
      phpVersion: window.playground.configuration.phpVersion,
      fromSnapshot: Boolean(window.playground.installation.fromSnapshot) };
  }, { joomlaVersion, phpVersion }), 'Create the clean JCB installation');
}

test('required JCB discovery, repositories, entity import and complete Demo workflow',
  { timeout: 1_200_000 * Math.max(browserNames.length, 1) }, async t => {
    await mkdir(receipts, { recursive: true });
    const setupFile = path.join(receipts, 'jcb-network-setup.json');
    const setup = { status: 'running', directory, browsers: browserNames, startedAt: new Date().toISOString() };
    const save = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
    await save(setupFile, setup);
    let browser, context, page, server, receipt, receiptFile, activeCase;
    const persist = () => receipt ? save(receiptFile, receipt) : save(setupFile, setup);
    const abort = () => {
      if (receipt) { receipt.status = 'timed-out'; receipt.error = String(t.signal.reason); }
      void persist().finally(() => browser?.close().catch(() => {}));
    };
    t.signal.addEventListener('abort', abort, { once: true });
    try {
      assert.ok(browserNames.length && browserNames.every(name => Object.hasOwn(engines, name)), 'Select chromium and/or firefox. Empty selections are invalid.');
      assert.equal(new Set(browserNames).size, browserNames.length, 'Browser selections must be unique.');
      const manifestBytes = await readFile(path.join(directory, 'assets/manifest.json'));
      const inventoryBytes = await readFile(path.join(directory, 'asset-inventory.json'));
      const manifest = JSON.parse(manifestBytes);
      const pairs = ['5', '6'].map(major => {
        const joomla = manifest.joomla.find(entry => entry.version.startsWith(`${major}.`));
        assert.ok(joomla?.php.includes(phpVersion), `The artifact must support Joomla ${major} on PHP ${phpVersion}.`);
        return { joomlaVersion: joomla.version, phpVersion };
      });
      const build = { sourceCommit: manifest.sourceCommit, manifestSha256: sha256(manifestBytes),
        assetInventorySha256: sha256(inventoryBytes),
        networkTransportSha256: sha256(await readFile(path.join(directory, 'src/network-transport.mjs'))),
        phpFetchSha256: sha256(await readFile(path.join(directory, 'src/php-network.mjs'))) };
      setup.status = 'ready'; setup.build = build; setup.requiredPairs = pairs;
      await save(setupFile, setup);
      // Static Pages hosting supplies no isolation headers. Exercise the real
      // service-worker bootstrap before any PHP/network assertion.
      server = await createNetworkFixture({ directory, liveOrigins: [...repositoryHosts].map(host => `https://${host}`).concat('https://api.joomlacomponentbuilder.com') });
      for (const name of browserNames) {
        receiptFile = path.join(receipts, `jcb-network-${name}.json`);
        receipt = { browser: name, status: 'running', build, requiredPairs: pairs,
          liveResponsesSubstituted: false, relayExecution: 'actual Worker with test-only in-memory state', hostedDeploymentValidated: false, cases: [], startedAt: new Date().toISOString() };
        await persist();
        const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
        browser = await engines[name].launch({ headless: true,
          ...(executablePath ? { executablePath } : {}), ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
        receipt.browserVersion = browser.version();
        receipt.documentAssets = await assertJcbDocumentAssets(browser, { directory });
        await persist();
        const redirectProbe = await probeSyntheticRedirect(browser);
        for (const pair of pairs) {
          // PHP/MariaDB WebAssembly contexts are deliberately sequential to
          // avoid RAM contention and to prove each target starts without data.
          activeCase = { ...pair, phase: 'bootstrap', status: 'running', network: [], pageErrors: [] };
          receipt.cases.push(activeCase);
          const phase = async name => {
            activeCase.phase = name;
            console.log(`${receipt.browser} Joomla ${pair.joomlaVersion}: ${name}`);
            await persist();
          };
          context = await browser.newContext();
          await server.attach(context);
          page = await context.newPage();
          page.setDefaultTimeout(30_000);
          page.setDefaultNavigationTimeout(120_000);
          observeNetwork(page, activeCase);
          try {
            await page.goto(new URL('__test__.html', server.url).href);
            await prepareBrowserEnvironment(page);
            assert.equal(await page.evaluate(() => crossOriginIsolated), true);
            activeCase.installation = await launchJcb(page, pair.joomlaVersion);
            await phase('live API through native PHP cURL and HTTP streams');
            activeCase.discovery = await bounded(assertLiveNetworkApi(page), 'Live network discovery');
            await phase('live read-only JCB Power client');
            let from = activeCase.network.length;
            let relayFrom = server.liveReads.length;
            activeCase.power = await bounded(assertLivePowerClient(page), 'Live JCB Power retrieval');
            activeCase.power.resolvedReads = {
              index: successfulRead([...activeCase.network.slice(from), ...server.liveReads.slice(relayFrom)], '/super-powers/raw/super-powers.json', 'The Power index'),
              settings: successfulRead([...activeCase.network.slice(from), ...server.liveReads.slice(relayFrom)], `/src/${powerGuid}/settings.json`, 'Power settings'),
              source: successfulRead([...activeCase.network.slice(from), ...server.liveReads.slice(relayFrom)], `/src/${powerGuid}/code.power`, 'Power source'),
            };
            await phase('real Demo compile, required Powers, ZIP, install and dashboard');
            activeCase.compiler = await bounded(assertJcbCompiler(page, { redirectProbe }), 'Complete Demo workflow', 480_000);
            await phase('live JCB Greeting field entity import');
            from = activeCase.network.length;
            relayFrom = server.liveReads.length;
            activeCase.entity = await bounded(assertLiveFieldImport(page), 'Actual JCB field import');
            activeCase.entity.defaultRelayResponse = server.liveReads.slice(relayFrom)
              .findLast(event => event.url === activeCase.entity.defaultProbe.url) ?? null;
            activeCase.entity.resolvedReads = {
              index: successfulRead([...activeCase.network.slice(from), ...server.liveReads.slice(relayFrom)], '/index/field.json', 'The field index'),
              item: successfulRead([...activeCase.network.slice(from), ...server.liveReads.slice(relayFrom)], `/src/field/${fieldGuid}/item.json`, 'The field entity'),
            };
            assert.deepEqual(activeCase.pageErrors, [], 'Unhandled browser errors must not be hidden by successful HTTP responses.');
            activeCase.status = 'passed';
            await phase('complete');
          } catch (error) {
            activeCase.status = 'failed'; activeCase.error = error.stack || error.message;
            await persist();
            const prefix = path.join(receipts, `jcb-network-${name}-joomla-${pair.joomlaVersion}`);
            await Promise.allSettled([
              page.screenshot({ path: `${prefix}-failure.png`, timeout: 5000, fullPage: true }),
              bounded(page.content(), 'Failure HTML', 5000).then(html => writeFile(`${prefix}-failure.html`, html)),
            ]);
            throw error;
          } finally {
            await bounded(page.evaluate(async () => {
              if (window.playground) await window.playground.close();
            }), 'PHP worker cleanup', 10_000).catch(() => {});
            await context.close(); context = undefined; page = undefined;
          }
        }
        assert.equal(receipt.cases.length, 2);
        assert.ok(receipt.cases.every(item => item.status === 'passed'));
        receipt.status = 'passed'; receipt.finishedAt = new Date().toISOString();
        await persist();
        await browser.close(); browser = undefined;
      }
      setup.status = 'passed'; setup.finishedAt = new Date().toISOString();
      await save(setupFile, setup);
    } catch (error) {
      setup.status = 'failed'; setup.error = error.stack || error.message;
      if (receipt) { receipt.status = 'failed'; receipt.error = setup.error; await persist(); }
      await save(setupFile, setup);
      throw error;
    } finally {
      t.signal.removeEventListener('abort', abort);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await server?.close();
    }
  });
