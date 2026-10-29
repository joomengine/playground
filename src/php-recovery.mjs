/** Preserve application files when upstream replaces PHP after a failed CGI request. */
export function installPhpRecovery(php, { currentBinary, prepare, beforeRefresh = async () => {}, restored = () => {}, roots = ['/persist', '/config', '/tmp', '/internal'] }) {
  const refresh = php.refresh.bind(php);
  php.refresh = () => {
    const previous = currentBinary();
    const replacement = Promise.resolve().then(async () => {
      await beforeRefresh(previous);
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
  for (const name of source.readdir(directory)) {
    if (name === '.' || name === '..') continue;
    const path = `${directory}/${name}`;
    const stat = source.lstat(path);
    if (source.isDir(stat.mode)) copyContents(source, target, path);
    else if (source.isLink(stat.mode)) {
      if (target.analyzePath(path).exists) target.unlink(path);
      target.symlink(source.readlink(path), path);
    } else if (source.isFile(stat.mode)) {
      // Copy one file at a time, without retaining a second complete filesystem archive.
      if (target.analyzePath(path).exists) target.chmod(path, stat.mode | 0o200);
      target.writeFile(path, source.readFile(path, { encoding: 'binary' }));
    } else continue;
    if (!source.isLink(stat.mode)) {
      target.chmod(path, stat.mode);
      target.utime(path, stat.atime, stat.mtime);
    }
  }
}
