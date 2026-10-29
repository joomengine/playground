const encodings = { utf8: ['utf-8', 'UTF-8'], utf8bom: ['utf-8', 'UTF-8'],
  utf16le: ['utf-16le', 'UTF-16LE'], utf16be: ['utf-16be', 'UTF-16BE'] };

/** Do not turn malformed saved bytes into replacement characters in an editable model. */
export function createStrictTextDecoder(encoding) {
  const selected = encodings[encoding];
  if (!selected) throw new TypeError(`The strict text decoder does not support ${encoding}.`);
  const decoder = new TextDecoder(selected[0], { fatal: true });
  return {
    decode(bytes, options) {
      try { return decoder.decode(bytes, options); }
      catch (cause) {
        throw Object.assign(new Error(`This file contains bytes that are not valid ${selected[1]}. Its saved bytes are unchanged. `
          + 'Use Reopen with Encoding to select the correct text encoding, or Download file to keep the original bytes.', { cause }), { actions: [], forceMessage: true, allowDialog: false });
      }
    },
  };
}

export const createStrictUtf8Decoder = () => createStrictTextDecoder('utf8');
