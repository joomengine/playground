import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrictUtf8Decoder, createStrictTextDecoder } from '../src/code/encoding-guard.mjs';

test('valid UTF-8 streams preserve multibyte text and line endings across chunk boundaries', () => {
  const text = 'Joomla € 😃\r\nsecond line\n';
  const bytes = new TextEncoder().encode(text);
  const decoder = createStrictUtf8Decoder();
  let decoded = '';
  for (const byte of bytes) decoded += decoder.decode(new Uint8Array([byte]), { stream: true });
  decoded += decoder.decode();
  assert.equal(decoded, text);
});

test('malformed and truncated UTF-8 fails with actionable advice instead of editable replacement characters', () => {
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xe2, 0x82])]) {
    assert.throws(() => createStrictUtf8Decoder().decode(bytes), /not valid UTF-8.*saved bytes are unchanged.*Reopen with Encoding.*Download file/);
  }
  const decoder = createStrictUtf8Decoder();
  assert.equal(decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true }), '');
  assert.throws(() => decoder.decode(), /not valid UTF-8/);
});

test('a literal replacement character is valid text, and BOM handling matches the native editor decoder', () => {
  const bytes = new TextEncoder().encode('\uFEFFvalid \uFFFD');
  assert.equal(createStrictUtf8Decoder().decode(bytes), 'valid \uFFFD');
  assert.equal(createStrictTextDecoder('utf8bom').decode(bytes), 'valid \uFFFD');
});

test('UTF-16LE and UTF-16BE stream complete surrogate pairs, preserve CRLF, and remove only the BOM', () => {
  const text = 'Joomla € 😃\r\nsecond line \uFFFD';
  for (const encoding of ['utf16le', 'utf16be']) {
    const bytes = Buffer.from(`\uFEFF${text}`, 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    const decoder = createStrictTextDecoder(encoding);
    let decoded = '';
    for (const byte of bytes) decoded += decoder.decode(new Uint8Array([byte]), { stream: true });
    decoded += decoder.decode();
    assert.equal(decoded, text);
  }
});

test('malformed UTF-16 cannot silently discard trailing bytes or unpaired surrogates', () => {
  for (const encoding of ['utf16le', 'utf16be']) {
    for (const pair of [[0x41], [0x00, 0xd8], [0x00, 0xdc]]) {
      const bytes = new Uint8Array(encoding === 'utf16be' ? pair.toReversed() : pair);
      const decoder = createStrictTextDecoder(encoding);
      assert.throws(() => { decoder.decode(bytes, { stream: true }); decoder.decode(); },
        new RegExp(`not valid ${encoding === 'utf16le' ? 'UTF-16LE' : 'UTF-16BE'}.*Reopen with Encoding`));
    }
  }
});
