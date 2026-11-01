const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const samePackage = (left, right) => left.url === right.url && left.sha256 === right.sha256 && left.sha512 === right.sha512;

/** Reapply only edited setup instructions, preserving later changes made in Joomla. */
export function deploymentConfigurationChanges(previous, next) {
  const configureLanguage = ['language', 'languageTags', 'multilingual'].some(key => !same(previous[key], next[key]));
  const extensions = next.extensions.filter(entry => !previous.extensions.some(item => samePackage(item, entry)));
  const startupCommands = next.startupCommands.filter(argv => !previous.startupCommands.some(item => same(item, argv)));
  const languages = configureLanguage ? next.languages : next.languages.filter(entry =>
    !previous.languages.some(item => item.tag === entry.tag && samePackage(item, entry)));
  const menus = same(previous.menus, next.menus) ? [] : next.menus;
  const template = same(previous.template, next.template) || !next.template ? null : { ...next.template };
  if (template?.url && template.url === previous.template?.url && template.sha256 === previous.template?.sha256) {
    delete template.url;
    delete template.sha256;
  }
  return { configuration: { ...next, extensions, startupCommands, languages, menus, template }, configureLanguage };
}
