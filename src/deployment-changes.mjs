import { sameDeploymentValue as same } from './deployment-overlays.mjs';

const packageFields = ['url', 'sha256', 'sha512', 'provider', 'apiBase', 'authentication', 'headers'];
const samePackage = (left, right) => packageFields.every(key => same(left?.[key], right?.[key]));
const overlayInstructions = ({ schema, ...instructions }) => instructions;

/** Reapply only edited setup instructions, preserving later changes made in Joomla. */
export function deploymentConfigurationChanges(previous, next) {
  const configureLanguage = ['language', 'languageTags', 'multilingual'].some(key => !same(previous[key], next[key]));
  const extensions = next.extensions.filter(entry => !previous.extensions.some(item => samePackage(item, entry)));
  const startupCommands = next.startupCommands.filter(argv => !previous.startupCommands.some(item => same(item, argv)));
  const languages = configureLanguage ? next.languages : next.languages.filter(entry =>
    !previous.languages.some(item => item.tag === entry.tag && samePackage(item, entry)));
  const menus = same(previous.menus, next.menus) ? [] : next.menus;
  const overlays = (next.overlays ?? []).filter(entry => !(previous.overlays ?? []).some(item =>
    item.key === entry.key && same(overlayInstructions(item), overlayInstructions(entry))));
  const template = same(previous.template, next.template) || !next.template ? null : { ...next.template };
  if (template?.url && samePackage(template, previous.template)) {
    for (const key of packageFields) delete template[key];
  }
  return { configuration: { ...next, extensions, startupCommands, languages, menus, template, overlays }, configureLanguage };
}
