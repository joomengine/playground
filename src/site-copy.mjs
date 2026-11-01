const SETUP_FIELDS = ['siteName', 'language', 'languageTags', 'multilingual', 'extensions', 'startupCommands', 'languages', 'menus', 'template', 'content'];

/** Capture the existing files and database before allocating an independent site. */
export async function prepareUploadedSiteCopy({ input, sourceConfiguration, runtime, open, storageKey, administratorEdited = false }) {
  const current = runtime?.configuration;
  const useCurrent = current?.storageKey === sourceConfiguration.storageKey
    && current?.persistence === sourceConfiguration.persistence;
  const source = useCurrent ? runtime : await open(sourceConfiguration);
  try {
    const checkpoint = await source.checkpoint();
    const original = checkpoint.configuration;
    if (input.joomlaVersion !== original.joomlaVersion || (input.jcbVersion ?? 'none') !== (original.jcbVersion ?? 'none')) {
      throw new Error('Select a deployment preset to change the installed Joomla or JCB version.');
    }
    const configuration = { ...structuredClone(original), storageKey, fresh: false };
    if (administratorEdited) configuration.admin = structuredClone(input.admin);
    for (const name of ['phpVersion', 'phpSettings', 'persistence', 'autoLogin', 'hideToolbar', 'initialPath']) {
      if (input[name] !== undefined) configuration[name] = structuredClone(input[name]);
    }
    const changed = SETUP_FIELDS.some(name => JSON.stringify(input[name] ?? null) !== JSON.stringify(original[name] ?? null));
    return { checkpoint, configuration, rotateAdministrator: administratorEdited,
      ...(changed ? { changes: { ...structuredClone(input), storageKey, fresh: false, admin: configuration.admin } } : {}) };
  } finally {
    if (!useCurrent) await source.close();
  }
}
