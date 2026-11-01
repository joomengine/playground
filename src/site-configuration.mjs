const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (RESERVED.has(key)) throw new TypeError(`${label} contains an invalid property.`);
  return value;
}
function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${label} must contain 1–${max} text characters.`);
  return value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !NAME.test(value)) throw new TypeError(`${label} must start with a letter and contain letters, numbers, underscores or hyphens.`);
  return value;
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) throw new TypeError(`${label} must be a valid nonnegative integer.`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be true or false.`);
  return value;
}
export function siteParameters(value = {}, label = 'Parameters', depth = 0) {
  record(value, label);
  if (depth > 5 || Object.keys(value).length > 100) throw new TypeError(`${label} is too complex.`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_:-]{1,80}$/.test(key) || RESERVED.has(key)) throw new TypeError(`${label} contains an invalid key.`);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
    else if (typeof item === 'string' && item.length <= 8192 && !item.includes('\0')) result[key] = item;
    else if (Array.isArray(item) && item.length <= 100) result[key] = item.map((entry) => {
      if (entry === null || typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry)) || (typeof entry === 'string' && entry.length <= 8192 && !entry.includes('\0'))) return entry;
      throw new TypeError(`${label} arrays may contain only scalar values.`);
    });
    else if (item && typeof item === 'object') result[key] = siteParameters(item, label, depth + 1);
    else throw new TypeError(`${label} contains an unsupported value.`);
  }
  if (JSON.stringify(result).length > 65_536) throw new TypeError(`${label} exceeds 64 KiB.`);
  return result;
}
export function parseLanguageTags(value = []) {
  if (!Array.isArray(value) || value.length > 30 || value.some((tag) => typeof tag !== 'string' || !LANGUAGE.test(tag))) throw new TypeError('Language selections must be an array of at most 30 Joomla language tags.');
  return [...new Set(value)];
}
export function parseMenus(value = []) {
  if (typeof value === 'string') { try { value = JSON.parse(value || '[]'); } catch { throw new TypeError('Menus must be a JSON array.'); } }
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Choose at most 100 menu items.');
  const keys = new Set(); const aliases = new Set(); const homes = new Set();
  return value.map((item, index) => {
    record(item, 'Menu item');
    const allowed = ['key', 'title', 'alias', 'menuType', 'component', 'view', 'query', 'params', 'language', 'home', 'published', 'access', 'templateStyle'];
    for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new TypeError(`Menu item contains unsupported property ${key}.`);
    const key = identifier(item.key ?? `menu-${index + 1}`, 'Menu key');
    if (keys.has(key)) throw new TypeError(`Duplicate menu key: ${key}.`);
    keys.add(key);
    const alias = text(item.alias ?? key, 'Menu alias', 200);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) throw new TypeError('Menu aliases must contain lowercase letters, numbers and hyphens.');
    const language = item.language ?? '*';
    if (language !== '*' && !LANGUAGE.test(language)) throw new TypeError('Menu language must be * or a Joomla language tag.');
    const menuType = identifier(item.menuType ?? 'mainmenu', 'Menu type');
    const signature = `${menuType}:${alias}:${language}`;
    if (aliases.has(signature)) throw new TypeError('Menu aliases must be distinct within each menu and language.');
    aliases.add(signature);
    const component = identifier(item.component, 'Menu component');
    if (!/^com_[a-z0-9_]+$/.test(component)) throw new TypeError('Choose a Joomla component such as com_content.');
    const view = identifier(item.view, 'Menu view');
    const query = siteParameters(item.query ?? {}, 'Menu query');
    for (const [name, entry] of Object.entries(query)) {
      if (['option', 'view', 'task', 'Itemid', 'format'].includes(name) || typeof entry === 'object') throw new TypeError('Menu query accepts scalar view parameters, not option, view, task, Itemid or format overrides.');
    }
    const home = boolean(item.home ?? false, 'Menu home');
    const published = boolean(item.published ?? true, 'Menu published');
    if (home && !published) throw new TypeError('A home menu item must be published.');
    if (home && homes.has(language)) throw new TypeError('Choose at most one home menu item per language.');
    if (home) homes.add(language);
    return { key, title: text(item.title, 'Menu title'), alias, menuType, component, view, query,
      params: siteParameters(item.params ?? {}, 'Menu parameters'), language, home, published,
      access: integer(item.access ?? 1, 'Menu access', 1), templateStyle: integer(item.templateStyle ?? 0, 'Menu template style') };
  });
}
export function parseTemplate(value, baseURL = 'https://playground.invalid/') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new TypeError('Template must be a JSON object.'); } }
  record(value, 'Template');
  const allowed = ['url', 'sha256', 'element', 'styleId', 'params', 'menuKeys'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Template contains unsupported property ${key}.`);
  const result = { params: siteParameters(value.params ?? {}, 'Template parameters'), menuKeys: [] };
  if (value.url !== undefined) {
    const url = new URL(text(value.url, 'Template URL', 2048), baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError('Template packages require HTTP or HTTPS without credentials or fragments.');
    result.url = url.href;
    if (value.sha256 !== undefined) {
      if (typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(value.sha256)) throw new TypeError('Template SHA-256 must contain 64 hexadecimal characters.');
      result.sha256 = value.sha256.toLowerCase();
    }
  } else if (value.sha256 !== undefined) throw new TypeError('A template checksum requires a package URL.');
  if (value.element !== undefined) result.element = identifier(value.element, 'Template element');
  if (value.styleId !== undefined) result.styleId = integer(value.styleId, 'Template style', 1);
  if (!result.element && !result.styleId) throw new TypeError('Choose the installed template element or style ID.');
  if (!Array.isArray(value.menuKeys ?? []) || (value.menuKeys ?? []).length > 100) throw new TypeError('Template menu assignments must be an array of at most 100 menu keys.');
  result.menuKeys = [...new Set((value.menuKeys ?? []).map((key) => identifier(key, 'Template menu key')))];
  return result;
}
