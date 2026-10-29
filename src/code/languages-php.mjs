import Engine from 'php-parser';

export const PHP_INDEX_LIMITS = Object.freeze({ files: 12000, bytes: 96 * 1024 * 1024, fileBytes: 1024 * 1024 });
const classKinds = new Set(['class', 'interface', 'trait', 'enum']);
const callableKinds = new Set(['method', 'function', 'closure', 'arrowfunc']);
const keywords = ['abstract', 'array', 'as', 'break', 'case', 'catch', 'class', 'const', 'continue', 'declare',
  'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enum', 'extends', 'false', 'final', 'finally', 'fn',
  'for', 'foreach', 'function', 'global', 'if', 'implements', 'include', 'include_once', 'instanceof',
  'interface', 'isset', 'match', 'namespace', 'new', 'null', 'parent', 'private', 'protected', 'public',
  'readonly', 'require', 'require_once', 'return', 'self', 'static', 'switch', 'throw', 'trait', 'true',
  'try', 'unset', 'use', 'while', 'yield'];
const named = node => typeof node === 'string' ? node : node?.name || '';
const lower = value => value.toLowerCase();
const matches = (symbol, name) => ['property', 'constant'].includes(symbol.kind)
  ? symbol.name === name : lower(symbol.name) === lower(name);
const qualify = (namespace, name) => [namespace, name].filter(Boolean).join('\\');
const contains = (node, offset) => node.start <= offset && node.end >= offset;
export function phpRange(loc) {
  const start = loc?.start || { line: 1, column: 0 };
  const end = loc?.end || start;
  return { startLineNumber: start.line, startColumn: start.column + 1,
    endLineNumber: end.line, endColumn: end.column + 1 };
}
function typeName(type) {
  if (!type) return '';
  if (type.types) return type.types.map(typeName).join(type.kind === 'intersectiontype' ? '&' : '|');
  return named(type);
}
function children(node) {
  return Object.entries(node).filter(([key]) => !['loc', 'leadingComments', 'trailingComments', 'errors'].includes(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]).filter(value => value && typeof value === 'object' && value.kind);
}
function resolveName(name, context, kind = 'class') {
  if (name.startsWith('\\')) return name.slice(1);
  if (lower(name).startsWith('namespace\\')) return qualify(context.namespace, name.slice(10));
  const parts = name.split('\\');
  const alias = context.imports[lower(parts[0])];
  if (alias && (alias.kind === kind || (kind === 'class' && !alias.kind))) return qualify(alias.name, parts.slice(1).join('\\'));
  return qualify(context.namespace, name);
}

/** Syntax and declaration analysis only. No claim of full PHP type checking. */
export function analyzePhp(source, path, phpVersion = '8.3') {
  if (!/^8\.[345]$/.test(phpVersion)) throw new TypeError(`Unsupported PHP language version: ${phpVersion}`);
  const parser = new Engine({ parser: { version: phpVersion, suppressErrors: true, extractDoc: true }, ast: { withPositions: true } });
  const ast = parser.parseCode(source, path);
  const result = { path, symbols: [], scopes: [], contexts: [], inline: [], diagnostics: (ast.errors || []).map(error => {
    const range = phpRange(error.loc);
    if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) range.endColumn++;
    return { ...range, message: error.message, severity: 'error', source: `PHP ${phpVersion} syntax (php-parser)` };
  }) };
  function contextFor(namespace, nodes, node) {
    const context = { namespace, imports: {}, start: node?.loc?.start.offset || 0, end: node?.loc?.end.offset ?? source.length };
    for (const group of nodes.filter(child => child.kind === 'usegroup')) {
      for (const item of group.items) {
        const name = qualify(group.name, item.name);
        const alias = named(item.alias) || name.split('\\').at(-1);
        context.imports[lower(alias)] = { name, alias, kind: item.type || group.type || 'class' };
      }
    }
    result.contexts.push(context);
    return context;
  }
  function symbol(node, kind, context, container = '', overrides = {}) {
    const name = named(node.name);
    if (!name) return null;
    const entry = { name, kind, path, namespace: context.namespace, container,
      qualifiedName: container ? `${container}::${name}` : qualify(context.namespace, name),
      range: phpRange(node.loc), selectionRange: phpRange(node.name?.loc || node.loc),
      start: node.loc?.start.offset || 0, end: node.loc?.end.offset || 0,
      documentation: (node.leadingComments || []).map(comment => comment.value).join('\n').slice(0, 4096),
      ...overrides };
    result.symbols.push(entry);
    return entry;
  }
  function visit(node, context, owner = null, scope = null) {
    if (node.kind === 'inline') { result.inline.push({ start: node.loc.start.offset, end: node.loc.end.offset }); return; }
    if (node.kind === 'namespace') {
      const nested = contextFor(node.name, node.children, node);
      const topLevel = { kind: 'function', name: '', owner: '', start: nested.start, end: nested.end, variables: [], context: nested };
      result.scopes.push(topLevel);
      for (const child of node.children) visit(child, nested, null, topLevel);
      return;
    }
    if (classKinds.has(node.kind)) {
      const entry = symbol(node, node.kind, context, '', { extends: named(node.extends) ? resolveName(named(node.extends), context) : '',
        traits: (node.body || []).filter(child => child.kind === 'traituse').flatMap(child => child.traits || []).map(trait => resolveName(named(trait), context)) });
      const classScope = { kind: 'class', name: entry?.qualifiedName || '', start: node.loc.start.offset,
        end: node.loc.end.offset, variables: [], context };
      result.scopes.push(classScope);
      for (const child of node.body || []) visit(child, context, entry, classScope);
      return;
    }
    if (callableKinds.has(node.kind)) {
      const args = (node.arguments || []).map(arg => `${arg.nullable ? '?' : ''}${typeName(arg.type)} $${named(arg.name)}`.trim());
      const signature = `${named(node.name) || 'function'}(${args.join(', ')})${node.type ? `: ${typeName(node.type)}` : ''}`;
      symbol(node, node.kind === 'method' ? 'method' : 'function', context, node.kind === 'method' ? owner?.qualifiedName : '',
        { signature, isStatic: !!node.isStatic, visibility: node.visibility || 'public', type: typeName(node.type) });
      const routine = { kind: 'function', name: named(node.name), owner: owner?.qualifiedName,
        start: node.loc.start.offset, end: node.loc.end.offset, variables: [], context };
      result.scopes.push(routine);
      for (const argument of node.arguments || []) {
        if (node.kind === 'method' && lower(named(node.name)) === '__construct' && argument.flags) {
          symbol(argument, 'property', context, owner?.qualifiedName, { type: typeName(argument.type), isStatic: false,
            visibility: argument.flags & 4 ? 'private' : argument.flags & 2 ? 'protected' : 'public' });
        }
        routine.variables.push({ name: `$${named(argument.name)}`, kind: 'variable', path, range: phpRange(argument.loc),
          selectionRange: phpRange(argument.name?.loc || argument.loc), type: typeName(argument.type), start: argument.loc.start.offset });
      }
      if (node.body) visit(node.body, context, owner, routine);
      return;
    }
    if (node.kind === 'propertystatement') {
      for (const property of node.properties) symbol(property, 'property', context, owner?.qualifiedName,
        { type: typeName(property.type), visibility: node.visibility || 'public', isStatic: !!node.isStatic });
      return;
    }
    if (['constantstatement', 'classconstant'].includes(node.kind)) {
      for (const constant of node.constants || []) symbol(constant, 'constant', context, owner?.qualifiedName,
        { isStatic: !!owner, visibility: node.visibility || 'public' });
      return;
    }
    if (node.kind === 'enumcase') { symbol(node, 'constant', context, owner?.qualifiedName, { isStatic: true, visibility: 'public' }); return; }
    if (node.kind === 'assign' && node.left?.kind === 'variable' && typeof node.left.name === 'string') {
      const variable = { name: `$${node.left.name}`, kind: 'variable', path, range: phpRange(node.left.loc),
        selectionRange: phpRange(node.left.loc), start: node.left.loc.start.offset,
        type: node.right?.kind === 'new' ? named(node.right.what) : '' };
      scope?.variables.push(variable);
    }
    for (const child of children(node)) visit(child, context, owner, scope);
  }
  const context = contextFor('', ast.children, ast);
  const globalScope = { kind: 'function', name: '', owner: '', start: 0, end: source.length, variables: [], context };
  result.scopes.push(globalScope);
  for (const child of ast.children) visit(child, context, null, globalScope);
  return result;
}

function wordAt(source, offset) {
  const left = source.slice(0, offset).match(/[\p{L}\p{N}_\\$]*$/u)?.[0] || '';
  const right = source.slice(offset).match(/^[\p{L}\p{N}_\\$]*/u)?.[0] || '';
  return { word: left + right, prefix: left, start: offset - left.length, end: offset + right.length };
}

/** Incremental declarations, with predictable per-file and project memory limits. */
export class PhpProjectIndex {
  constructor({ phpVersion = '8.3', limits = PHP_INDEX_LIMITS } = {}) {
    this.phpVersion = phpVersion;
    this.limits = limits;
    this.files = new Map();
    this.bytes = 0;
  }
  update(path, source, version = 0) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.') || /[\\\0]/.test(path)) throw new TypeError('Invalid workspace path.');
    const previous = this.files.get(path);
    if (previous && previous.version > version) return { stale: true };
    if (typeof source !== 'string') throw new TypeError('PHP source must be text.');
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > this.limits.fileBytes || (!previous && this.files.size >= this.limits.files)
      || this.bytes - (previous?.bytes || 0) + bytes > this.limits.bytes) {
      this.remove(path);
      return { limited: true, diagnostics: [] };
    }
    let analysis;
    try { analysis = analyzePhp(source, path, this.phpVersion); }
    catch (error) { this.remove(path); throw error; }
    this.bytes += bytes - (previous?.bytes || 0);
    this.files.set(path, { ...analysis, bytes, version });
    return { diagnostics: analysis.diagnostics, symbols: analysis.symbols, inline: analysis.inline };
  }
  remove(path) {
    for (const [name, file] of this.files) if (name === path || name.startsWith(`${path}/`)) { this.bytes -= file.bytes; this.files.delete(name); }
  }
  status() { return { files: this.files.size, bytes: this.bytes, phpVersion: this.phpVersion }; }
  context(path, offset) {
    const file = this.files.get(path);
    if (!file) return null;
    const scope = file.scopes.filter(item => item.kind === 'function' && contains(item, offset)).sort((a, b) => b.start - a.start)[0];
    const owner = file.scopes.find(item => item.kind === 'class' && contains(item, offset))?.name || '';
    const namespace = file.contexts.filter(item => contains(item, offset)).sort((a, b) => b.start - a.start)[0];
    return { file, scope, owner, namespace };
  }
  allSymbols() { return [...this.files.values()].flatMap(file => file.symbols); }
  members(owner, accessOwner, seen = new Set()) {
    if (!owner || seen.has(lower(owner))) return [];
    seen.add(lower(owner));
    const symbols = this.allSymbols();
    const declaration = symbols.find(item => classKinds.has(item.kind) && lower(item.qualifiedName) === lower(owner));
    const own = symbols.filter(item => lower(item.container) === lower(owner)
      && (item.visibility === 'public' || lower(accessOwner) === lower(owner)));
    const inherited = [declaration?.extends, ...(declaration?.traits || [])]
      .flatMap(parent => this.members(parent, accessOwner, seen));
    return [...own, ...inherited.filter(item => !own.some(member => lower(member.name) === lower(item.name)))];
  }
  memberTarget(source, start, context) {
    const prefix = source.slice(0, start);
    const match = prefix.match(/(\$?[\p{L}\p{N}_\\]+)\s*(->|\?->|::)\s*$/u);
    // A complex receiver is intentionally unresolved, not mistaken for a global
    // function or class having the same spelling as the member being requested.
    if (!match) return /(?:->|::)\s*$/.test(prefix) ? { owner: '', isStatic: /::\s*$/.test(prefix) } : null;
    const receiver = match[1];
    let owner = '';
    if (receiver === '$this' || ['self', 'static'].includes(lower(receiver))) owner = context.owner;
    else if (lower(receiver) === 'parent') owner = this.allSymbols().find(item => item.qualifiedName === context.owner)?.extends || '';
    else if (receiver.startsWith('$')) {
      const variable = context.scope?.variables.filter(item => item.name === receiver && item.start <= start).at(-1);
      if (variable?.type && !/[|&]/.test(variable.type)) owner = resolveName(variable.type, context.namespace);
    } else if (match[2] === '::') owner = resolveName(receiver, context.namespace);
    return { owner, isStatic: match[2] === '::' };
  }
  complete(path, source, offset) {
    const context = this.context(path, offset);
    if (!context || context.file.inline.some(span => contains(span, offset))) return [];
    const word = wordAt(source, offset);
    const target = this.memberTarget(source, word.start, context);
    let candidates;
    if (target) candidates = this.members(target.owner, context.owner)
      .filter(item => target.isStatic ? item.isStatic || item.kind === 'constant' : !item.isStatic)
      .map(item => ({ ...item, name: target.isStatic && item.kind === 'property' ? `$${item.name}` : item.name }));
    else if (word.prefix.startsWith('$')) candidates = [...(context.scope?.variables || []), ...(context.owner ? [{ name: '$this', kind: 'variable', type: context.owner }] : [])];
    else candidates = this.allSymbols().filter(item => !item.container).map(item => {
      const imported = Object.entries(context.namespace.imports).find(([, alias]) => lower(alias.name) === lower(item.qualifiedName));
      const insertText = word.prefix.startsWith('\\') ? `\\${item.qualifiedName}` : imported?.[1].alias
        || (item.namespace === context.namespace.namespace || !item.namespace ? item.name : `\\${item.qualifiedName}`);
      return { ...item, name: imported?.[1].alias || item.name, insertText };
    }).concat(keywords.map(name => ({ name, kind: 'keyword' })));
    const seen = new Set();
    return candidates.filter(item => lower(item.name).startsWith(lower(word.prefix.replace(/^.*\\/, '')))
      && !seen.has(item.qualifiedName || item.name) && seen.add(item.qualifiedName || item.name))
      .slice(0, 250).map(item => ({ label: item.name, kind: item.kind, insertText: item.insertText || item.name,
        detail: item.signature || item.qualifiedName || item.type || '', documentation: item.documentation || '',
        replaceStart: word.start, replaceEnd: word.end }));
  }
  definition(path, source, offset) {
    const context = this.context(path, offset);
    if (!context || context.file.inline.some(span => contains(span, offset))) return [];
    const word = wordAt(source, offset);
    const target = this.memberTarget(source, word.start, context);
    if (target) return this.members(target.owner, context.owner).filter(item => matches(item, word.word.replace(/^\$/, '')));
    if (word.word.startsWith('$')) return (context.scope?.variables || []).filter(item => item.name === word.word && item.start <= offset).slice(-1);
    const resolved = ['class', 'function', 'const'].map(kind => resolveName(word.word, context.namespace, kind));
    const names = new Set(resolved.map(lower));
    // PHP falls back to global functions/constants, but never to a global class.
    const symbols = this.allSymbols().filter(item => !item.container);
    const primary = symbols.filter(item => item.kind === 'constant' ? resolved.includes(item.qualifiedName) : names.has(lower(item.qualifiedName)));
    if (primary.length) return primary;
    return symbols.filter(item => !word.word.includes('\\') && ['function', 'constant'].includes(item.kind)
      && !item.namespace && matches(item, word.word));
  }
}
