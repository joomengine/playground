import { cp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inventory, sha256 } from './assets.mjs';
import { writeBuildIdentity } from './build-identity.mjs';
import { stageDeployCatalog } from './deploys.mjs';
import { stageSiteBrand } from './site-brand.mjs';
import { normalizeSiteDefaults, normalizeSiteFeatures, siteFeatureStyles } from '../src/site-features.mjs';
import { parseCatalog } from '../src/config.mjs';

export function sitePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname)) {
    throw new Error('publicUrl must be an HTTPS site URL with an optional project path.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

async function optionalStat(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// A profile is public build input. In particular, checked-out symlinks must
// never turn an asset or recipe into a read from elsewhere on the runner.
async function checkSiteDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await checkSiteDirectory(path.join(directory, entry.name));
    else if (!entry.isFile()) throw new Error(`Site inputs must be ordinary files: ${entry.name}`);
  }
}

export async function readSiteProfile(siteDirectory) {
  const stat = await optionalStat(siteDirectory);
  if (!stat) return {};
  if (!stat.isDirectory()) throw new Error('The site override must be a directory.');
  await checkSiteDirectory(siteDirectory);
  const filename = path.join(siteDirectory, 'playground.json');
  if (!await optionalStat(filename)) return {};
  const profile = JSON.parse(await readFile(filename, 'utf8'));
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      Object.keys(profile).some(key => !['schemaVersion', 'publicUrl', 'brand', 'features', 'defaults'].includes(key))) {
    throw new Error('Unsupported site/playground.json field or format.');
  }
  if (profile.schemaVersion !== undefined && profile.schemaVersion !== 1) throw new Error('Unsupported Playground site schema version.');
  if ('publicUrl' in profile) profile.publicUrl = sitePublicUrl(profile.publicUrl);
  if ('features' in profile) profile.features = normalizeSiteFeatures(profile.features);
  if ('defaults' in profile) profile.defaults = normalizeSiteDefaults(profile.defaults);
  return profile;
}

export async function sourceBuildUrl({ root, profile, environment = process.env }) {
  if (profile.publicUrl || environment.PLAYGROUND_PUBLIC_URL) return sitePublicUrl(profile.publicUrl || environment.PLAYGROUND_PUBLIC_URL);
  const repository = environment.GITHUB_REPOSITORY?.toLowerCase();
  if (repository && repository !== 'joomengine/playground') {
    const [owner, name] = repository.split('/');
    const hostname = `${owner}.github.io`;
    return sitePublicUrl(`https://${hostname}/${name === hostname ? '' : name}`);
  }
  const domain = (await readFile(path.join(root, 'CNAME'), 'utf8')).trim();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error('CNAME must contain one valid deployment hostname.');
  }
  return sitePublicUrl(`https://${domain}/`);
}

export async function stageSiteShell({ directory, siteDirectory, profile, manifest }) {
  const { canonicalUrl } = manifest.deployment;
  const url = new URL(canonicalUrl);
  const cname = path.join(directory, 'CNAME');
  if (url.pathname === '/' && !url.hostname.endsWith('.github.io')) await writeFile(cname, `${url.hostname}\n`);
  else await rm(cname, { force: true });

  const hasSite = Boolean(await optionalStat(siteDirectory));
  if (hasSite) await stageSiteBrand({ directory, siteDirectory, profile });
  if (profile.defaults?.phpVersion) {
    manifest.defaults = { ...manifest.defaults, phpVersion: profile.defaults.phpVersion };
    parseCatalog(manifest); // Reject a PHP default incompatible with the actual staged Joomla release.
  }
  const indexPath = path.join(directory, 'index.html');
  let html = await readFile(indexPath, 'utf8');
  const canonical = /<link rel="canonical" href="[^"]*">/;
  if (!canonical.test(html)) throw new Error('Missing canonical URL in Playground shell.');
  html = html.replace(canonical, `<link rel="canonical" href="${canonicalUrl}">`);
  if (hasSite) {
    const config = { schemaVersion: 1, features: profile.features ?? {}, defaults: profile.defaults ?? {} };
    const css = siteFeatureStyles(config.features);
    html = html.replace('</head>', `<script type="application/json" id="playground-site">${JSON.stringify(config)}</script>\n${css ? `<style id="playground-features">${css}</style>\n` : ''}</head>`);
    const assets = await optionalStat(path.join(directory, 'site')) ? await inventory(path.join(directory, 'site')) : [];
    manifest.site = { schemaVersion: 1, sha256: sha256(JSON.stringify([profile, assets, await inventory(path.join(directory, 'deploys')), html])) };
  }
  await writeFile(indexPath, html);
}

export async function writeSiteManifest(directory, manifest) {
  await writeFile(path.join(directory, 'assets/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeBuildIdentity(directory, manifest);
  const files = (await inventory(directory)).filter(item => item.path !== 'asset-inventory.json');
  await writeFile(path.join(directory, 'asset-inventory.json'), `${JSON.stringify(files, null, 2)}\n`);
}

/** Compose a downstream site in a verified copy of the published engine. */
export async function applySiteBuild({ root, directory, siteDirectory, canonicalUrl, sourceCommit, upstream }) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));
  const marker = JSON.parse(await readFile(path.join(directory, 'build.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '') || !/^[a-f0-9]{64}$/.test(upstream?.buildId || '')
      || marker.id !== upstream.buildId || manifest.sourceCommit !== upstream.sourceCommit || manifest.upstreamEngine) {
    throw new Error('Downstream composition requires the matching official engine and a fork source commit.');
  }
  const profile = await readSiteProfile(siteDirectory);
  canonicalUrl = sitePublicUrl(profile.publicUrl ?? canonicalUrl);
  const seedPackages = manifest.deploys.packages;
  manifest.upstreamEngine = { ...upstream };
  manifest.sourceCommit = sourceCommit;
  manifest.deployment = { ...manifest.deployment, canonicalUrl, domain: new URL(canonicalUrl).hostname };
  // Start from the official shell and recipe sources. The seed contains the
  // compiled runtime and verified archives and may already have prepared recipes.
  await cp(path.join(root, 'index.html'), path.join(directory, 'index.html'));
  await rm(path.join(directory, 'deploys'), { recursive: true, force: true });
  manifest.deploys = await stageDeployCatalog({ root, staging: directory, assets: path.join(directory, 'assets'),
    cache: path.join(root, '.cache'), canonicalUrl, siteDirectory, seedPackages });
  await stageSiteShell({ directory, siteDirectory, profile, manifest });
  await writeSiteManifest(directory, manifest);
  return manifest;
}
