import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { readPolicy } from '../services/network-worker/src/policy.mjs';
import { assertHostedStagingEvidence } from './network-release-evidence.mjs';

const environment = process.argv[2];
assert.ok(['staging', 'production'].includes(environment), 'Choose staging or production.');
const config = JSON.parse(await readFile(new URL('../services/network-worker/wrangler.jsonc', import.meta.url), 'utf8'));
const selected = config.env[environment];
assert.ok(selected?.durable_objects?.bindings?.some(binding => binding.name === 'RELAY_STATE'), 'Explicit state binding required.');
assert.equal(selected.vars?.ENABLED, 'true', 'Provision and review the disabled Worker first, then explicitly enable its environment before activation.');
const policy = readPolicy({ ...selected.vars, TURNSTILE_SECRET_KEY: 'checked-by-separate-runtime-secret-binding' });
assert.ok(policy.enabled && policy.upstreamOrigins.size && policy.allowedOrigins.size);
assert.equal(new URL(policy.audience).protocol, 'https:', 'Hosted relay activation requires HTTPS.');
assert.ok([...policy.allowedOrigins].every(origin => new URL(origin).protocol === 'https:'), 'Hosted browser origins must use HTTPS.');
assert.ok(process.env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID environment variable is required.');
assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN protected environment secret is required.');
assert.ok(process.env.NETWORK_CLOUDFLARE_PLAN, 'Record the selected Cloudflare plan in NETWORK_CLOUDFLARE_PLAN before activation.');
if (environment === 'production') {
  assert.equal(config.env.staging.vars.ENABLED, 'true', 'Production activation requires an enabled reviewed staging configuration.');
  const runId = process.env.NETWORK_STAGING_RUN_ID;
  assert.match(runId || '', /^\d+$/, 'A successful staging workflow run ID is required.');
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository || '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, { headers });
  assert.ok(response.ok, 'Cannot verify the staging workflow run.');
  const run = await response.json();
  const jobsResponse = await fetch(`${run.jobs_url}?per_page=100`, { headers });
  assert.ok(jobsResponse.ok, 'Cannot verify hosted acceptance steps.');
  const { jobs } = await jobsResponse.json();
  assertHostedStagingEvidence(run, jobs, process.env.GITHUB_SHA);
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `endpoint=${policy.audience}\n`);
console.log(JSON.stringify({ environment, endpoint: policy.audience, mode: 'controlled-origins',
  cloudflarePlan: process.env.NETWORK_CLOUDFLARE_PLAN, upstreamOriginCount: policy.upstreamOrigins.size }));
