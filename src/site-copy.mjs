const SETUP_FIELDS = ['siteName', 'language', 'languageTags', 'multilingual', 'extensions', 'startupCommands', 'languages', 'menus', 'template', 'content', 'overlays'];

/** Capture the existing files and database before allocating an independent site. */
export async function prepareUploadedSiteCopy({ input, sourceConfiguration, runtime, open, storageKey, administratorEdited = false }) {
  const current = runtime?.configuration;
  const useCurrent = current?.storageKey === sourceConfiguration.storageKey
    && current?.persistence === sourceConfiguration.persistence;
  const source = useCurrent ? runtime : await open(sourceConfiguration);
  try {
    const checkpoint = await source.checkpoint();
    const original = checkpoint.configuration;
    if (input.joomlaVersion !== original.joomlaVersion) {
      throw new Error('Select a deployment preset to change the installed Joomla version.');
    }
    const selectionChanged = (input.jcbVersion ?? 'none') !== (sourceConfiguration.jcbVersion ?? 'none');
    // A remembered selection can be stale after an update made inside Joomla.
    const requestedJcb = selectionChanged && input.jcbVersion && input.jcbVersion !== 'none'
      ? input.jcbVersion : original.jcbVersion ?? 'none';
    const jcbUpgrade = requestedJcb !== 'none' ? { version: requestedJcb, package: input.jcbPackage ?? original.jcbPackage } : null;
    const configuration = { ...structuredClone(original), storageKey, fresh: false };
    configuration.jcbVersion = requestedJcb;
    if (jcbUpgrade?.package) {
      configuration.jcbPackage = structuredClone(jcbUpgrade.package);
      if (requestedJcb !== original.jcbVersion) {
        const knownJcb = entry => entry.url === original.jcbPackage?.url || /\/pkg-component-builder\//i.test(entry.url);
        configuration.extensions = (configuration.extensions ?? []).filter(entry => !knownJcb(entry) && entry.url !== jcbUpgrade.package.url);
        configuration.extensions.unshift(structuredClone(jcbUpgrade.package));
      }
    }
    const changes = { ...structuredClone(input), storageKey, fresh: false, jcbVersion: requestedJcb };
    if (configuration.jcbPackage) changes.jcbPackage = structuredClone(configuration.jcbPackage);
    if (administratorEdited) configuration.admin = structuredClone(input.admin);
    for (const name of ['phpVersion', 'phpSettings', 'persistence', 'autoLogin', 'hideToolbar', 'initialPath']) {
      if (input[name] !== undefined) configuration[name] = structuredClone(input[name]);
    }
    const changed = SETUP_FIELDS.some(name => JSON.stringify(input[name] ?? null) !== JSON.stringify(original[name] ?? null));
    return { checkpoint, configuration, rotateAdministrator: administratorEdited, ...(jcbUpgrade ? { jcbUpgrade } : {}),
      ...(changed ? { changes: { ...changes, admin: configuration.admin } } : {}) };
  } finally {
    if (!useCurrent) await source.close();
  }
}
