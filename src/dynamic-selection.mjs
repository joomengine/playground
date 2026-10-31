import { selectCurrentForwardVersions } from './dynamic-catalog.mjs';

/** Match discovered releases to the PHP binaries actually shipped by this host. */
function atLeast(version, minimum) {
  const left = version.split('.').map(Number), right = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference > 0;
  }
  return true;
}

export function compatibleDynamicPhp(entry, pinnedCatalog) {
  if (Array.isArray(entry.php)) {
    return pinnedCatalog.php.filter(runtime => entry.php.includes(runtime.version)
      && (!entry.phpMinimum || atLeast(runtime.patchVersion || `${runtime.version}.0`, entry.phpMinimum)))
      .map(runtime => runtime.version);
  }
  if (entry.phpMinimum) {
    return pinnedCatalog.php.filter(runtime => atLeast(runtime.patchVersion || `${runtime.version}.0`, entry.phpMinimum))
      .map(runtime => runtime.version);
  }
  // Published stable/preview release metadata has no PHP requirement. Use the
  // tested major-version compatibility already present in the runtime catalog.
  const major = entry.version.split('.')[0];
  const known = new Set(pinnedCatalog.joomla.filter(release => release.version.split('.')[0] === major)
    .flatMap(release => release.php));
  return pinnedCatalog.php.map(runtime => runtime.version).filter(version => known.has(version));
}

/** Only current/forward choices are advertised. Explicit saved selections are
 * retained separately, with their exact archive, even after the stable advances. */
export function dynamicJoomlaChoices(pinnedCatalog, entries, selected = new Map()) {
  const result = new Map(pinnedCatalog.joomla.map(entry => [entry.version, { ...entry }]));
  for (const entry of entries) {
    if (result.has(entry.version)) continue;
    result.set(entry.version, { ...entry, php: compatibleDynamicPhp(entry, pinnedCatalog) });
  }
  const choices = selectCurrentForwardVersions([...result.values()], {
    defaultMajor: pinnedCatalog.defaults?.joomlaVersion?.split('.')[0] || '6',
  });
  for (const [version, packageEntry] of selected) {
    const index = choices.findIndex(entry => entry.version === version);
    const previous = index >= 0 ? choices[index] : result.get(version);
    const exact = { ...previous, ...packageEntry, version, label: previous?.label || `Joomla ${version}`,
      channel: index >= 0 ? previous.channel : 'saved' };
    if (index >= 0) choices[index] = exact;
    else choices.push(exact);
  }
  return choices;
}

/** Joomla 7 can exercise JCB 6 until JCB 7 packages become available. */
export function matchingJcbChoices(major, entries, pinned = new Map()) {
  if (Number(major) < 5) return [];
  const available = selectCurrentForwardVersions([...entries, ...pinned.values()], { allowedMajors: null });
  const sameMajor = available.filter(entry => entry.version.split('.')[0] === major);
  const selectedMajor = major === '7' && !sameMajor.length ? '6' : major;
  const result = new Map();
  const reviewed = pinned.get(selectedMajor);
  if (reviewed) result.set(reviewed.version, { ...reviewed, label: `JCB ${reviewed.version}` });
  for (const entry of available) {
    if (entry.version.split('.')[0] === selectedMajor && !result.has(entry.version)) result.set(entry.version, entry);
  }
  return selectCurrentForwardVersions([...result.values()], { allowedMajors: [selectedMajor] });
}
