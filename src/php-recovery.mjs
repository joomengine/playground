/** Preserve application files when upstream replaces PHP after a failed CGI request. */
export function installPhpRecovery(php, { currentBinary, prepare, restored = () => {}, roots = ['/persist', '/config', '/tmp', '/internal'] }) {
  const refresh = php.refresh.bind(php);
  php.refresh = () => {
    const previous = currentBinary();
    const replacement = Promise.resolve().then(async () => {
      const pending = refresh();
      // Upstream assigns its own promise; callers must wait for file restoration too.
      php.binary = replacement;
      let next;
      try { next = await pending; }
      catch (error) { throw new Error(`PHP replacement initialization failed (${error?.message ?? error?.errno ?? String(error)}).`); }
      await prepare(next);
      for (const root of roots) {
        if (!previous.FS.analyzePath(root).exists) continue;
        try { copyContents(previous.FS, next.FS, root); }
        catch (error) { throw new Error(`Cannot restore PHP files in ${root} (${error?.message ?? error?.errno ?? String(error)}).`); }
      }
      php.initialized = true;
      restored(next);
      return next;
    });
    php.binary = replacement;
    return replacement;
  };
}

function copyContents(source, target, directory) {
  target.mkdirTree(directory);
  const names = new Set(source.readdir(directory).filter(name => name !== '.' && name !== '..'));
  // Hydration can restore an older disk generation. Do not resurrect files
  // deleted in memory since the last successful checkpoint.
  for (const name of target.readdir(directory)) {
    if (name !== '.' && name !== '..' && !names.has(name)) removeTree(target, `${directory}/${name}`);
  }
  for (const name of names) {
    const path = `${directory}/${name}`;
    const stat = source.lstat(path);
    let existing;
    try { existing = target.lstat(path); }
    catch (error) { if (error?.errno !== 44 && error?.code !== 'ENOENT') throw error; }
    if (existing && (stat.mode & 0o170000) !== (existing.mode & 0o170000)) {
      removeTree(target, path);
      existing = undefined;
    }
    let written = false;
    if (source.isDir(stat.mode)) copyContents(source, target, path);
    else if (source.isLink(stat.mode)) {
      const link = source.readlink(path);
      if (existing && target.readlink(path) !== link) { target.unlink(path); existing = undefined; }
      if (!existing) target.symlink(link, path);
    } else if (source.isFile(stat.mode)) {
      // Compare one file at a time. Rewriting unchanged hydrated files would
      // dirty the entire saved site and turn the next retry into a full rewrite.
      const bytes = source.readFile(path, { encoding: 'binary' });
      const saved = existing && existing.size === stat.size ? target.readFile(path, { encoding: 'binary' }) : null;
      if (!saved || bytes.some((byte, index) => byte !== saved[index])) {
        if (existing) target.chmod(path, stat.mode | 0o200);
        target.writeFile(path, bytes);
        written = true;
      }
    } else continue;
    if (!source.isLink(stat.mode)) {
      const current = written || source.isDir(stat.mode) ? target.lstat(path) : existing;
      if (current.mode !== stat.mode) target.chmod(path, stat.mode);
      if (+current.atime !== +stat.atime || +current.mtime !== +stat.mtime) target.utime(path, stat.atime, stat.mtime);
    }
  }
}

function removeTree(fs, path) {
  const stat = fs.lstat(path);
  if (fs.isDir(stat.mode)) {
    for (const name of fs.readdir(path)) if (name !== '.' && name !== '..') removeTree(fs, `${path}/${name}`);
    fs.rmdir(path);
  } else fs.unlink(path);
}
