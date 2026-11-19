import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, forwardVersion, metadata, registry, registryEntry } from './npm-releases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const noticeDirectory = 'dependencies/joomengine-code';
const provenanceFile = `${noticeDirectory}/provenance.json`;
const integration = '@codingame/monaco-vscode-api';
const languagePackages = ['php-parser', 'vscode-html-languageservice', 'vscode-languageserver-textdocument'];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
function revision(value) {
  assert.match(value, /^[0-9a-f]{40}$/, 'Expected immutable Git source revision');
  return value;
}

export function updateEditorPins(manifest, releases) {
  const next = structuredClone(manifest);
  for (const [name, current] of Object.entries(manifest.dependencies)) {
    let upstream;
    let alias = '';
    if (name.startsWith('@codingame/monaco-vscode-')) upstream = integration;
    else if (['vscode', 'monaco-editor'].includes(name)) {
      const target = name === 'vscode' ? 'extension-api' : 'editor-api';
      alias = `npm:@codingame/monaco-vscode-${target}@`;
      assert.ok(current.startsWith(alias), `Unexpected ${name} alias`);
      upstream = integration;
    } else if (languagePackages.includes(name)) upstream = name;
    else continue;
    next.dependencies[name] = alias + forwardVersion(name, current.slice(alias.length), releases[upstream].version);
  }
  return next;
}

function sourceTag(repository, tag) {
  assert.match(tag, /^v?\d+\.\d+\.\d+$/);
  const ref = `refs/tags/${tag}`;
  const lines = execFileSync('git', ['ls-remote', '--exit-code', repository, ref, `${ref}^{}`], { encoding: 'utf8' }).trim().split('\n');
  const refs = Object.fromEntries(lines.map(line => line.split('\t').reverse()));
  return revision(refs[`${ref}^{}`] || refs[ref]);
}

export function verifiedArchive(bytes, pin) {
  assert.equal(new URL(pin.resolved).origin, registry);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pin.integrity, `npm integrity mismatch for ${pin.resolved}`);
  // Only stream the requested regular package files. No archive paths are written to disk.
  return filename => execFileSync('tar', ['-xzO', '-f', '-', `package/${filename}`], { input: bytes, maxBuffer: 32 * 1024 * 1024 });
}

const embeddedFiles = {
  'vscode-oniguruma': { notices: ['LICENSE.txt', 'NOTICES.txt'], bundled: 'release/onig.wasm' },
  'vscode-textmate': { notices: ['LICENSE.md'] },
  '@vscode/codicons': { notices: ['LICENSE', 'LICENSE-CODE'], bundled: 'dist/codicon.ttf' },
};

async function editorEvidence(staged, release, previous, files) {
  const evidence = structuredClone(previous);
  const [codingame, vscode, monaco] = evidence.upstream;
  const raw = (repository, commit, filename) => `${repository.replace('github.com', 'raw.githubusercontent.com')}/${revision(commit)}/${filename}`;
  const codingameSource = filename => raw(codingame.repository, release.gitHead, filename);
  const [upstream, upstreamLock] = await Promise.all([metadata(codingameSource('package.json')), metadata(codingameSource('package-lock.json'))]);
  assert.equal(upstream.name, integration);
  assert.equal(upstream.license, 'MIT');
  evidence.integrationVersion = release.version;
  Object.assign(codingame, { version: release.version, revision: revision(release.gitHead) });
  Object.assign(vscode, { version: upstream.config.vscode.version, revision: revision(upstream.config.vscode.commit) });
  Object.assign(monaco, { version: upstream.config.monaco.version, revision: sourceTag(monaco.repository, upstream.config.monaco.ref) });
  function notice(name, bytes) {
    assert.ok(bytes.length > 100 && !/^\s*</.test(bytes.toString('utf8', 0, 32)), `Invalid licence file ${name}`);
    files.set(`${noticeDirectory}/${name}`, bytes);
    evidence.noticeDigests[name] = sha256(bytes);
  }
  await Promise.all(evidence.upstream.flatMap((entry, i) => entry.noticeFiles.map(async (name, index) => {
    const filename = i === 0 ? 'LICENSE' : ['LICENSE.txt', 'ThirdPartyNotices.txt'][index];
    notice(name, await download(raw(entry.repository, entry.revision, filename)));
  })));
  const lock = await readJson(path.join(staged, 'package-lock.json'));
  await Promise.all(evidence.embeddedPackages.map(async entry => {
    const pin = upstreamLock.packages[`node_modules/${entry.name}`];
    assert.equal(pin.license, entry.licence, `Review licence change for ${entry.name}`);
    assert.equal(new URL(pin.resolved).origin, registry);
    const member = verifiedArchive(await download(pin.resolved), pin);
    const layout = embeddedFiles[entry.name];
    entry.noticeFiles.forEach((name, i) => notice(name, member(layout.notices[i])));
    if (layout.bundled) assert.ok(member(layout.bundled).equals(await readFile(path.join(staged, entry.verifiedBundledFile))), `Embedded ${entry.name} differs from the verified npm archive`);
    Object.assign(entry, { version: pin.version, resolved: pin.resolved, integrity: pin.integrity });
  }));
  const charset = evidence.correspondingSource[0];
  const pin = lock.packages[`node_modules/${charset.name}`];
  assert.ok(['LGPL-2.1+', 'LGPL-2.1-or-later'].includes(pin.license), `Review ${charset.name} licence`);
  if (pin.integrity !== charset.integrity) {
    const published = await metadata(registryEntry(charset.name, pin.version));
    assert.equal(published.dist.integrity, pin.integrity);
    Object.assign(charset, { version: pin.version, resolved: pin.resolved, integrity: pin.integrity, revision: revision(published.gitHead) });
  }
  const adaptation = evidence.localAdaptations[0];
  const source = await readFile(path.join(staged, 'node_modules', adaptation.sourceFile));
  for (const anchor of ['const utf8TextDecoder = ( new TextDecoder());', 'if (encoding !== UTF8) {']) {
    assert.equal(source.toString().split(anchor).length, 2, `Review updated VS Code decoder in ${adaptation.sourceFile}`);
  }
  Object.assign(adaptation, { version: release.version, sourceSha256: sha256(source) });
  return evidence;
}

async function refreshCredits(previous, next, files) {
  const read = name => readFile(path.join(root, name), 'utf8');
  const readme = `${noticeDirectory}/README.md`;
  let table = await read(readme);
  let notice = await read('NOTICE');
  for (const group of ['upstream', 'embeddedPackages', 'correspondingSource']) {
    previous[group].forEach((old, i) => {
      const updated = next[group][i];
      if (old.revision) table = table.replaceAll(old.revision, updated.revision);
      if (old.version === updated.version) return;
      table = table.replaceAll(`| ${old.version}`, `| ${updated.version}`).replaceAll(`\`${old.version}\``, `\`${updated.version}\``);
      if (group === 'upstream') notice = notice.replace(old.version, updated.version);
      if (old.name === 'jschardet') notice = notice.replace(`jschardet ${old.version}`, `jschardet ${updated.version}`);
    });
  }
  files.set(readme, table);
  files.set('NOTICE', notice);
  const old = previous.correspondingSource[0].version;
  const version = next.correspondingSource[0].version;
  if (version !== old) {
    const locales = (await readdir(path.join(root, 'src/locales'))).filter(name => name.endsWith('.mjs'));
    for (const name of ['index.html', ...locales.map(file => `src/locales/${file}`)]) {
      files.set(name, (await read(name)).replaceAll(`jschardet ${old}`, `jschardet ${version}`));
    }
  }
}

async function updateEditor() {
  const manifest = await readJson(path.join(root, 'package.json'));
  const releases = Object.fromEntries(await Promise.all([integration, ...languagePackages].map(async name => [name, await metadata(registryEntry(name, 'latest'))])));
  const next = updateEditorPins(manifest, releases);
  if (json(next) === json(manifest)) {
    console.log(`Editor packages are current (CodinGame ${manifest.dependencies[integration]}).`);
    return;
  }
  const staged = await mkdtemp(path.join(os.tmpdir(), 'playground-editor-'));
  try {
    await writeFile(path.join(staged, 'package.json'), json(next));
    await copyFile(path.join(root, 'package-lock.json'), path.join(staged, 'package-lock.json'));
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staged, stdio: 'inherit' });
    const files = new Map();
    const previous = await readJson(path.join(root, provenanceFile));
    const version = next.dependencies[integration];
    const release = releases[integration].version === version ? releases[integration] : await metadata(registryEntry(integration, version));
    const evidence = await editorEvidence(staged, release, previous, files);
    await refreshCredits(previous, evidence, files);
    files.set(provenanceFile, json(evidence));
    files.set('package.json', json(next));
    files.set('package-lock.json', await readFile(path.join(staged, 'package-lock.json')));
    for (const [name, bytes] of files) await writeFile(path.join(root, name), bytes);
    console.log(`Resolved editor dependencies and source notices for CodinGame ${evidence.integrationVersion}.`);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await updateEditor();
