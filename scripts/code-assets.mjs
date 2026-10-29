import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

/** Bundle only the lazy Code entry. No editor imports enter the normal Playground startup. */
export async function stageCodeAssets({ root, assets }) {
  const require = createRequire(path.join(root, 'package.json'));
  const outdir = path.join(assets, 'code');
  await mkdir(outdir, { recursive: true });
  const copied = new Map();
  async function staticAsset(filename) {
    if (copied.has(filename)) return copied.get(filename);
    const bytes = await readFile(filename);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    const name = `static/${hash}-${path.basename(filename)}`;
    await mkdir(path.join(outdir, 'static'), { recursive: true });
    await copyFile(filename, path.join(outdir, name));
    copied.set(filename, name);
    return name;
  }
  const assetsPlugin = {
    name: 'joomengine-code-assets',
    setup(builder) {
      // CodinGame deliberately imports CSS as a string so it can be adopted into the
      // workbench's document and its native auxiliary editor windows.
      builder.onLoad({ filter: /\.css$/ }, async ({ path: filename }) => {
        let css = await readFile(filename, 'utf8');
        const substitutions = [];
        for (const match of css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)) {
          const target = match[2];
          if (/^(?:data:|https?:|#|\/)/.test(target)) continue;
          const name = await staticAsset(path.resolve(path.dirname(filename), target));
          substitutions.push([match[0], name]);
        }
        let expression = JSON.stringify(css);
        for (const [original, name] of substitutions) {
          expression = expression.split(JSON.stringify(original).slice(1, -1))
            .join(`url(\" + new URL(${JSON.stringify(`./${name}`)}, import.meta.url).href + \")`);
        }
        return { contents: `export default ${expression};`, loader: 'js' };
      });
      builder.onLoad({ filter: /\.m?js$/ }, async ({ path: filename }) => {
        const source = await readFile(filename, 'utf8');
        let contents = source;
        for (const match of source.matchAll(/new URL\((['"])([^'"\n]+)\1,\s*import\.meta\.url\)/g)) {
          if (!match[2].startsWith('.')) continue;
          const target = path.resolve(path.dirname(filename), match[2]);
          const name = await staticAsset(target);
          contents = contents.replace(match[0], `new URL(${JSON.stringify(`./${name}`)}, import.meta.url)`);
        }
        return { contents, loader: 'js' };
      });
    },
  };
  const result = await build({
    absWorkingDir: root,
    entryPoints: {
      'editor-view': 'src/code/editor-view.mjs',
      'editor-worker': require.resolve('monaco-editor/esm/vs/editor/editor.worker.js'),
      'textmate-worker': require.resolve('@codingame/monaco-vscode-textmate-service-override/worker'),
      'search-worker': require.resolve('@codingame/monaco-vscode-search-service-override/worker'),
    },
    outdir, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    chunkNames: 'chunk-[hash]', assetNames: 'static/[name]-[hash]', minify: true,
    plugins: [assetsPlugin], metafile: true, logLevel: 'warning',
    // @vscode/diff keeps a guarded Node fallback next to its browser WASM loader.
    external: ['node:fs/promises'],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await writeFile(path.join(outdir, 'editor.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JoomEngine Code</title><style>html,body,#workbench{width:100%;height:100%;margin:0;overflow:hidden;background:#181818}body{color:#eee;font:13px system-ui}</style></head><body><div id="workbench"></div><script type="module" src="./editor-view.js"></script></body></html>\n`);
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const dependencies = [];
  const packagePaths = new Set(Object.keys(result.metafile.inputs).filter(name => name.startsWith('node_modules/'))
    .map(name => name.split('/').slice(0, name.split('/')[1].startsWith('@') ? 3 : 2).join('/')));
  for (const directory of [...packagePaths].sort()) {
    const pkg = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    const pin = lock.packages[directory];
    if (!pin?.integrity || pin.version !== pkg.version) throw new Error(`Unpinned JoomEngine Code dependency: ${pkg.name}`);
    const licences = [];
    for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT', 'NOTICE', 'ThirdPartyNotices.txt']) {
      try {
        const bytes = await readFile(path.join(root, directory, filename));
        const destination = `notices/${pkg.name.replaceAll('/', '_')}/${filename}`;
        await mkdir(path.dirname(path.join(outdir, destination)), { recursive: true });
        await writeFile(path.join(outdir, destination), bytes);
        licences.push(destination);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    dependencies.push({ name: pkg.name, version: pkg.version, licence: pkg.license, integrity: pin.integrity, notices: licences });
  }
  await writeFile(path.join(outdir, 'dependencies.json'), `${JSON.stringify(dependencies, null, 2)}\n`);
  return { entry: 'code/editor.html', dependencies };
}
