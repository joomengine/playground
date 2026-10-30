import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLanguageTag, languageCatalog, filterLanguages } from '../src/language-selector.mjs';
import { normalizeLanguage } from '../src/config.mjs';
import { parseLanguageTags } from '../src/site-configuration.mjs';

test('typed language tags normalize to the same supported script-aware configuration contract', () => {
  for (const [input, expected] of [['en-gb', 'en-GB'], ['AF-za', 'af-ZA'], ['zh-hant-tw', 'zh-Hant-TW'], ['sr-Latn-RS', 'sr-Latn-RS']]) {
    const tag = normalizeLanguageTag(input);
    assert.equal(tag, expected);
    assert.equal(normalizeLanguage(tag), expected);
    assert.deepEqual(parseLanguageTags([tag]), [expected]);
  }
  for (const input of ['', 'en', 'en_US', 'en-US-extra', 'x-US', 'abcd-US', 'en-123', 'javascript:alert(1)', null, 4]) {
    assert.equal(normalizeLanguageTag(input), null);
  }
});

test('catalog selections come from the actual selected-version catalog plus built-in English', () => {
  const catalog = languageCatalog(['af-ZA', 'fr-FR', 'af-ZA', 'zh-Hant-TW', 'bad'], 'en');
  assert.deepEqual(catalog.map(item => item.tag), ['en-GB', 'af-ZA', 'fr-FR', 'zh-Hant-TW']);
  assert.equal(catalog.some(item => item.tag === 'de-DE'), false);
  assert.match(catalog.find(item => item.tag === 'fr-FR').name, /French/);
  assert.match(catalog.find(item => item.tag === 'zh-Hant-TW').name, /Chinese/);
});

test('typed names and tags filter choices, and multiple selections do not appear twice', () => {
  const catalog = languageCatalog(['af-ZA', 'fr-FR', 'de-DE'], 'en');
  assert.deepEqual(filterLanguages(catalog, 'french').map(item => item.tag), ['fr-FR']);
  assert.deepEqual(filterLanguages(catalog, 'DE-').map(item => item.tag), ['de-DE']);
  assert.deepEqual(filterLanguages(catalog, '', ['en-GB', 'fr-FR']).map(item => item.tag), ['af-ZA', 'de-DE']);
  assert.deepEqual(filterLanguages(catalog, 'fr-FR', ['fr-FR']), []);
  assert.deepEqual(filterLanguages(catalog, 'custom-language'), []);
});

test('unsupported display locale does not prevent catalog browsing', () => {
  const catalog = languageCatalog(['af-ZA'], 'not_a_locale');
  assert.deepEqual(catalog.map(item => item.tag), ['en-GB', 'af-ZA']);
  assert.ok(catalog.every(item => typeof item.name === 'string' && item.name));
});
