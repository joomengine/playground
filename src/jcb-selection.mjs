import { deploymentRequiresJcb } from './deployment-compatibility.mjs';

// Read the version from the upstream identity, not the name of a staged ZIP.
export function jcbRecipeVersion(entry) {
  const source = entry?.sourceUrl || entry?.url || '';
  const match = /\/pkg-component-builder\/(?:archive\/refs\/tags\/|zip\/refs\/tags\/)?v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\.zip)?(?:$|[?#])/i.exec(source);
  return match?.[1]?.replace(/\.zip$/i, '') ?? null;
}

function recipeMajor(major, versions) { return major === '7' && !versions?.has('7') ? '6' : major; }

/** A major-specific pin takes precedence over one in the common configuration. */
export function recipeJcbEntry(deploy, major, version) {
  const variant = deploy?.variants?.[major] ?? (major === '7' ? deploy?.variants?.['6'] : undefined);
  for (const extensions of [variant?.extensions, deploy?.configuration?.extensions]) {
    const match = extensions?.findLast(entry => {
      const found = jcbRecipeVersion(entry);
      return found && entry.sha256 && (version ? found === version : found.split('.')[0] === major || (major === '7' && found.startsWith('6.')));
    });
    if (match) return match;
  }
}

export function pinnedJcbPackages(deploy) {
  const result = new Map();
  for (const major of deploy?.joomla ?? Object.keys(deploy?.variants ?? {})) {
    const entry = recipeJcbEntry(deploy, major);
    const version = jcbRecipeVersion(entry);
    if (version?.split('.')[0] !== major) continue;
    result.set(major, { version, package: { url: entry.url, sha256: entry.sha256, ...(entry.sha512 ? { sha512: entry.sha512 } : {}) } });
  }
  return result;
}

export function recipeIncludesJcb(deploy, major, version) {
  return Boolean(version && recipeJcbEntry(deploy, major, version));
}

export function initialJcbSelection({ input, deploy, major, pinned, isSaved }) {
  if (input.jcbVersion !== undefined) return { version: input.jcbVersion, omit: false, package: input.jcbPackage };
  const recipe = jcbRecipeVersion(recipeJcbEntry(deploy, major));
  // Historical sites without a selector resume without overriding their recorded instructions.
  if (isSaved) return { version: recipe || 'none', omit: true };
  const fallback = pinned.get(recipeMajor(major, pinned))?.version;
  const preferRecipe = recipe && (recipe.split('.')[0] === major || !pinned.has(major));
  return { version: preferRecipe ? recipe : deploymentRequiresJcb(deploy) && fallback ? fallback : 'none', omit: false };
}

export function jcbSelectionInput({ selection, major, deploy, pinned, retired = [] }) {
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
  // Preserve version-only saved configurations. The resolver selects the
  // archived pin without adding a package override that would fork the saved site.
  if (!explicit && (recipeIncludesJcb(deploy, major, version) || retired.some(entry => entry.version === version))) return { jcbVersion: version };
  const packageEntry = explicit || (pinnedEntry?.version === version ? pinnedEntry.package : null);
  if (!packageEntry) throw new TypeError(`The selected JCB ${version} package is unavailable.`);
  return { jcbVersion: version, jcbPackage: structuredClone(packageEntry) };
}
