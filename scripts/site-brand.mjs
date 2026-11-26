import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UI_LANGUAGES, loadLocale } from '../src/i18n.mjs';

const footerFields = ['prefix', 'company', 'suffix', 'credit'];
const textFields = ['name', 'title', 'productLabel'];
const colorTokens = new Set(('canvas ink muted line gold gold-bright panel paper control control-border hover focus danger error-bg '
  + 'header-start header-end footer-start footer-end scene-start scene-end scene-glow shadow success code-border button-bg button-hover button-ink').split(' '));
const imageTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon' };

function fields(value, allowed, name) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${name} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
  }
  return value;
}

function string(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  return value;
}

function link(value, name) {
  const url = new URL(string(value, name));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(`Invalid ${name} link.`);
  return url.href;
}

function escape(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function copySiteFile(source, target, directory = false) {
  const entry = await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!entry) return false;
  if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error(`Invalid site branding path: ${source}`);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: directory, filter: async filename => {
    const stat = await lstat(filename);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Only regular site branding files can be published: ${filename}`);
    return true;
  } });
  return true;
}

async function imageAsset(asset, directory) {
  const segments = string(asset, 'branding image').split('/');
  const type = imageTypes[path.extname(asset).toLowerCase()];
  if (!type || segments[0] !== 'assets' || segments.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) {
    throw new Error(`Branding image must be a local image under site/assets: ${asset}`);
  }
  if (!(await lstat(path.join(directory, ...segments))).isFile()) throw new Error(`Invalid branding image: ${asset}`);
  return { url: segments.map(encodeURIComponent).join('/'), type };
}

function messagesFor(brand) {
  const entries = {};
  if (brand.name !== undefined) entries['app.name'] = string(brand.name, 'brand.name');
  if (brand.title !== undefined || brand.name !== undefined) entries['siteBrand.title'] = string(brand.title ?? brand.name, 'brand.title');
  if (brand.productLabel !== undefined) entries['siteBrand.productLabel'] = string(brand.productLabel, 'brand.productLabel');
  if (brand.footer !== undefined) {
    for (const key of footerFields) {
      if (brand.footer[key] !== undefined) entries['siteBrand.footer.' + key] = string(brand.footer[key], 'brand.footer.' + key);
    }
  }
  return entries;
}

/** Render only the supported publisher slots. Project acknowledgments and license links belong to the shell. */
export async function stageSiteBrand({ directory, siteDirectory, profile }) {
  const brand = fields(profile.brand ?? {}, [...textFields, 'description', 'logo', 'favicon', 'links', 'footer', 'colors', 'translations'], 'brand');
  const target = path.join(directory, 'site');
  await copySiteFile(path.join(siteDirectory, 'assets'), path.join(target, 'assets'), true);
  const customCss = await copySiteFile(path.join(siteDirectory, 'theme.css'), path.join(target, 'theme.css'));
  if (!Object.keys(brand).length && !customCss) return;
  if (brand.footer !== undefined) fields(brand.footer, [...footerFields, 'url'], 'brand.footer');
  const base = messagesFor(brand);
  const localized = {};
  for (const [code, translation] of Object.entries(fields(brand.translations ?? {}, UI_LANGUAGES.map(language => language.code), 'brand.translations'))) {
    fields(translation, [...textFields, 'footer'], 'brand.translations.' + code);
    if (translation.footer !== undefined) fields(translation.footer, footerFields, 'translated brand.footer');
    const messages = messagesFor(translation);
    if (translation.title === undefined && brand.title !== undefined) delete messages['siteBrand.title'];
    for (const key of Object.keys(messages)) {
      if (!Object.hasOwn(base, key)) throw new Error(`Missing base brand text for ${code}: ${key}`);
    }
    localized[code] = messages;
  }
  const english = { ...base, ...localized.en };
  const index = path.join(directory, 'index.html');
  let html = await readFile(index, 'utf8');
  function replace(pattern, replacement) {
    if (!pattern.test(html)) throw new Error(`Missing site branding slot in index.html: ${pattern}`);
    html = html.replace(pattern, () => replacement);
  }
  const css = [];
  if (brand.name !== undefined) {
    if (!brand.name.trim()) throw new Error('brand.name must not be blank.');
    replace(/(<p class="eyebrow" data-i18n="app\.name">)[^<]*<\/p>/,
      `<p class="eyebrow" data-i18n="app.name">${escape(english['app.name'])}</p>`);
  }
  if (Object.hasOwn(english, 'siteBrand.title')) {
    replace(/<title>[^<]*<\/title>/, `<title data-i18n="siteBrand.title">${escape(english['siteBrand.title'])}</title>`);
  }
  if (brand.description !== undefined) {
    replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escape(string(brand.description, 'brand.description'))}">`);
  }
  if (brand.logo !== undefined) {
    const logo = typeof brand.logo === 'string' ? { dark: brand.logo } : fields(brand.logo, ['dark', 'light', 'alt'], 'brand.logo');
    const dark = await imageAsset(logo.dark ?? logo.light, target);
    const light = logo.light ? await imageAsset(logo.light, target) : dark;
    const alt = escape(string(logo.alt ?? brand.name ?? 'JoomEngine', 'brand.logo.alt'));
    replace(/<img data-site-wordmark\b[^>]*>/, `<img data-site-wordmark src="./site/${dark.url}" width="400" height="80" alt="${alt}">`);
    css.push(`:root[data-theme=light] .brand img{content:url("${light.url}")}`);
  } else if (brand.name !== undefined) {
    replace(/<img data-site-wordmark\b[^>]*>/, `<strong data-i18n="app.name">${escape(english['app.name'])}</strong>`);
  }
  if (brand.productLabel !== undefined || brand.name !== undefined) {
    replace(/<span class="brand-product">[^<]*<\/span>/, brand.productLabel
      ? `<span class="brand-product" data-i18n="siteBrand.productLabel">${escape(english['siteBrand.productLabel'])}</span>` : '');
  }
  if (brand.favicon !== undefined) {
    const { url, type } = await imageAsset(brand.favicon, target);
    replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="./site/${url}" type="${type}">`);
  }
  const links = fields(brand.links ?? {}, ['repository', 'deploymentGuide', 'agentGuide'], 'brand.links');
  const linkSlots = {};
  if (links.repository !== undefined) {
    const repository = link(links.repository, 'repository');
    linkSlots['action.star'] = repository;
    linkSlots['action.fork'] = repository.replace(/\/$/, '') + '/fork';
  }
  if (links.deploymentGuide !== undefined) linkSlots['action.guide'] = link(links.deploymentGuide, 'deploymentGuide');
  if (links.agentGuide !== undefined) linkSlots['action.agentGuide'] = link(links.agentGuide, 'agentGuide');
  html = html.replace(/<a\b[^>]*>/g, tag => {
    const key = tag.match(/data-i18n(?:-title)?="([^"]+)"/)?.[1];
    return Object.hasOwn(linkSlots, key) ? tag.replace(/href="[^"]*"/, () => `href="${escape(linkSlots[key])}"`) : tag;
  });
  if (brand.footer !== undefined) {
    const { footer } = brand;
    const url = footer.url !== undefined ? link(footer.url, 'footer.url') : undefined;
    if (url && !footer.company) throw new Error('A brand.footer.url requires company text.');
    const parts = footerFields.filter(key => footer[key] !== undefined).map(key => {
      const id = 'siteBrand.footer.' + key;
      const text = escape(english[id]);
      return key === 'company' && url
        ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" data-i18n="${id}">${text}</a>`
        : `<span data-i18n="${id}">${text}</span>`;
    });
    replace(/<p class="copyright">[\s\S]*?<\/p>/, `<p class="copyright">${parts.join(' ')}</p>`);
  }
  for (const [theme, palette] of Object.entries(fields(brand.colors ?? {}, ['dark', 'light'], 'brand.colors'))) {
    const rules = [];
    for (const [token, value] of Object.entries(fields(palette, [...colorTokens], 'brand.colors.' + theme))) {
      if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`Invalid hex color for ${theme}.${token}`);
      rules.push(`--${token}:${value}`);
    }
    if (rules.length) css.push(`:root[data-theme=${theme}]{${rules.join(';')}}`);
  }
  const styles = [];
  if (css.length) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'brand.css'), css.join('\n') + '\n');
    styles.push('./site/brand.css');
  }
  if (customCss) styles.push('./site/theme.css');
  if (styles.length) replace(/<\/head>/, styles.map(url => `  <link rel="stylesheet" href="${url}">\n`).join('') + '</head>');
  if (Object.keys(base).length) {
    for (const { code } of UI_LANGUAGES) {
      const messages = { ...await loadLocale(code), ...base, ...localized[code] };
      await writeFile(path.join(directory, 'src', 'locales', code + '.mjs'), `export default Object.freeze(${JSON.stringify(messages, null, 2)});\n`);
    }
  }
  await writeFile(index, html);
}
