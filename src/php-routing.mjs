/** Preserve ordinary CGI script/PATH_INFO routing through the upstream rewrite API. */
export function configurePhpRouting(php, binary) {
  php.rewrite = pathname => {
    // Each CGI request has its own path info, including requests without a suffix.
    php.env.PATH_INFO = '';
    if (!pathname.startsWith(php.prefix)) return pathname;
    const relative = pathname.slice(php.prefix.length);
    for (const match of relative.matchAll(/\.php\//g)) {
      const end = match.index + '.php'.length;
      const script = relative.slice(0, end);
      const filename = `${php.docroot.replace(/\/+$/, '')}/${script}`;
      const result = binary.FS.analyzePath(filename);
      if (!result.exists || !binary.FS.isFile(result.object.mode)) continue;
      php.env.PATH_INFO = relative.slice(end);
      return { path: script, scriptName: `${php.prefix}${script}` };
    }
    return pathname;
  };
}
