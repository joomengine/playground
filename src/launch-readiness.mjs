import { resolveDeployConfiguration } from './deploys.mjs';
import { deploymentSnapshotSource } from './deployment-images.mjs';

/** Inspect the same resolved snapshot used at launch, without reading image ZIPs. */
export async function deploymentLaunchReadiness(input, { manifest, ...options } = {}) {
  if (!manifest || !options.catalog || !options.deployCatalog || input.restoredSite) return null;
  const { configuration, deploy } = await resolveDeployConfiguration(input, options);
  if (!deploymentSnapshotSource(configuration, manifest, options.baseURL)?.maintained) return 'fresh';
  if (configuration.addonExtensions?.length || configuration.addonStartupCommands?.length
    || configuration.addonLanguages?.length || configuration.addonTemplate?.url) return 'additional';
  // A selected language may add a package even when no explicit package URL was
  // entered. Compare with the actual base recipe, not an arbitrary dirty flag.
  const { configuration: baseline } = await resolveDeployConfiguration({
    deployId: deploy.id, joomlaVersion: configuration.joomlaVersion,
    phpVersion: configuration.phpVersion, admin: input.admin,
  }, options);
  const baseLanguages = new Set((baseline.languages || []).map(language => `${language.tag}:${language.url}`));
  if ((configuration.languages || []).some(language => !baseLanguages.has(`${language.tag}:${language.url}`))) return 'additional';
  return 'fast';
}
