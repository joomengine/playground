import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readPolicy } from '../services/network-worker/src/policy.mjs';

export function validateNetworkDeployment(config, environment, credentials = process.env) {
  assert.ok(['staging', 'production'].includes(environment), 'Choose staging or production.');
  const selected = config.env?.[environment];
  assert.ok(selected?.durable_objects?.bindings?.some(binding => binding.name === 'RELAY_STATE'), 'Explicit state binding required.');
  assert.equal(selected.vars?.ENABLED, 'true', 'Enable the selected Worker configuration before deployment.');
  assert.equal(selected.vars.DEPLOYMENT_ENV, environment, 'Worker deployment environment must match the selected configuration.');
  assert.equal(selected.vars.TURNSTILE_TEST_MODE, environment === 'staging' ? 'true' : 'false',
    'Automated staging uses isolated test mode; production requires real verification.');
  const policy = readPolicy({ ...selected.vars,
    TURNSTILE_SECRET_KEY: environment === 'staging' ? '1x0000000000000000000000000000000AA' : 'checked-by-separate-runtime-secret-binding',
    STAGING_TEST_SECRET: 'configuration-validation-only-not-a-server-secret',
  });
  assert.ok(policy.enabled && policy.upstreamOrigins.size && policy.allowedOrigins.size);
  assert.equal(new URL(policy.audience).protocol, 'https:', 'Hosted relay activation requires HTTPS.');
  assert.ok([...policy.allowedOrigins].every(origin => new URL(origin).protocol === 'https:'), 'Hosted browser origins must use HTTPS.');
  assert.ok(credentials.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID environment variable is required.');
  assert.ok(credentials.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN protected environment secret is required.');
  return { environment, endpoint: policy.audience, mode: 'controlled-origins',
    cloudflarePlan: credentials.NETWORK_CLOUDFLARE_PLAN, upstreamOriginCount: policy.upstreamOrigins.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(new URL('../services/network-worker/wrangler.jsonc', import.meta.url), 'utf8'));
  const result = validateNetworkDeployment(config, process.argv[2]);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `endpoint=${result.endpoint}\n`);
  console.log(JSON.stringify(result));
}
