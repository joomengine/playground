import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { assembleLanguagePackage } from '../scripts/language-packages.mjs';

const encode = (text) => new TextEncoder().encode(text);
const identity = { major: '6', tag: 'af-ZA', version: '6.2.0.0', date: '2026-10-26', sourceCommit: 'a'.repeat(40) };
const prefix = `core-translations-${identity.sourceCommit}/joomla_v6/translations/package/af-ZA/`;
const fixture = () => Object.fromEntries([
  ['pkg_af-ZA.xml', '<extension><packagename>af-ZA</packagename><version/><creationDate/></extension>'],
  ...['language', 'administrator/language', 'api/language'].map((client) =>
    [`${client}/af-ZA/langmetadata.xml`, '<metafile><version/><metadata><tag>af-ZA</tag></metadata></metafile>']),
  ['language/af-ZA/joomla.ini', 'HELLO="Goeiedag — ons erfenis"\n'],
].map(([name, value]) => [prefix + name, encode(value)]));

test('language assembly is deterministic and preserves translation bytes', () => {
  const input = fixture();
  const first = assembleLanguagePackage(input, identity);
  const second = assembleLanguagePackage(Object.fromEntries(Object.entries(input).reverse()), identity);
  assert.deepEqual(first.bytes, second.bytes);
  const files = unzipSync(first.bytes);
  assert.deepEqual(files['language/af-ZA/joomla.ini'], input[`${prefix}language/af-ZA/joomla.ini`]);
  assert.match(new TextDecoder().decode(files['pkg_af-ZA.xml']), /<version>6\.2\.0\.0<\/version>/);
  assert.equal(first.provenance.placeholderChanges.length, 4);
  assert.equal(first.provenance.fileCount, 5);
});

test('language assembly refuses incomplete, mismatched and unsafe upstream input', () => {
  const missing = fixture();
  delete missing[`${prefix}api/language/af-ZA/langmetadata.xml`];
  assert.throws(() => assembleLanguagePackage(missing, identity), /incomplete/);
  const changed = fixture();
  changed[`${prefix}language/af-ZA/langmetadata.xml`] = encode('<metadata><tag>de-DE</tag></metadata>');
  assert.throws(() => assembleLanguagePackage(changed, identity), /metadata tag differs/);
  assert.throws(() => assembleLanguagePackage({ ...fixture(), [`${prefix}../outside.php`]: encode('<?php') }, identity), /Unsafe archive path/);
  const differentRelease = fixture();
  differentRelease[`${prefix}pkg_af-ZA.xml`] = encode('<extension><packagename>af-ZA</packagename><version>6.3.0.1</version></extension>');
  assert.throws(() => assembleLanguagePackage(differentRelease, identity), /identity differs/);
});
