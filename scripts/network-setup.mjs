import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { normalizeNetworkConfig } from '../src/network-config.mjs';
import { readPolicy } from '../services/network-worker/src/policy.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const owner = 'joomengine/playground/network-setup/v1';
const siteKeyPattern = /^[A-Za-z0-9_-]{16,32}$/;
const run = promisify(execFile);
class SetupError extends Error {}
function requireSetup(value, message) { if (!value) throw new SetupError(message); }

async function boundedJSON(fetcher, url, init, label, limit = 1048576) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', credentials: 'omit',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error('Response too large.');
      chunks.push(chunk);
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks)) };
  } catch {
    throw new SetupError(`${label}: could not read a bounded JSON response. Check connectivity and Cloudflare availability; redirects are not followed.`);
  }
}

function cloudflareAPI(accountId, apiToken, fetcher) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  return async (route, { method = 'GET', body, missing = false, label = 'Cloudflare API' } = {}) => {
    const response = await boundedJSON(fetcher, `${base}${route}`, { method,
      headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }, label);
    const errors = response.body?.errors;
    // Cloudflare error 10007 specifically means a missing Worker/subdomain.
    // A generic 404 or an authorization failure must never authorize creation.
    if (missing && [400, 404].includes(response.status) && errors?.length === 1 && errors[0].code === 10007) return null;
    requireSetup(response.status >= 200 && response.status < 300 && response.body?.success === true,
      `${label}: Cloudflare rejected the request (HTTP ${response.status}). Check the account ID and token permissions for Worker creation/deployment and Turnstile Sites Write in this account.`);
    return response.body;
  };
}

function ownedBindings(bindings, vars, workerName) {
  requireSetup(Array.isArray(bindings), 'Existing Worker has unknown bindings; setup will not modify it.');
  const found = new Map(bindings.map(binding => [binding.name, binding]));
  requireSetup(found.size === bindings.length && found.get('ENABLED')?.text === 'false',
    'Existing Worker is active or its state is unknown; setup will not disable or replace it.');
  for (const [name, text] of Object.entries(vars)) {
    requireSetup(found.get(name)?.type === 'plain_text' && found.get(name).text === text,
      'Existing Worker ownership or policy differs from this setup; review its deployment without running bootstrap.');
  }
  const sitekey = found.get('PLAYGROUND_SETUP_SITEKEY');
  const state = found.get('RELAY_STATE');
  requireSetup(sitekey?.type === 'plain_text' && siteKeyPattern.test(sitekey.text)
    && state?.type === 'durable_object_namespace' && state.class_name === 'RelayCoordinator'
    && (!state.script_name || state.script_name === workerName) && !state.environment && !state.dispatch_namespace
    && typeof state.namespace_id === 'string' && /^[a-f0-9-]{32,36}$/i.test(state.namespace_id),
  'Existing Worker has unknown widget or Durable Object ownership; setup will not modify it.');
  const known = new Set([...Object.keys(vars), 'PLAYGROUND_SETUP_SITEKEY', 'RELAY_STATE', 'TURNSTILE_SECRET_KEY']);
  requireSetup(bindings.every(binding => known.has(binding.name))
    && (!found.has('TURNSTILE_SECRET_KEY') || found.get('TURNSTILE_SECRET_KEY').type === 'secret_text'),
  'Existing Worker has unrecognized bindings; setup will not overwrite its configuration.');
  return { sitekey: sitekey.text, namespaceId: state.namespace_id };
}

async function existingWorker(api, workerName, vars) {
  const prefix = `/workers/scripts/${workerName}`;
  const settings = await api(`${prefix}/settings`, { missing: true, label: 'Read Worker settings' });
  if (settings === null) return null;
  const identity = ownedBindings(settings.result?.bindings, vars, workerName);
  // Settings can describe an unpublished version. Inspect the version actually
  // serving traffic as well, and refuse gradual/unknown deployments.
  const deployments = await api(`${prefix}/deployments`, { label: 'Read active Worker deployment' });
  const active = deployments.result?.deployments?.[0];
  requireSetup(active?.versions?.length === 1 && active.versions[0].percentage === 100
    && /^[A-Za-z0-9-]{16,64}$/.test(active.versions[0].version_id),
  'Existing Worker has a gradual or unknown deployment; setup will not replace it.');
  const versionId = active.versions[0].version_id;
  const version = await api(`${prefix}/versions/${versionId}`, { label: 'Read active Worker bindings' });
  requireSetup(JSON.stringify(ownedBindings(version.result?.resources?.bindings, vars, workerName)) === JSON.stringify(identity),
    'Active Worker widget or Durable Object differs from its current settings; setup will not modify it.');
  return { ...identity, versionId };
}

async function turnstileWidget(api, name, hostname, existingSitekey) {
  let sitekey = existingSitekey;
  if (!sitekey) {
    const matches = [];
    for (let page = 1; ; page++) {
      requireSetup(page <= 10, 'Turnstile widget inventory exceeds the setup limit; review the account manually.');
      const listing = await api(`/challenges/widgets?per_page=1000&page=${page}`, { label: 'List Turnstile widgets' });
      requireSetup(Array.isArray(listing.result), 'Cloudflare returned an unknown Turnstile inventory.');
      matches.push(...listing.result.filter(widget => widget.name === name));
      if (listing.result.length < 1000) break;
    }
    requireSetup(matches.length <= 1, 'Multiple setup Turnstile widgets have the same name; resolve the ambiguity in Cloudflare first.');
    sitekey = matches[0]?.sitekey;
  }
  requireSetup(!sitekey || siteKeyPattern.test(sitekey), 'The existing Turnstile widget has an invalid public site key.');
  const created = !sitekey;
  const response = await api(sitekey ? `/challenges/widgets/${sitekey}` : '/challenges/widgets', {
    method: sitekey ? 'GET' : 'POST', label: sitekey ? 'Read Turnstile widget' : 'Create Turnstile widget',
    ...(sitekey ? {} : { body: { name, domains: [hostname], mode: 'managed', clearance_level: 'no_clearance' } }),
  });
  const widget = response.result;
  requireSetup(widget?.name === name && widget.mode === 'managed' && widget.domains?.length === 1
    && widget.domains[0] === hostname && widget.clearance_level === 'no_clearance'
    && siteKeyPattern.test(widget.sitekey) && !/^[123]x0{20,}/.test(widget.sitekey) && (!sitekey || widget.sitekey === sitekey)
    && typeof widget.secret === 'string' && widget.secret.length >= 16 && widget.secret.length <= 2048
    && !/^[123]x0{20,}/.test(widget.secret), 'Turnstile widget does not match this production setup; its domains, mode and real secret must be reviewed.');
  return { sitekey: widget.sitekey, secret: widget.secret, created };
}

async function deployWorker({ directory, configPath, secretsPath, accountId, apiToken, temporary }) {
  try {
    await run(process.execPath, [path.join(directory, 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
      '--config', configPath, '--env', 'production', '--secrets-file', secretsPath], {
      cwd: directory, timeout: 180000, maxBuffer: 1048576,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken,
        CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error', WRANGLER_LOG_PATH: path.join(temporary, 'wrangler.log') },
    });
  } catch {
    // Wrangler/API diagnostics can contain secret payloads. Do not attach the
    // original error or retain command output in logs or artifacts.
    throw new SetupError('Wrangler deployment failed. Check Worker creation/deployment permissions, account restrictions and Durable Objects availability in Cloudflare. No Pages changes were made; rerun setup after resolving the account issue.');
  }
}

export async function verifyDisabledRelay(endpoint, origin, { fetcher = fetch, timeoutMs = 60000, retryMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const options = { signal: controller.signal, cache: 'no-store' };
        const health = await boundedJSON(fetcher, `${endpoint}/healthz`, options, 'Verify disabled relay', 4096);
        requireSetup(health.status === 200 && health.body?.version === 1 && health.body.enabled === false
          && health.body.mode === 'controlled-origins', 'Disabled relay health did not match.');
        for (const route of ['/v1/session', '/v1/fetch']) {
          const denied = await boundedJSON(fetcher, `${endpoint}${route}`, { ...options, method: 'POST', headers: { Origin: origin } }, 'Verify disabled relay rejection', 4096);
          requireSetup(denied.status === 503 && denied.body?.version === 1 && denied.body.error?.code === 'RELAY_DISABLED', 'Disabled relay did not reject access.');
        }
        return;
      } catch {
        if (controller.signal.aborted || attempt === 11) break;
        try { await delay(retryMs, undefined, { signal: controller.signal }); } catch { break; }
      }
    }
    throw new SetupError('The Worker was deployed, but disabled health/rejection checks did not pass within the setup deadline. Inspect Cloudflare and rerun; the Playground has not been activated.');
  } finally { clearTimeout(timer); }
}

export async function setupNetworkWorker({ root = projectRoot, accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN, fetcher = fetch, deploy = deployWorker, healthOptions = {} } = {}) {
  requireSetup(/^[a-f0-9]{32}$/i.test(accountId || ''), 'Set CLOUDFLARE_ACCOUNT_ID to the 32-character Cloudflare account ID.');
  requireSetup(typeof apiToken === 'string' && apiToken.length > 0 && !/[\r\n]/.test(apiToken), 'Set the CLOUDFLARE_API_TOKEN GitHub secret.');
  const directory = path.join(root, 'services/network-worker');
  const config = JSON.parse(await readFile(path.join(directory, 'wrangler.jsonc'), 'utf8'));
  const selected = config.env?.production;
  const hostname = (await readFile(path.join(root, 'CNAME'), 'utf8')).trim();
  requireSetup(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname), 'CNAME must contain the reviewed Playground hostname.');
  requireSetup(/^[a-z0-9][a-z0-9-]{0,62}$/.test(selected?.name || '')
    && selected.vars?.ENABLED === 'false' && selected.vars?.DEPLOYMENT_ENV === 'production'
    && selected.vars?.TURNSTILE_TEST_MODE === 'false', 'Setup requires the checked-in disabled production Worker configuration; use the release procedure for an active service.');
  const publicVars = new Set(['ENABLED', 'DEPLOYMENT_ENV', 'TURNSTILE_TEST_MODE', 'RELAY_AUDIENCE', 'ALLOWED_ORIGINS',
    'UPSTREAM_ORIGINS', 'CREDENTIAL_ORIGINS', 'ALLOWED_PORTS', 'ALLOWED_METHODS', 'POLICY_VERSION', 'REVOKED_SESSION_IDS', 'TURNSTILE_ACTION', 'LIMITS']);
  requireSetup(Object.entries(selected.vars).every(([key, value]) => publicVars.has(key) && typeof value === 'string'),
    'Production Worker variables must contain only the reviewed public policy; provision secrets separately.');
  requireSetup(selected.durable_objects?.bindings?.length === 1
    && selected.durable_objects.bindings[0].name === 'RELAY_STATE'
    && selected.durable_objects.bindings[0].class_name === 'RelayCoordinator', 'Setup requires the existing RelayCoordinator Durable Object binding.');
  const api = cloudflareAPI(accountId, apiToken, fetcher);
  const accountSubdomain = await api('/workers/subdomain', { missing: true, label: 'Read account workers.dev subdomain' });
  const subdomain = accountSubdomain?.result?.subdomain;
  requireSetup(typeof subdomain === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain),
    'Configure the account workers.dev subdomain in Cloudflare Workers & Pages, then rerun setup. Setup never changes the account-wide subdomain.');
  const workerName = selected.name;
  const endpoint = `https://${workerName}.${subdomain}.workers.dev`;
  const playgroundOrigin = `https://${hostname}`;
  const vars = { ...selected.vars, ENABLED: 'false', RELAY_AUDIENCE: endpoint,
    ALLOWED_ORIGINS: JSON.stringify([playgroundOrigin]), PLAYGROUND_SETUP_OWNER: owner };
  readPolicy(vars);
  const existing = await existingWorker(api, workerName, vars);
  const widgetName = `${workerName} / ${hostname} / network-setup-v1`;
  const widget = await turnstileWidget(api, widgetName, hostname, existing?.sitekey);
  const deployedVars = { ...vars, PLAYGROUND_SETUP_SITEKEY: widget.sitekey };
  readPolicy({ ...deployedVars, TURNSTILE_SECRET_KEY: widget.secret });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'playground-network-setup-'));
  await chmod(temporary, 0o700);
  try {
    const configPath = path.join(temporary, 'wrangler.json');
    const secretsPath = path.join(temporary, 'secrets.json');
    await writeFile(configPath, JSON.stringify({ ...config, account_id: accountId, main: path.resolve(directory, config.main),
      env: { production: { ...selected, vars: deployedVars } } }), { mode: 0o600 });
    await writeFile(secretsPath, JSON.stringify({ TURNSTILE_SECRET_KEY: widget.secret }), { mode: 0o600 });
    // Re-read just before deploying: do not overwrite an activation or another
    // deployment that happened while the widget was being provisioned.
    const current = await existingWorker(api, workerName, vars);
    requireSetup(JSON.stringify(current) === JSON.stringify(existing), 'The Worker changed during setup; no deployment was attempted. Rerun after reviewing the current Worker.');
    await deploy({ directory, configPath, secretsPath, accountId, apiToken, temporary });
  } finally { await rm(temporary, { recursive: true, force: true }); }
  await verifyDisabledRelay(endpoint, playgroundOrigin, { fetcher, ...healthOptions });
  const publicConfig = normalizeNetworkConfig({ enabled: false, endpoint, turnstileSiteKey: widget.sitekey });
  const summary = { status: 'configured-disabled', workerName, endpoint, playgroundOrigin,
    turnstileSiteKey: widget.sitekey, widgetCreated: widget.created, workerCreated: existing === null,
    relayActivated: false, pagesChanged: false, upstreamPolicyReviewRequired: true };
  const output = path.join(root, 'test-results/network-setup');
  await mkdir(output, { recursive: true });
  for (const [name, value] of [['network.production.candidate.json', publicConfig],
    ['worker-policy.candidate.json', { name: workerName, vars: deployedVars }], ['setup-summary.json', summary]]) {
    await writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await setupNetworkWorker();
    console.log(JSON.stringify(summary));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Cloudflare proxy setup\n\nWorker: \`${summary.workerName}\`\n\nEndpoint: ${summary.endpoint}\n\nPublic Turnstile site key: \`${summary.turnstileSiteKey}\`\n\n` +
      'The relay is configured but **disabled**. GitHub Pages was not changed. Review upstream origins and complete activation separately.\n\n' +
      'Public setup artifact files: `network.production.candidate.json`, `worker-policy.candidate.json`, `setup-summary.json`.\n');
  }
  catch (error) {
    console.error(error instanceof SetupError ? error.message : 'Network setup failed before completion. Review the checked-in configuration; no activation or Pages changes were requested.');
    process.exitCode = 1;
  }
}
