import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './assets.mjs';
import { writeBuildIdentity } from './build-identity.mjs';
import { normalizeNetworkConfig } from '../src/network-config.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const commitPattern = /^[a-f0-9]{40}$/;

/** Reuse runtime bytes only when their source and every build input are unchanged. */
export function configurationOnlyChanges(files) {
  return Array.isArray(files) && files.includes('config/network.json') && files.every(file =>
    file === 'config/network.json' || file === 'README.md'
    || /^(?:\.github|test|docs|services\/network-worker)\//.test(file)
    || /^scripts\/(?:network-(?:setup|deployment-check|release-evidence|health)|pages-(?:smoke|config-release))\.mjs$/.test(file));
}

function changedFiles(root, sourceCommit, headCommit) {
  assert.match(sourceCommit, commitPattern); assert.match(headCommit, commitPattern);
  execFileSync('git', ['merge-base', '--is-ancestor', sourceCommit, headCommit], { cwd: root, stdio: 'pipe' });
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', sourceCommit, headCommit],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/** Missing/expired evidence selects the existing full-build publication path. */
export async function selectConfigurationArtifact({ repository, sourceRunId, sourceCommit, headCommit,
  token, root = projectRoot, fetcher = fetch, changes = changedFiles } = {}) {
  const fallback = { reuse: false };
  try {
    assert.match(repository || '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(String(sourceRunId || ''), /^\d+$/);
    assert.match(sourceCommit || '', commitPattern); assert.match(headCommit || '', commitPattern);
    if (!configurationOnlyChanges(changes(root, sourceCommit, headCommit))) return fallback;
    const base = `https://api.github.com/repos/${repository}/actions/runs/${sourceRunId}`;
    const get = async url => {
      const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      assert.ok(response.ok, 'Cannot read prior publication evidence.');
      return response.json();
    };
    const run = await get(base);
    assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
    assert.equal(run.path, '.github/workflows/pages.yml'); assert.equal(run.head_branch, 'main');
    assert.equal(run.head_sha, sourceCommit);
    assert.equal(run.repository?.full_name, repository); assert.equal(run.head_repository?.full_name, repository);
    const { artifacts } = await get(`${base}/artifacts?per_page=100&name=playground-static`);
    const candidates = artifacts.filter(artifact => artifact.name === 'playground-static' && !artifact.expired);
    assert.equal(candidates.length, 1, 'A single retained runtime artifact is required.');
    const artifact = candidates[0];
    assert.equal(artifact.workflow_run?.head_sha, sourceCommit);
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.size_in_bytes > 0);
    return { reuse: true, sourceRunId: String(sourceRunId), sourceCommit, artifactId: String(artifact.id) };
  } catch {
    return fallback;
  }
}

/** Publish new network settings with the already-tested, unchanged runtime bytes. */
export async function prepareConfigurationRelease({ root = projectRoot, directory = path.join(root, 'dist'),
  sourceCommit, headCommit, sourceRunId, artifactId, changes = changedFiles } = {}) {
  assert.match(sourceCommit || '', commitPattern); assert.match(headCommit || '', commitPattern);
  assert.match(String(sourceRunId || ''), /^\d+$/); assert.match(String(artifactId || ''), /^\d+$/);
  assert.ok(configurationOnlyChanges(changes(root, sourceCommit, headCommit)),
    'Runtime/build input changes require a fresh build.');
  const inventoryPath = path.join(directory, 'asset-inventory.json');
  const declared = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.deepEqual((await inventory(directory)).filter(file => file.path !== 'asset-inventory.json'), declared,
    'The retained artifact must match every recorded file hash.');
  const manifestPath = path.join(directory, 'assets/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceCommit, sourceCommit);
  assert.equal(manifest.deployment?.environment, 'production');
  const config = normalizeNetworkConfig(JSON.parse(await readFile(path.join(root, 'config/network.json'), 'utf8')));
  if (config.enabled) assert.ok(config.turnstileSiteKey && !/^[123]x0{20}[A-Z]{2}$/.test(config.turnstileSiteKey),
    'Enabled production networking requires its real public Turnstile site key.');
  manifest.network = config;
  manifest.sourceCommit = headCommit;
  manifest.configurationRelease = { sourceCommit, sourceRunId: String(sourceRunId), artifactId: String(artifactId) };
  await writeFile(path.join(directory, 'config/network.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const buildId = await writeBuildIdentity(directory, manifest);
  await writeFile(inventoryPath, `${JSON.stringify((await inventory(directory))
    .filter(file => file.path !== 'asset-inventory.json'), null, 2)}\n`);
  return { sourceCommit: headCommit, reusedSourceCommit: sourceCommit, buildId, networkEnabled: config.enabled,
    endpoint: config.endpoint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = { repository: process.env.GITHUB_REPOSITORY, sourceRunId: process.env.PAGES_CONFIG_SOURCE_RUN_ID,
    sourceCommit: process.env.PAGES_CONFIG_SOURCE_COMMIT, headCommit: process.env.GITHUB_SHA,
    artifactId: process.env.PAGES_CONFIG_ARTIFACT_ID, token: process.env.GITHUB_TOKEN };
  if (process.argv[2] === 'plan') {
    const result = process.env.GITHUB_EVENT_NAME === 'push' ? await selectConfigurationArtifact(options) : { reuse: false };
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `reuse=${result.reuse}\nsource_run_id=${result.sourceRunId || ''}\nsource_commit=${result.sourceCommit || ''}\nartifact_id=${result.artifactId || ''}\n`);
    console.log(result.reuse ? 'Reusing verified runtime for a network-configuration-only publication.'
      : 'Publishing through the normal full-build workflow.');
  } else if (process.argv[2] === 'prepare') {
    const { createBuildCanaries, verifyPublicArtifact } = await import('./public-artifact-security.mjs');
    const { checkNetworkHealth } = await import('./network-health.mjs');
    const result = await prepareConfigurationRelease(options);
    const security = await verifyPublicArtifact({ directory: path.join(projectRoot, 'dist'),
      canaries: createBuildCanaries(), environment: 'production' });
    if (result.networkEnabled) await checkNetworkHealth(result.endpoint);
    await mkdir(path.join(projectRoot, 'test-results'), { recursive: true });
    await writeFile(path.join(projectRoot, 'test-results/pages-config-release.json'), `${JSON.stringify({ ...result, security }, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } else throw new Error('Choose plan or prepare.');
}
