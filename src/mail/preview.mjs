const HTML = 'http://www.w3.org/1999/xhtml';
const allowed = new Set('a abbr address article b bdi bdo blockquote br caption center code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var'.split(' '));
const attributes = new Set(['title', 'lang', 'dir', 'style', 'align', 'valign', 'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'width', 'height', 'alt']);
const rasterData = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
export const MAIL_PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Parse only in inert template content, then rebuild a limited HTML tree.
 * Neither the original markup nor the rebuilt fragment enters the owner DOM.
 * Sandbox and CSP separately confine styles and block automatic resource loads.
 */
export function mailPreviewDocument(html, doc = globalThis.document) {
  const input = doc.createElement('template'), output = doc.createElement('template');
  input.innerHTML = String(html ?? '');
  // Use an explicit stack so deeply nested email markup cannot exhaust the
  // JavaScript call stack and make the original message impossible to inspect.
  const pending = [...input.content.childNodes].reverse().map(node => [node, output.content]);
  while (pending.length) {
    const [node, parent] = pending.pop();
    if (node.nodeType === 3) { parent.append(doc.createTextNode(node.data)); continue; }
    if (node.nodeType !== 1 || node.namespaceURI !== HTML || !allowed.has(node.localName)) continue;
    const clean = doc.createElement(node.localName);
    for (const attribute of node.attributes) {
      if (attribute.namespaceURI || !attributes.has(attribute.name)) continue;
      clean.setAttribute(attribute.name, attribute.value);
    }
    if (node.localName === 'img' && rasterData.test(node.getAttribute('src') || '')) clean.setAttribute('src', node.getAttribute('src'));
    parent.append(clean);
    for (const child of [...node.childNodes].reverse()) pending.push([child, clean]);
  }
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${MAIL_PREVIEW_CSP}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light}body{margin:16px;font:14px/1.5 system-ui,sans-serif;color:#18202b;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:inherit}</style></head><body>${output.innerHTML}</body></html>`;
}

export function renderMailHtml(frame, html) {
  frame.setAttribute('sandbox', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.removeAttribute('src');
  frame.srcdoc = mailPreviewDocument(html, frame.ownerDocument);
}
