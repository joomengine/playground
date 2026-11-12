import { createFullDeploymentDocument } from './config.mjs';

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
    const selectedPackage = input.jcbVersion === requestedJcb ? input.jcbPackage ?? original.jcbPackage : original.jcbPackage;
    const jcbUpgrade = requestedJcb !== 'none' ? { version: requestedJcb, package: selectedPackage } : null;
    const configuration = { ...structuredClone(original), storageKey, fresh: false };
    configuration.jcbVersion = requestedJcb;
    if (jcbUpgrade?.package) {
      configuration.jcbPackage = structuredClone(jcbUpgrade.package);
      const knownJcb = entry => entry.url === original.jcbPackage?.url
        || entry.url === jcbUpgrade.package.url || /\/pkg-component-builder\//i.test(entry.url);
      configuration.extensions = (configuration.extensions ?? []).filter(entry => !knownJcb(entry));
      configuration.extensions.unshift(structuredClone(jcbUpgrade.package));
      configuration.addonExtensions = (configuration.addonExtensions ?? []).filter(entry => !knownJcb(entry));
    }
    const changes = { ...structuredClone(input), storageKey, fresh: false, jcbVersion: requestedJcb };
    if (configuration.jcbPackage) {
      changes.jcbPackage = structuredClone(configuration.jcbPackage);
      const knownJcb = entry => entry.url === original.jcbPackage?.url
        || entry.url === configuration.jcbPackage.url || /\/pkg-component-builder\//i.test(entry.url);
      // Applying edited overlays after the upgrade must not reinstall the source package.
      changes.extensions = (changes.extensions ?? []).filter(entry => !knownJcb(entry));
      changes.extensions.unshift(structuredClone(configuration.jcbPackage));
      changes.addonExtensions = (changes.addonExtensions ?? []).filter(entry => !knownJcb(entry));
    }
    if (administratorEdited) configuration.admin = structuredClone(input.admin);
    for (const name of ['phpVersion', 'phpSettings', 'persistence', 'autoLogin', 'hideToolbar', 'initialPath']) {
      if (input[name] !== undefined) configuration[name] = structuredClone(input[name]);
    }
    const changed = SETUP_FIELDS.some(name => JSON.stringify(changes[name] ?? null) !== JSON.stringify(configuration[name] ?? null));
    const documentOptions = { name: input.deploymentRecipe?.name || configuration.siteName,
      requirements: input.deploymentRecipe?.requirements };
    // Checkpoint arrays already contain the preset. Preserve that distinction on resume.
    configuration.deploymentRecipe = createFullDeploymentDocument(configuration, documentOptions);
    changes.admin = structuredClone(configuration.admin);
    changes.deploymentRecipe = createFullDeploymentDocument(changes, documentOptions);
    return { checkpoint, configuration, rotateAdministrator: administratorEdited, ...(jcbUpgrade ? { jcbUpgrade } : {}),
      ...(changed ? { changes } : {}) };
  } finally {
    if (!useCurrent) await source.close();
  }
}
