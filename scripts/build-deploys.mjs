import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './assets.mjs';
import { createNodeRuntime } from './node-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function administrator(prefix) {
  const identity = `${prefix}_${randomBytes(6).toString('hex')}`;
  return { name: `${prefix} administrator`, username: identity, email: `${identity}@example.test`, password: `Pg!${randomBytes(24).toString('hex')}` };
}

/** Publish a prepared recipe only after a separate runtime restores its export. */
export async function buildDeploys({ directory = process.env.PLAYGROUND_DIST || path.join(root, 'dist') } = {}) {
  const distribution = path.resolve(directory);
  const inventoryPath = path.join(distribution, 'asset-inventory.json');
  const inventoryBytes = await readFile(inventoryPath);
  const declared = JSON.parse(inventoryBytes);
  assert.deepEqual((await inventory(distribution)).filter((entry) => entry.path !== 'asset-inventory.json'), declared,
    'The input static artifact must match its build inventory before generating prepared deploys.');
  const declaredPaths = new Set(declared.map((entry) => entry.path));
  const manifestPath = path.join(distribution, 'assets/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const canonicalURL = new URL(manifest.deployment.canonicalUrl);
  const manifestURL = new URL('assets/manifest.json', canonicalURL);
  const [{ parseCatalog }, { loadDeployCatalog, normalizeDeploy, resolveDeployConfiguration }, { installJoomla, importJoomlaSnapshot, requestJoomlaPage }] = await Promise.all([
    import(pathToFileURL(path.join(distribution, 'src/config.mjs'))),
    import(pathToFileURL(path.join(distribution, 'src/deploys.mjs'))),
    import(pathToFileURL(path.join(distribution, 'src/joomla/index.mjs'))),
  ]);
  const fetchAsset = async (value) => {
    const url = new URL(value instanceof Request ? value.url : value, canonicalURL);
    if (url.origin !== canonicalURL.origin || !url.pathname.startsWith(canonicalURL.pathname) || url.search || url.hash) {
      throw new Error(`Prepared deploys must use verified staged assets: ${url.href}`);
    }
    const relative = decodeURIComponent(url.pathname.slice(canonicalURL.pathname.length));
    const filename = path.resolve(distribution, relative);
    if (!filename.startsWith(`${distribution}${path.sep}`) || !declaredPaths.has(relative)) {
      throw new Error(`The deploy asset is absent from the verified inventory: ${relative}`);
    }
    return new Response(await readFile(filename));
  };
  const catalog = parseCatalog(manifest);
  const deployCatalog = await loadDeployCatalog({ url: new URL(manifest.deploys.url, manifestURL), fetcher: fetchAsset });
  const recipes = [];
  for (const descriptor of deployCatalog.deploys) {
    const bytes = await (await fetchAsset(descriptor.url)).arrayBuffer();
    const recipe = JSON.parse(new TextDecoder().decode(bytes));
    const normalized = normalizeDeploy(recipe, { baseURL: descriptor.url });
    if (normalized.prebuild) recipes.push({ descriptor, recipe, normalized, sourceSha256: digest(new Uint8Array(bytes)) });
  }
  if (!recipes.length) {
    console.log('No repository deploys request a prepared copy.');
    return [];
  }
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const staging = await mkdtemp(path.join(root, '.cache', 'deploy-snapshots-'));
  const prepared = [];
  try {
    for (const { descriptor, recipe, normalized, sourceSha256 } of recipes) {
      for (const release of catalog.joomla.filter((entry) => normalized.joomla.includes(entry.version.split('.')[0]))) {
        const phpVersion = release.php.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : release.php[0];
        const label = `${descriptor.id} / Joomla ${release.version} / PHP ${phpVersion}`;
        console.log(`Preparing ${label}…`);
        const { configuration } = await resolveDeployConfiguration({
          deployId: descriptor.id, joomlaVersion: release.version, phpVersion,
          fresh: true, persistence: false, autoLogin: false, admin: administrator('build'),
        }, { catalog, deployCatalog, baseURL: canonicalURL.href, fetcher: fetchAsset });
        let runtime;
        let exported;
        try {
          runtime = await createNodeRuntime({ directory: distribution, phpVersion });
          const archive = await fetchAsset(new URL(release.url, manifestURL));
          const installed = await installJoomla(runtime, configuration, {
            archiveBytes: await archive.arrayBuffer(), sha256: release.sha256,
            sourceLoader: runtime.sourceLoader, fetchPackage: fetchAsset,
            progress: ({ message }) => { if (message) console.log(`  ${message}`); },
          });
          assert.equal(installed.version, release.version);
          assert.equal(installed.resumed, false);
          exported = await runtime.exportSite({ format: 'bundle' });
        } finally { await runtime?.close(); }

        const sha256 = digest(exported.bytes);
        const restoredConfig = {
          ...configuration, fresh: false, autoLogin: true, admin: administrator('restore'),
          siteName: `${configuration.siteName.slice(0, 75)} import verification`,
        };
        assert.notEqual(restoredConfig.admin.username, configuration.admin.username);
        assert.notEqual(restoredConfig.admin.password, configuration.admin.password);
        try {
          runtime = await createNodeRuntime({ directory: distribution, phpVersion });
          const imported = await importJoomlaSnapshot(runtime, restoredConfig, {
            archiveBytes: exported.bytes, sha256,
            sourceLoader: runtime.sourceLoader, fetchPackage: fetchAsset,
          });
          assert.equal(imported.fromSnapshot, true, 'The prepared copy must use the snapshot importer.');
          assert.equal(imported.version, release.version, 'Restored Joomla must match its declared version.');
          assert.equal(imported.siteName, restoredConfig.siteName, 'Snapshot import must apply the receiving site name.');
          assert.equal(imported.administrator.username, restoredConfig.admin.username, 'Snapshot import must rotate the administrator.');
          const administratorPage = await requestJoomlaPage(runtime, 'administrator/index.php');
          assert.equal(administratorPage.status, 200, 'The restored administrator page must respond successfully.');
          const administratorHTML = await administratorPage.text();
          assert.doesNotMatch(administratorHTML, /name=["']passwd["']/i, 'The restored page must not be the login form.');
          assert.match(administratorHTML, /task=logout|value=["']logout["']/i,
            'The restored administrator page must use the new authenticated session.');
        } finally { await runtime?.close(); runtime = undefined; }

        const filename = `${descriptor.id}-${release.version}-${sha256}.zip`;
        await writeFile(path.join(staging, filename), exported.bytes);
        const snapshot = {
          url: `../assets/snapshots/${filename}`, sha256, format: 'joomengine-playground-export',
          schemaVersion: 1, joomlaVersion: release.version,
        };
        const major = release.version.split('.')[0];
        recipe.variants ??= {};
        recipe.variants[major] = { ...recipe.variants[major], snapshot };
        prepared.push({ id: descriptor.id, joomlaVersion: release.version, phpVersion,
          url: `snapshots/${filename}`, sha256, size: exported.bytes.byteLength,
          sourceSha256, sourceInventorySha256: digest(inventoryBytes), verifiedImport: true });
        console.log(`Verified independent import of ${label} (${exported.bytes.byteLength} bytes).`);
      }
      normalizeDeploy(recipe, { baseURL: descriptor.url });
    }
    assert.deepEqual((await inventory(distribution)).filter((entry) => entry.path !== 'asset-inventory.json'), declared,
      'The input artifact changed while prepared deploys were being generated.');
    await mkdir(path.join(distribution, 'assets/snapshots'), { recursive: true });
    for (const item of prepared) await cp(path.join(staging, path.basename(item.url)), path.join(distribution, 'assets', item.url));
    for (const { descriptor, recipe } of recipes) {
      await writeFile(path.join(distribution, 'deploys', `${descriptor.id}.json`), `${JSON.stringify(recipe, null, 2)}\n`);
    }
    manifest.prebuiltDeploys = prepared;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(inventoryPath, `${JSON.stringify((await inventory(distribution)).filter((entry) => entry.path !== 'asset-inventory.json'), null, 2)}\n`);
    console.log(`Published ${prepared.length} verified prepared deploys.`);
    return prepared;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDeploys();
