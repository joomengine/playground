import { SearchCompletionExitCode, SearchRange } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search';
import { TextSearchCompleteMessageType } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/searchExtTypes';
import { fuzzyContains } from '@codingame/monaco-vscode-api/vscode/vs/base/common/strings';

function patterns(value) { return Object.entries(value || {}).filter(([, enabled]) => enabled === true).map(([pattern]) => pattern); }

/** Search pages execute in the PHP worker and yield between bounded chunks. */
export class JoomlaSearchProvider {
  constructor(provider) { this.provider = provider; }
  getAIName() { return Promise.resolve(undefined); }
  clearCache() { return Promise.resolve(); }
  fileSearch(query, token) { return this.search('files', query, undefined, token); }
  textSearch(query, onProgress, token) { return this.search('text', query, onProgress, token); }
  async search(kind, query, onProgress, token) {
    const maximum = Math.max(1, Math.min(query.maxResults || 2000, 10000));
    const pattern = query.contentPattern || {};
    if (kind === 'text' && pattern.isRegExp) throw new Error('Regular-expression workspace search is not available yet. Turn off .* to search literal text.');
    const matches = new Map();
    let cursor = null, count = 0, skipped = 0, truncated = false;
    const folder = query.folderQueries?.[0];
    const arguments_ = { kind, query: kind === 'text' ? pattern.pattern : '',
      path: folder?.folder ? this.provider.path(folder.folder) : '/',
      caseSensitive: Boolean(pattern.isCaseSensitive), isWordMatch: Boolean(pattern.isWordMatch),
      include: patterns({ ...query.includePattern, ...folder?.includePattern }),
      exclude: patterns({ ...query.excludePattern, ...Object.assign({}, ...((folder?.excludePattern || []).map(value => value.pattern))) }),
      maxResults: Math.min(100, maximum),
    };
    try {
      do {
        if (token?.isCancellationRequested) break;
        const page = await this.provider.request('search', cursor ? { cursor, maxResults: Math.min(100, maximum - count) } : arguments_);
        cursor = page.cursor;
        skipped = page.skipped;
        truncated ||= page.truncated;
        for (const item of page.results) {
          if (kind === 'files' && query.filePattern && !fuzzyContains(item.path, query.filePattern)) continue;
          const match = matches.get(item.path) || { resource: this.provider.uri(item.path), results: [] };
          if (kind === 'text') {
            const result = { previewText: item.preview, rangeLocations: [{
              source: new SearchRange(item.lineNumber - 1, item.column - 1, item.lineNumber - 1, item.endColumn - 1),
              preview: new SearchRange(0, item.previewColumn - 1, 0, item.previewColumn - 1 + item.endColumn - item.column),
            }] };
            match.results.push(result);
            onProgress?.({ resource: match.resource, results: [result] });
          }
          matches.set(item.path, match);
          if (++count >= maximum) break;
        }
      } while (cursor && count < maximum);
    } finally {
      if (cursor) await this.provider.request('cancelSearch', { cursor });
    }
    return { results: [...matches.values()], limitHit: truncated || Boolean(cursor && count >= maximum),
      messages: skipped ? [{ text: `${skipped} binary, large, unreadable or unsupported files were skipped.`, type: TextSearchCompleteMessageType.Warning }] : [],
      exit: token?.isCancellationRequested ? SearchCompletionExitCode.NewSearchStarted : SearchCompletionExitCode.Normal };
  }
}
