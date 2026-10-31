/** Browser-side derivation of a JCB package for the 32-bit Playground runtime.
 *
 * The candidate and donor must be fetched by the caller and accompanied by
 * independently obtained trusted digests. The donor is an existing Playground
 * derived JCB package, not an arbitrary upstream JCB package.
 */

const FILTER = 'component-builder/libraries/vendor_jcb/VDM.Joomla/src/Import/Spreadsheet/ChunkReadFilter.php';
const FILTER_ORIGINAL = '742877f73d6817c54963cbc8767c7af805332b561a7c178cae1151147263f28e';
const FILTER_PATCHED = '8b8f3e8845eb8844e419c3b05ada2be31eabe911a92365f9bc4e7d7f96cc89c6';
// The reviewed 5.2.0/6.2.0 source packages bundle this exact Composer
// installed.json. Refuse to substitute the locked donor if a later package
// changes its spreadsheet dependency contract.
const SOURCE_DEPENDENCIES = '9588f41595757c39dbaf863f3e67d9ffbea2bae33b296ce1c9bce96e12f579da';
const BEFORE = "public function readCell($columnAddress, $row, $worksheetName = '')";
const AFTER = `${BEFORE}: bool`;
const ROOT = 'component-builder/libraries/phpspreadsheet/';
const VENDOR = `${ROOT}vendor/`;
const METADATA = ['composer.json', 'composer.lock', 'packages.json', 'vendor-inventory.json', 'vendor-source-inventory.json', 'platform-provenance.json'];
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_UNPACKED = 512 * 1024 * 1024;
const MAX_ENTRIES = 30000;
// This is the reviewed official JCB 6.2.0 source from the stable recipe. Its
// built artifact in assets/manifest.json has the pre-composed 32-bit vendor.
const DONOR_SOURCE_SHA256 = '17a2b4c7b352d0ead2592e7e5838ace8255bbcbdc71566d883e8e82ca3dacd8e';
const REVIEWED_BUILT_SOURCE = Object.freeze({
  '5.2.0': '261e11de61a31ce6183fdcdf35fd3fdc7d0ff93b347bfb4cdaf7d4c66f93385b',
  '6.2.0': DONOR_SOURCE_SHA256,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function cleanPath(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 4096
    && !name.startsWith('/') && !name.includes('\\') && !/[\u0000-\u001f\u007f]/.test(name)
    && !/^[a-z]:/i.test(name) && !name.split('/').some((part, index, parts) => part === '.' || part === '..' || (part === '' && index !== parts.length - 1));
}

function unpack(bytes, unzipSync, label) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_ARCHIVE) throw new Error(`${label} exceeds the ZIP size limit.`);
  const seen = new Set();
  let total = 0;
  const files = unzipSync(bytes, { filter(entry) {
    if (!cleanPath(entry.name) || seen.has(entry.name)) throw new Error(`${label} contains an unsafe or duplicate path.`);
    seen.add(entry.name);
    if (seen.size > MAX_ENTRIES || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0
      || entry.originalSize > MAX_UNPACKED || (total += entry.originalSize) > MAX_UNPACKED) throw new Error(`${label} exceeds the extracted size limit.`);
    if (entry.compression !== 0 && entry.compression !== 8) throw new Error(`${label} uses an unsupported ZIP compression method.`);
    return true;
  } });
  let actual = 0;
  for (const value of Object.values(files)) {
    actual += value.byteLength;
    if (actual > MAX_UNPACKED) throw new Error(`${label} exceeds the extracted size limit.`);
  }
  return files;
}

async function hash(algorithm, bytes, subtle) {
  return [...new Uint8Array(await subtle.digest(algorithm, bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

function checksum(value, length, label) {
  if (typeof value !== 'string' || !(new RegExp(`^[a-f0-9]{${length}}$`, 'i')).test(value)) throw new Error(`${label} must have a trusted checksum.`);
  return value.toLowerCase();
}

function componentEntry(files, major, label) {
  const suffix = `/src/joomla__Component-Builder__${major}.x.zip`;
  const matches = Object.keys(files).filter(name => name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`${label} does not contain exactly one JCB ${major} component archive.`);
  return matches[0];
}

function packageVersion(files, expected) {
  const manifests = Object.keys(files).filter(name => /(^|\/)pkg_component_builder\.xml$/.test(name));
  if (manifests.length !== 1) throw new Error('The JCB candidate has an ambiguous package manifest.');
  const xml = decoder.decode(files[manifests[0]]);
  const matches = [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)];
  if (matches.length !== 1 || matches[0][1] !== expected) throw new Error('The JCB package version does not match the selected version.');
}

/**
 * Verify both ZIPs, then transplant the donor's reviewed spreadsheet runtime.
 * `source` needs a trusted sha256 or sha512 and exact version; `donor` needs
 * the SHA-256 from the same-origin deployment manifest. `codec` is the shipped
 * fflate browser module (`unzipSync`, `zipSync`). Unknown JCB source fails
 * closed; callers can report an unsupported candidate without mutating a site.
 */
export async function deriveJcbBrowserPackage({ candidate, source, donor, donorSha256, codec, subtle = globalThis.crypto?.subtle }) {
  if (!subtle || typeof subtle.digest !== 'function' || typeof codec?.unzipSync !== 'function' || typeof codec?.zipSync !== 'function') {
    throw new Error('JCB derivation requires Web Crypto and ZIP support.');
  }
  if (!source || typeof source.version !== 'string' || !/^[456]\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source.version)) {
    throw new Error('The selected JCB version is not supported by this derivation.');
  }
  const sha256 = source.sha256 ? checksum(source.sha256, 64, 'The candidate SHA-256') : null;
  const sha512 = source.sha512 ? checksum(source.sha512, 128, 'The candidate SHA-512') : null;
  if (!sha256 && !sha512) throw new Error('The JCB candidate needs a trusted upstream checksum.');
  const donorExpected = checksum(donorSha256, 64, 'The donor SHA-256');
  if (!(candidate instanceof Uint8Array) || !(donor instanceof Uint8Array) || candidate.length > MAX_ARCHIVE || donor.length > MAX_ARCHIVE) throw new Error('JCB ZIP input exceeds the size limit.');
  const actualCandidateSha256 = await hash('SHA-256', candidate, subtle);
  const actualCandidateSha512 = sha512 ? await hash('SHA-512', candidate, subtle) : null;
  if ((sha256 && sha256 !== actualCandidateSha256) || (sha512 && sha512 !== actualCandidateSha512)) throw new Error('The candidate JCB package failed its checksum.');
  if (await hash('SHA-256', donor, subtle) !== donorExpected) throw new Error('The derived JCB donor package failed its checksum.');

  const outer = unpack(candidate, codec.unzipSync, 'JCB candidate package');
  const donorOuter = unpack(donor, codec.unzipSync, 'JCB donor package');
  packageVersion(outer, source.version);
  const major = source.version.split('.')[0];
  const componentPath = componentEntry(outer, major, 'The candidate');
  const donorMatches = Object.keys(donorOuter).filter(name => /\/src\/joomla__Component-Builder__[56]\.x\.zip$/.test(name));
  if (donorMatches.length !== 1) throw new Error('The reviewed donor component archive is missing or ambiguous.');
  const component = unpack(outer[componentPath], codec.unzipSync, 'JCB candidate component');
  const donorComponent = unpack(donorOuter[donorMatches[0]], codec.unzipSync, 'JCB donor component');
  const sourceDependencies = component[`${VENDOR}composer/installed.json`];
  if (!(sourceDependencies instanceof Uint8Array) || await hash('SHA-256', sourceDependencies, subtle) !== SOURCE_DEPENDENCIES) {
    throw new Error('The JCB spreadsheet dependency contract differs from the reviewed source.');
  }
  if (!(component[FILTER] instanceof Uint8Array) || await hash('SHA-256', component[FILTER], subtle) !== FILTER_ORIGINAL) {
    throw new Error('The JCB spreadsheet reader differs from the reviewed compatibility source.');
  }
  const original = decoder.decode(component[FILTER]);
  if (original.split(BEFORE).length !== 2) throw new Error('The JCB compatibility method must appear exactly once.');
  const patched = encoder.encode(original.replace(BEFORE, AFTER));
  if (await hash('SHA-256', patched, subtle) !== FILTER_PATCHED) throw new Error('The JCB compatibility patch did not match its reviewed result.');
  component[FILTER] = patched;

  const donorVendorNames = Object.keys(donorComponent).filter(name => name.startsWith(VENDOR) && !name.endsWith('/'));
  if (!donorVendorNames.includes(`${VENDOR}autoload.php`) || !donorVendorNames.includes(`${VENDOR}composer/platform_check.php`)
    || METADATA.some(name => !(donorComponent[`${ROOT}${name}`] instanceof Uint8Array))) {
    throw new Error('The reviewed donor is missing spreadsheet dependencies or provenance.');
  }
  for (const name of Object.keys(component)) if (name.startsWith(VENDOR)) delete component[name];
  for (const name of donorVendorNames) component[name] = donorComponent[name];
  for (const name of METADATA) component[`${ROOT}${name}`] = donorComponent[`${ROOT}${name}`];
  let provenance;
  try { provenance = JSON.parse(decoder.decode(donorComponent[`${ROOT}platform-provenance.json`])); }
  catch { throw new Error('The reviewed donor provenance is invalid.'); }
  if (provenance.schemaVersion !== 1 || provenance.sourceOverlay?.sha256 !== FILTER_ORIGINAL
    || provenance.sourceOverlay?.patchedSha256 !== FILTER_PATCHED || provenance.target?.integerBits !== 32) throw new Error('The donor provenance does not identify the reviewed 32-bit overlay.');
  const derivedProvenance = { ...provenance, source: { version: source.version, sha256: actualCandidateSha256,
    ...(actualCandidateSha512 ? { sha512: actualCandidateSha512 } : {}) }, donorSha256: donorExpected };
  component[`${ROOT}platform-provenance.json`] = encoder.encode(`${JSON.stringify(derivedProvenance, null, 2)}\n`);
  const zipOptions = { level: 6, mtime: new Date(1980, 0, 1) };
  outer[componentPath] = codec.zipSync(component, zipOptions);
  const bytes = codec.zipSync(outer, zipOptions);
  if (bytes.length > MAX_ARCHIVE) throw new Error('The derived JCB package exceeds the ZIP size limit.');
  return { bytes, sha256: await hash('SHA-256', bytes, subtle), provenance: derivedProvenance };
}

/** Replace only the explicitly selected, verified upstream JCB package.
 * Unrelated packages and already-derived default recipe packages pass through.
 */
export async function prepareSelectedJcbPackage({ bytes, item, selection, fetcher = fetch,
  manifestURL = new URL('../../assets/manifest.json', import.meta.url), codec,
  progress = () => {} }) {
  const source = selection?.package;
  const same = source && typeof selection?.version === 'string'
    && item?.url === source.url && (item.sha256 || '') === (source.sha256 || '')
    && (item.sha512 || '') === (source.sha512 || '');
  if (!same) return null;
  const manifestResponse = await fetcher(manifestURL.href);
  if (!manifestResponse.ok) throw new Error(`Cannot load JCB dependency manifest: HTTP ${manifestResponse.status}.`);
  const manifestText = await manifestResponse.text();
  if (manifestText.length > 2 * 1024 * 1024) throw new Error('The JCB dependency manifest exceeds its size limit.');
  let manifest;
  try { manifest = JSON.parse(manifestText); }
  catch { throw new Error('The JCB dependency manifest is invalid.'); }
  const packages = Array.isArray(manifest.deploys?.packages) ? manifest.deploys.packages : [];
  const staged = packages.find(entry => entry.sourceSha256 === REVIEWED_BUILT_SOURCE[selection.version]
    && /^[a-f\d]{64}$/.test(entry.sha256 || '') && entry.sha256 === item.sha256
    && entry.url === `packages/${entry.sha256}.zip`
    && entry.provenanceUrl === `packages/${entry.sha256}.provenance.json`
    && new URL(entry.url, manifestURL).href === item.url);
  // The stock build already derived this exact package. The caller's normal
  // installer still verifies the SHA-256 before writing or invoking PHP.
  if (staged) return null;
  const donors = packages.filter(entry =>
    entry.sourceSha256 === DONOR_SOURCE_SHA256 && /^[a-f\d]{64}$/.test(entry.sha256 || '')
    && entry.url === `packages/${entry.sha256}.zip`
    && entry.provenanceUrl === `packages/${entry.sha256}.provenance.json`);
  if (donors.length !== 1) throw new Error('The reviewed JCB dependency donor is missing or ambiguous.');
  const donorURL = new URL(donors[0].url, manifestURL);
  if (donorURL.origin !== manifestURL.origin || !donorURL.pathname.startsWith(new URL('./packages/', manifestURL).pathname)) {
    throw new Error('The reviewed JCB dependency donor must be on the Playground origin.');
  }
  progress({ stage: 'extensions', phase: 'verification', message: 'Preparing the selected JCB package for the browser runtime…' });
  const response = await fetcher(donorURL.href);
  if (!response.ok) throw new Error(`Cannot load the reviewed JCB dependency donor: HTTP ${response.status}.`);
  if (Number(response.headers.get('Content-Length')) > MAX_ARCHIVE) throw new Error('The JCB dependency donor exceeds the ZIP size limit.');
  const donor = new Uint8Array(await response.arrayBuffer());
  const zipper = codec ?? await import(new URL('../../assets/fflate/browser.js', import.meta.url).href);
  return deriveJcbBrowserPackage({ candidate: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    source: { version: selection.version, ...(source.sha256 ? { sha256: source.sha256 } : {}),
      ...(source.sha512 ? { sha512: source.sha512 } : {}) },
    donor, donorSha256: donors[0].sha256, codec: zipper });
}
