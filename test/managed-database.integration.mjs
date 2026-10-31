import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { ensureManagedDatabaseConfiguration, managedDatabaseSource } from '../src/joomla/managed-database.mjs';

const root = path.resolve(process.env.PLAYGROUND_DIST || 'dist');
const paths = {
  model: 'administrator/components/com_config/src/Model/ApplicationModel.php',
  console: 'libraries/src/Console/SetConfigurationCommand.php',
};

test('new Joomla versions reuse only byte-identical reviewed database guards', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'assets/manifest.json'), 'utf8'));
  const sources = new Map();
  for (const release of manifest.joomla) {
    const archive = await readFile(path.join(root, 'assets', release.url));
    const files = unzipSync(archive, { filter: ({ name }) => Object.values(paths).includes(name) });
    const pair = {};
    for (const [kind, name] of Object.entries(paths)) {
      assert.ok(files[name], `${release.version}: ${name} must exist in the reviewed package`);
      const source = new TextDecoder('utf-8', { fatal: true }).decode(files[name]);
      pair[kind] = source;
      const stable = await managedDatabaseSource(source, release.version, kind);
      const alias = `${release.version}-unlisted-dev`;
      const nightly = await managedDatabaseSource(source, alias, kind);
      assert.equal(nightly.source, stable.source, 'an unchanged source must use exactly the reviewed adapter');
      assert.equal(nightly.sourceSha256, stable.sourceSha256);
      assert.equal(nightly.changed, true);
      assert.equal((await managedDatabaseSource(nightly.source, alias, kind)).changed, false, 'reopening is idempotent');
      await assert.rejects(managedDatabaseSource(`${source}\n`, alias, kind), /reviewed source checksum/);
      await assert.rejects(managedDatabaseSource(`${nightly.source}\n`, alias, kind), /reviewed source checksum/);
    }
    sources.set(release.version, pair);
  }
  const versions = [...sources.keys()];
  assert.ok(versions.length >= 2, 'both reviewed major versions must be tested');
  await assert.rejects(managedDatabaseSource(sources.get(versions[0]).model, versions[1], 'model'), /reviewed source checksum/);

  const [reviewed] = sources.values();
  const writes = [];
  const runtime = { documentRoot: '/persist/www', fs: {
    async readFile(name) { return name.endsWith(paths.model) ? reviewed.model : `${reviewed.console}\n`; },
    async writeFile(...args) { writes.push(args); },
  } };
  await assert.rejects(ensureManagedDatabaseConfiguration(runtime, 'new-dev'), /reviewed source checksum/);
  assert.deepEqual(writes, [], 'a failed source check must not partially patch the site');
});
