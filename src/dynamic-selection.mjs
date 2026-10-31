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

/** Pinned releases always win; a selected/saved archive keeps its exact identity. */
export function dynamicJoomlaChoices(pinnedCatalog, entries, selected = new Map()) {
  const result = new Map(pinnedCatalog.joomla.map(entry => [entry.version, { ...entry }]));
  for (const entry of entries) {
    if (result.has(entry.version)) continue;
    result.set(entry.version, { ...entry, php: compatibleDynamicPhp(entry, pinnedCatalog) });
  }
  for (const [version, packageEntry] of selected) {
    if (pinnedCatalog.joomla.some(entry => entry.version === version)) continue;
    const previous = result.get(version);
    result.set(version, { ...previous, ...packageEntry, version, label: previous?.label || `Joomla ${version}` });
  }
  const pinned = new Set(pinnedCatalog.joomla.map(entry => entry.version));
  return [...pinnedCatalog.joomla.map(entry => result.get(entry.version)),
    ...[...result.values()].filter(entry => !pinned.has(entry.version))];
}

/** Joomla 7 can exercise JCB 6 until JCB 7 packages become available. */
export function matchingJcbChoices(major, entries, pinned = new Map()) {
  const sameMajor = entries.filter(entry => entry.version.split('.')[0] === major);
  const selectedMajor = major === '7' && !sameMajor.length && !pinned.has('7') ? '6' : major;
  const result = new Map();
  const reviewed = pinned.get(selectedMajor);
  if (reviewed) result.set(reviewed.version, { ...reviewed, label: `JCB ${reviewed.version}` });
  for (const entry of entries) {
    if (entry.version.split('.')[0] === selectedMajor && !result.has(entry.version)) result.set(entry.version, entry);
  }
  return [...result.values()];
}
