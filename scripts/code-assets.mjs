import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
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
      // The upstream browser build is UMD; explicit ESM names keep dynamic
      // encoding imports compatible with esbuild's CommonJS interop.
      builder.onResolve({ filter: /^@vscode\/iconv-lite-umd$/ }, () => ({ path: 'iconv', namespace: 'joomengine-iconv' }));
      builder.onLoad({ filter: /.*/, namespace: 'joomengine-iconv' }, () => ({
        contents: `import library from ${JSON.stringify(require.resolve('@vscode/iconv-lite-umd'))}; export const { encode, decode, encodingExists, getEncoder, getDecoder, encodeStream, decodeStream } = library; export default library;`, loader: 'js', resolveDir: root,
      }));
      // Keep the LGPL library replaceable, with its complete preferred-form source.
      builder.onResolve({ filter: /^jschardet$/ }, () => ({ path: './jschardet.js', external: true }));
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
        if (filename.endsWith('/vscode/src/vs/workbench/services/textfile/common/encoding.js')) {
          // CodinGame 38.1.3 preserves VS Code's permissive UTF-8 decoder. Reject
          // malformed input so opening a file cannot silently corrupt saved bytes.
          const original = 'const utf8TextDecoder = ( new TextDecoder());';
          if (!contents.includes(original)) throw new Error('The pinned UTF-8 decoder patch needs review.');
          contents = `import { createStrictTextDecoder } from ${JSON.stringify(path.join(root, 'src/code/encoding-guard.mjs'))};\n` + contents.replace(original, 'const utf8TextDecoder = createStrictTextDecoder(encoding);').replace('if (encoding !== UTF8) {', 'if (![UTF8, UTF8_with_bom, UTF16le, UTF16be].includes(encoding)) {');
        }
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
      'languages-worker': 'src/code/languages-worker.mjs',
      'editor-view': 'src/code/editor-view.mjs',
      'editor-worker': require.resolve('monaco-editor/esm/vs/editor/editor.worker.js'),
      'textmate-worker': require.resolve('@codingame/monaco-vscode-textmate-service-override/worker'),
      'extension-host-worker': require.resolve('@codingame/monaco-vscode-api/workers/extensionHost.worker'),
      'search-worker': require.resolve('@codingame/monaco-vscode-search-service-override/worker'),
    },
    outdir, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    chunkNames: 'chunk-[hash]', assetNames: 'static/[name]-[hash]', minify: true,
    plugins: [assetsPlugin], metafile: true, logLevel: 'warning',
    // @vscode/diff keeps a guarded Node fallback next to its browser WASM loader.
    external: ['node:fs/promises'],
    define: { 'process.env.NODE_ENV': '"production"', 'process.arch': '"wasm32"' },
  });
  await writeFile(path.join(outdir, 'editor.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JoomEngine Code</title><link rel="icon" href="../../src/brand/favicon.svg" type="image/svg+xml"><script>try{document.documentElement.dataset.theme=parent.document.documentElement.dataset.theme||'dark'}catch{}<\/script><style>:root{color-scheme:dark;background:#181818;color:#eee}:root[data-theme=light]{color-scheme:light;background:#fff;color:#202b3e}html,body,#workbench{width:100%;height:100%;margin:0;overflow:hidden;background:inherit}body{font:13px system-ui}</style></head><body><div id="workbench"></div><script type="module" src="./editor-view.js"></script></body></html>\n`);
  await copyFile(path.join(path.dirname(require.resolve('@codingame/monaco-vscode-extensions-service-override')), 'vscode/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html'), path.join(outdir, 'extension-host.html'));
  const charset = await build({ absWorkingDir: root, stdin: { contents: "import library from 'jschardet'; export const { detect, detectAll, UniversalDetector, enableDebug } = library; export default library;", resolveDir: root }, outfile: path.join(outdir, 'jschardet.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: false, metafile: true });
  Object.assign(result.metafile.inputs, charset.metafile.inputs);
  await cp(path.join(root, 'dependencies/joomengine-code'), path.join(outdir, 'notices/source'), { recursive: true });
  await cp(path.join(root, 'node_modules/jschardet'), path.join(outdir, 'notices/source/jschardet'), { recursive: true });
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(path.join(root, 'dependencies/joomengine-code/provenance.json'), 'utf8'));
  const dependencies = [];
  const packagePaths = new Set(Object.keys(result.metafile.inputs).filter(name => name.startsWith('node_modules/'))
    .map(name => name.split('/').slice(0, name.split('/')[1].startsWith('@') ? 3 : 2).join('/')));
  for (const directory of [...packagePaths].sort()) {
    const pkg = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    const pin = lock.packages[directory];
    if (!pin?.integrity || pin.version !== pkg.version) throw new Error(`Unpinned JoomEngine Code dependency: ${pkg.name}`);
    if (pkg.name.startsWith('@codingame/') && pkg.version !== provenance.integrationVersion) throw new Error(`Code notices need updating for ${pkg.name}@${pkg.version}.`);
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
    if (pkg.name.startsWith('@codingame/') || ['monaco-editor', 'vscode'].includes(directory.slice('node_modules/'.length))) {
      licences.push('notices/source/LICENSE.codingame.txt', 'notices/source/LICENSE.vscode.txt', 'notices/source/ThirdPartyNotices.vscode.txt');
    }
    dependencies.push({ name: pkg.name, version: pkg.version, licence: pkg.license, integrity: pin.integrity, notices: licences });
  }
  await writeFile(path.join(outdir, 'dependencies.json'), `${JSON.stringify(dependencies, null, 2)}\n`);
  return { entry: 'code/editor.html', dependencies };
}
