import { deploymentRequiresJcb } from './deployment-compatibility.mjs';

// Read the version from the upstream identity, not the name of a staged ZIP.
function jcbVersion(entry) {
  const source = entry?.sourceUrl || entry?.url || '';
  const match = /\/pkg-component-builder\/(?:archive\/refs\/tags\/|zip\/refs\/tags\/)?v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\.zip)?(?:$|[?#])/i.exec(source);
  return match?.[1]?.replace(/\.zip$/i, '') ?? null;
}

function recipeMajor(major, versions) { return major === '7' && !versions?.has('7') ? '6' : major; }

export function pinnedJcbPackages(deploy) {
  const result = new Map();
  for (const [major, variant] of Object.entries(deploy?.variants ?? {})) {
    const entry = (variant.extensions || []).find(item => jcbVersion(item));
    const version = jcbVersion(entry);
    if (!version || version.split('.')[0] !== major || !entry.sha256) continue;
    result.set(major, { version, package: { url: entry.url, sha256: entry.sha256 } });
  }
  return result;
}

export function recipeIncludesJcb(deploy, major, version) {
  return [...(deploy?.configuration?.extensions ?? []), ...(deploy?.variants?.[recipeMajor(major, new Set(Object.keys(deploy?.variants ?? {})))]?.extensions ?? [])]
    .some(entry => jcbVersion(entry) === version);
}

export function initialJcbSelection({ input, deploy, major, pinned, isSaved }) {
  if (input.jcbVersion !== undefined) return { version: input.jcbVersion, omit: false, package: input.jcbPackage };
  const fallback = pinned.get(recipeMajor(major, pinned))?.version;
  // Historical sites without JCB selection must retain the original recipe.
  if (isSaved) return { version: fallback && recipeIncludesJcb(deploy, major, fallback) ? fallback : 'none', omit: true };
  return { version: fallback && (deploymentRequiresJcb(deploy) || recipeIncludesJcb(deploy, major, fallback)) ? fallback : 'none', omit: false };
}

export function jcbSelectionInput({ selection, major, deploy, pinned }) {
  if (selection.omit) return {};
  const version = selection.version;
  if (version === 'none') {
    if (deploymentRequiresJcb(deploy)) throw new TypeError(`${deploy.title || 'This deployment'} requires Joomla Component Builder. Choose a compatible JCB version.`);
    return { jcbVersion: version };
  }
  if (!version) throw new TypeError('Choose a JCB version.');
  const selectedMajor = version.split('.')[0];
  if (selectedMajor !== major && !(major === '7' && selectedMajor === '6')) throw new TypeError(`JCB ${version} is not a selectable package for Joomla ${major}.`);
  const explicit = selection.package;
  const pinnedEntry = pinned.get(recipeMajor(major, pinned));
  if (!explicit && recipeIncludesJcb(deploy, major, version)) return { jcbVersion: version };
  const packageEntry = explicit || (pinnedEntry?.version === version ? pinnedEntry.package : null);
  if (!packageEntry) throw new TypeError(`The selected JCB ${version} package is unavailable.`);
  return { jcbVersion: version, jcbPackage: structuredClone(packageEntry) };
}
