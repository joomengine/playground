/** Presentation metadata enriches the deployment JSON Schema; it does not replace it. */
const fields = ['title', 'alias', 'language', 'component', 'view', 'menuType', 'category', 'introtext', 'fulltext', 'featured', 'home', 'published', 'access', 'templateStyle', 'query', 'params', 'multilingual', 'kind', 'guid', 'match', 'fields', 'folder', 'element', 'clientId', 'source', 'repository', 'refresh', 'system_name', 'organisation', 'target', 'type', 'base', 'access_repo', 'read_branch', 'write_branch', 'token', 'username', 'author_name', 'author_email', 'enabled', 'position', 'showtitle', 'content', 'menuAssignments', 'note', 'ordering'];
const help = new Set(['guid', 'alias', 'introtext', 'fulltext', 'language', 'match', 'source']);
let schemas;
let loading;

function resolve(schema, document, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 24) return {};
  if (schema.$ref?.startsWith('#/')) {
    const target = schema.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], document);
    const { $ref: reference, ...rest } = schema;
    return { ...resolve(target, document, depth + 1), ...resolve(rest, document, depth + 1) };
  }
  const result = { ...schema };
  if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, field]) => [name, decorate(resolve(field, document, depth + 1), name)]));
  if (schema.items && typeof schema.items === 'object') result.items = resolve(schema.items, document, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) result[key] = schema[key].map(item => resolve(item, document, depth + 1));
  return result;
}

function decorate(schema, name) {
  const ui = { ...schema.ui };
  if (fields.includes(name)) ui.label = `deploymentForm.field.${name}`;
  if (help.has(name)) ui.help = `deploymentForm.help.${name}`;
  if (name === 'key') ui.hidden = true;
  if (['introtext', 'fulltext', 'content'].includes(name) && schema.type === 'string') ui.widget = 'textarea';
  if (/(?:password|token|secret|private_key)/i.test(name)) ui.widget = 'password';
  if (['query', 'params', 'access', 'templateStyle', 'source', 'match', 'dependsOn'].includes(name)) ui.advanced = true;
  return { ...schema, ui };
}

export function deploymentSchemasFromDocument(document) {
  const definitions = document?.$defs;
  if (!definitions?.menu || !definitions?.content) throw new TypeError('Deployment form schema is unavailable.');
  const menus = resolve({ type: 'array', maxItems: 100, items: { $ref: '#/$defs/menu' } }, document);
  menus.ui = { add: 'deploymentForm.addMenu', item: 'deploymentForm.menu', empty: 'deploymentForm.emptyMenus' };
  const content = resolve(definitions.content, document);
  content.properties.categories.ui = { add: 'deploymentForm.addCategory', item: 'deploymentForm.category', empty: 'deploymentForm.emptyCategories', label: 'deploymentForm.category' };
  content.properties.articles.ui = { add: 'deploymentForm.addArticle', item: 'deploymentForm.article', empty: 'deploymentForm.emptyArticles', label: 'deploymentForm.article' };
  const overlays = { type: 'array', items: resolve(definitions.overlay || { type: 'object', properties: {} }, document),
    ui: { add: 'deploymentForm.addSetting', item: 'deploymentForm.setting', empty: 'deploymentForm.emptySettings' } };
  return { menus, content, parameters: resolve(definitions.parameters || { type: 'object' }, document), overlays };
}

export async function loadDeploymentFormSchemas({ fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  if (schemas) return schemas;
  loading ??= (async () => {
    const response = await fetcher(new URL('../deploys/document.schema.json', import.meta.url));
    if (!response.ok) throw new Error('Deployment form schema is unavailable.');
    schemas = deploymentSchemasFromDocument(await response.json());
    return schemas;
  })().catch(error => { loading = undefined; throw error; });
  return loading;
}

export function deploymentFormSchema(kind) { return schemas?.[kind]; }

/** Offline Repository form snapshot: JCB 5/6 admin/forms/repository.xml, 037752c7. */
export function repositoryFormSchema() {
  const text = (name, more = {}) => decorate({ type: 'string', ...more }, name);
  const select = (name, options, more = {}) => decorate({ type: 'integer', oneOf: options.map(([value, label]) => ({ const: value, ui: { label } })), ...more }, name);
  return { type: 'object', properties: {
    system_name: text('system_name'),
    type: select('type', [[1, 'Gitea'], [2, 'GitHub']], { default: 2 }),
    base: text('base', { format: 'uri', ui: { showWhen: { type: 1 } } }),
    organisation: text('organisation'), repository: text('repository'),
    target: select('target', [[4, 'deploymentForm.repo.packages'], [3, 'deploymentForm.repo.fieldtypes'], [2, 'deploymentForm.repo.joomlapowers'], [5, 'deploymentForm.repo.snippets'], [1, 'deploymentForm.repo.powers'], [6, 'deploymentForm.repo.repositories']], { default: 4 }),
    read_branch: text('read_branch'), write_branch: text('write_branch'),
    access_repo: select('access_repo', [[0, 'deploymentForm.repo.global'], [1, 'deploymentForm.repo.override']], { default: 1 }),
    token: text('token', { ui: { showWhen: { access_repo: 1 } } }), username: text('username', { ui: { showWhen: { access_repo: 1 } } }),
    author_name: text('author_name'), author_email: text('author_email', { format: 'email' }),
    published: select('published', [[1, 'deploymentForm.field.published'], [0, 'deploymentForm.disabled']], { default: 1 }),
  } };
}

export function builtinConfigurationTargets() {
  return [{ kind: 'record', component: 'com_componentbuilder', view: 'repository', title: 'JCB · Repository', schema: repositoryFormSchema() }];
}
