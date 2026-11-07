const ROOTS = ['/persist', '/config', '/tmp', '/internal'];
const INTERNAL_PREFIX = '/internal/jec-';

function equalBytes(left, right) {
  return left?.length === right?.length && left.every((byte, index) => byte === right[index]);
}
function snapshot(fs) {
  const result = new Map();
  const visit = path => {
    if (path.startsWith(INTERNAL_PREFIX)) return;
    const stat = fs.lstat(path);
    const record = { mode: stat.mode, atime: stat.atime, mtime: stat.mtime };
    if (fs.isLink(stat.mode)) record.link = fs.readlink(path);
    else if (fs.isDir(stat.mode)) {
      record.directory = true;
      for (const name of fs.readdir(path)) if (name !== '.' && name !== '..') visit(`${path}/${name}`);
    } else if (fs.isFile(stat.mode)) record.bytes = fs.readFile(path, { encoding: 'binary' }).slice();
    else return;
    result.set(path, record);
  };
  for (const root of ROOTS) {
    if (!fs.analyzePath(root).exists) continue;
    // The persisted source root may be a mount alias. Mirror its contents into
    // an ordinary directory; never mount the same IDBFS store in two runtimes.
    const stat = fs.stat(root);
    result.set(root, { directory: true, mode: stat.mode, atime: stat.atime, mtime: stat.mtime });
    for (const name of fs.readdir(root)) if (name !== '.' && name !== '..') visit(`${root}/${name}`);
  }
  return result;
}
function remove(fs, path) {
  const stat = fs.lstat(path);
  if (fs.isDir(stat.mode)) {
    for (const name of fs.readdir(path)) if (name !== '.' && name !== '..') remove(fs, `${path}/${name}`);
    fs.rmdir(path);
  } else fs.unlink(path);
}
function equivalent(a, b) {
  return a && b && a.directory === b.directory && a.link === b.link
    && a.mode === b.mode && Number(a.mtime) === Number(b.mtime) && Number(a.atime) === Number(b.atime)
    && (a.bytes ? equalBytes(a.bytes, b.bytes) : !b.bytes);
}
function applySnapshot(fs, previous, next) {
  for (const [path, old] of [...previous].sort((a, b) => b[0].length - a[0].length)) {
    if (ROOTS.includes(path)) continue;
    const value = next.get(path);
    if ((!value || old.directory !== value.directory || old.link !== value.link)
      && fs.analyzePath(path, true).exists) remove(fs, path);
  }
  for (const [path, value] of [...next].sort((a, b) => a[0].length - b[0].length)) {
    if (equivalent(previous.get(path), value)) continue;
    if (value.directory) fs.mkdirTree(path);
    else {
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      if (value.link !== undefined) {
        if (!fs.analyzePath(path, true).exists) fs.symlink(value.link, path);
      } else {
        // Emscripten preloads native bridge PHP files as read-only. The owner
        // snapshot is authoritative, and its permissions are restored below.
        if (fs.analyzePath(path, true).exists) fs.chmod(path, value.mode | 0o200);
        try { fs.writeFile(path, value.bytes); }
        catch (error) { throw new Error(`Could not restore PHP file ${path}: ${error?.message || `filesystem error ${error?.errno ?? String(error)}`}`); }
      }
    }
    if (value.link === undefined) { fs.chmod(path, value.mode); fs.utime(path, value.atime, value.mtime); }
  }
}

/** Structured-cloneable site state for an independent PHP worker. */
export function capturePhpFilesystem(fs) { return [...snapshot(fs)]; }

/** Apply a PHP worker's filesystem delta while the owner queue is held. */
export function applyPhpFilesystem(fs, previous, next) {
  applySnapshot(fs, new Map(previous), new Map(next));
}

