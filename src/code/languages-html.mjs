import { getLanguageService } from 'vscode-html-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';

const html = getLanguageService();

/** Keep source offsets intact while removing PHP from HTML language analysis. */
export function htmlDocument(source, inline, uri = 'jec:///template.php') {
  let text = '', cursor = 0;
  for (const span of inline.toSorted((a, b) => a.start - b.start)) {
    text += source.slice(cursor, span.start).replace(/[^\r\n]/g, ' ') + source.slice(span.start, span.end);
    cursor = span.end;
  }
  text += source.slice(cursor).replace(/[^\r\n]/g, ' ');
  return TextDocument.create(uri, 'html', 1, text);
}

export function completeHtml(source, inline, offset, path) {
  if (!inline.some(span => span.start <= offset && offset <= span.end)) return null;
  const document = htmlDocument(source, inline, `jec://${path}`);
  const result = html.doComplete(document, document.positionAt(offset), html.parseHTMLDocument(document));
  return result.items.slice(0, 250).map(item => ({ label: item.label, kind: 'html', htmlKind: item.kind,
    insertText: item.textEdit?.newText || item.insertText || item.label,
    snippet: item.insertTextFormat === 2, editRange: item.textEdit?.range,
    detail: item.detail || '', documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value || '' }));
}
