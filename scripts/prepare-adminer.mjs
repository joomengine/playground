import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const digest = value => createHash('sha256').update(value).digest('hex');

/** Verify immutable upstream bytes before applying one reviewable driver adapter. */
export async function prepareAdminer() {
  const provenance = JSON.parse(await readFile(path.join(root, 'dependencies/adminer/provenance.json'), 'utf8'));
  const original = await readFile(path.join(root, 'dependencies/adminer', provenance.asset));
  if (original.length !== provenance.bytes || digest(original) !== provenance.sha256) throw new Error('The pinned Adminer release failed integrity verification.');
  const source = original.toString('utf8');
  const start = '}elseif(extension_loaded("pdo_mysql")){class\nDb\nextends\nPdoDb{';
  const end = 'class\nDriver\nextends\nSqlDriver';
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) >= 0) throw new Error('The pinned Adminer PDO driver does not match the reviewed adapter boundary.');
  const driver = await readFile(path.join(root, 'src/database/pdo-driver.php'), 'utf8');
  let patched = source.slice(0, from) + driver + source.slice(to);
  // Embedded MariaDB has no password/grant subsystem and reports an empty
  // COLUMNS.PRIVILEGES even for its sole root connection. Adminer's fields UI
  // must reflect that connection's existing access; no database grant changes.
  const privileges = '"privileges"=>array_flip(explode(",","$K[PRIVILEGES],where,order"))';
  if (patched.split(privileges).length !== 2) throw new Error('The pinned Adminer field privileges boundary changed.');
  patched = patched.replace(privileges, '"privileges"=>array_flip(explode(",",($K["PRIVILEGES"]!==""?$K["PRIVILEGES"]:"select,insert,update,references").",where,order"))');
  const resultClass = "array('Adminer\\PdoResult')";
  if (patched.split(resultClass).length !== 2) throw new Error('The pinned Adminer PDO result boundary changed.');
  patched = patched.replace(resultClass, "array('Adminer\\JoomEnginePdoResult')");
  const support = 'function\nsupport($zd){return\npreg_match';
  if (patched.split(support).length !== 2) throw new Error('The pinned Adminer capabilities boundary changed.');
  patched = patched.replace(support, 'function\nsupport($zd){if(in_array($zd,array("routine","procedure","event","privileges"),true))return false;return\npreg_match');
  if (patched.includes('\\PDO::MYSQL_ATTR_')) throw new Error('Native PDO mysql attributes remain in the Adminer adapter.');
  return { source: Buffer.from(patched), provenance };
}

/** Stage only public executable sources; no site credentials or DB data. */
export async function stageAdminer(destination) {
  const { source, provenance } = await prepareAdminer();
  await mkdir(destination, { recursive: true });
  const files = [];
  for (const name of ['adminer.php', 'index.php', 'adminer.css', 'bridge.js']) {
    const bytes = name === 'adminer.php' ? source : await readFile(path.join(root, 'src/database', name));
    await writeFile(path.join(destination, name), bytes);
    files.push({ name, bytes: bytes.length, sha256: digest(bytes) });
  }
  await copyFile(path.join(root, 'dependencies/adminer/LICENSE-APACHE-2.0'), path.join(destination, 'LICENSE'));
  await writeFile(path.join(destination, 'provenance.json'), `${JSON.stringify({ ...provenance, adaptedSha256: digest(source) }, null, 2)}\n`);
  const manifest = { version: provenance.version, files };
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, uncompressedBytes: files.reduce((total, file) => total + file.bytes, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await stageAdminer(path.resolve(process.argv[2] || path.join(root, 'dist/assets/adminer')));
  console.log(`Adminer ${result.version}: ${result.uncompressedBytes} bytes staged.`);
}
