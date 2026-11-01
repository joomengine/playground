/** Deployment constraints are shared by the selector and launch resolver. */
export function deploymentRequiresJcb(deploy) {
  if (deploy?.requirements?.jcb === 'required') return true;
  try { return new URL(deploy?.configuration?.initialPath || '/', 'https://playground.invalid/').searchParams.get('option') === 'com_componentbuilder'; }
  catch { return false; }
}

export function deploymentRecipeMajor(deploy, version) {
  const major = String(version).split('.')[0];
  const supported = deploy?.joomla ?? deploy?.requirements?.joomla;
  if (!supported || supported.includes(major)) return major;
  const fallback = deploy.requirements?.joomlaFallbacks?.[major];
  return fallback && supported.includes(fallback) ? fallback : null;
}

export function deploymentSupportsJoomla(deploy, version) {
  return deploymentRecipeMajor(deploy, version) !== null;
}

export function deploymentPhpVersions(deploy, release) {
  if (!release || !deploymentSupportsJoomla(deploy, release.version)) return [];
  return (release.php || []).filter(version => !deploy?.requirements?.php || deploy.requirements.php.includes(version));
}

/** Choosing a recipe preserves a compatible runtime, otherwise uses its defaults. */
export function selectDeploymentRuntime(deploy, catalog, selection = {}) {
  const available = catalog.joomla.filter(release => deploymentPhpVersions(deploy, release).length);
  const release = available.find(entry => entry.version === selection.joomlaVersion)
    || available.find(entry => entry.version === deploy.configuration?.joomlaVersion)
    || available.find(entry => entry.version === catalog.defaults.joomlaVersion)
    || available[0];
  if (!release) throw new TypeError(`${deploy.title || 'This deployment'} has no compatible Joomla and PHP runtime available.`);
  const php = deploymentPhpVersions(deploy, release);
  const phpVersion = [selection.phpVersion, deploy.configuration?.phpVersion, catalog.defaults.phpVersion].find(version => php.includes(version)) || php[0];
  return { joomlaVersion: release.version, phpVersion };
}
