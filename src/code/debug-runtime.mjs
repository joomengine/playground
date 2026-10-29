const ROOTS = ['/persist', '/config', '/tmp', '/internal'];
const INTERNAL_PREFIX = '/internal/jec-';
const MAX_RESPONSE_BYTES = 320 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;

function sourcePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/persist/www/') || /[\0\r\n\\]/.test(value)
    || value.split('/').some(part => part === '..' || part === '.')) throw new TypeError('PHP debug sources must be inside the active Joomla workspace.');
  return value;
}
function phpString(value) { return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`; }
function debugPath(value) { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`; }
function encodedExpression(value) {
  const bytes = new TextEncoder().encode(`return (${value});`);
  if (bytes.length > MAX_COMMAND_BYTES / 2) throw new RangeError('PHP debug expression is too large.');
  return `eval(base64_decode('${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}'))`;
}
function equalBytes(left, right) {
  return left?.length === right?.length && left.every((byte, index) => byte === right[index]);
}
function snapshot(fs) {
  const result = new Map();
  const visit = path => {
    if (path.startsWith(INTERNAL_PREFIX)) return;
    const stat = fs.lstat(path);
    const record = { mode: stat.mode, atime: stat.atime, mtime: stat.mtime };
    if (fs.isLink(stat.mode)) record.link = fs.readlink(path);
    else if (fs.isDir(stat.mode)) {
      record.directory = true;
      for (const name of fs.readdir(path)) if (name !== '.' && name !== '..') visit(`${path}/${name}`);
    } else if (fs.isFile(stat.mode)) record.bytes = fs.readFile(path, { encoding: 'binary' }).slice();
    else return;
    result.set(path, record);
  };
  for (const root of ROOTS) {
    if (!fs.analyzePath(root).exists) continue;
    // The persisted source root may be a mount alias. Mirror its contents into
    // an ordinary directory; never mount the same IDBFS store in two runtimes.
    const stat = fs.stat(root);
    result.set(root, { directory: true, mode: stat.mode, atime: stat.atime, mtime: stat.mtime });
    for (const name of fs.readdir(root)) if (name !== '.' && name !== '..') visit(`${root}/${name}`);
  }
  return result;
}
function remove(fs, path) {
  const stat = fs.lstat(path);
  if (fs.isDir(stat.mode)) {
    for (const name of fs.readdir(path)) if (name !== '.' && name !== '..') remove(fs, `${path}/${name}`);
    fs.rmdir(path);
  } else fs.unlink(path);
}
function equivalent(a, b) {
  return a && b && a.directory === b.directory && a.link === b.link
    && a.mode === b.mode && Number(a.mtime) === Number(b.mtime) && Number(a.atime) === Number(b.atime)
    && (a.bytes ? equalBytes(a.bytes, b.bytes) : !b.bytes);
}
function applySnapshot(fs, previous, next) {
  for (const [path, old] of [...previous].sort((a, b) => b[0].length - a[0].length)) {
    if (ROOTS.includes(path)) continue;
    const value = next.get(path);
    if ((!value || old.directory !== value.directory || old.link !== value.link)
      && fs.analyzePath(path, true).exists) remove(fs, path);
  }
  for (const [path, value] of [...next].sort((a, b) => a[0].length - b[0].length)) {
    if (equivalent(previous.get(path), value)) continue;
    if (value.directory) fs.mkdirTree(path);
    else {
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      if (value.link !== undefined) {
        if (!fs.analyzePath(path, true).exists) fs.symlink(value.link, path);
      } else {
        // Emscripten preloads native bridge PHP files as read-only. The owner
        // snapshot is authoritative, and its permissions are restored below.
        if (fs.analyzePath(path, true).exists) fs.chmod(path, value.mode | 0o200);
        try { fs.writeFile(path, value.bytes); }
        catch (error) { throw new Error(`Could not restore PHP debug file ${path}: ${error?.message || `filesystem error ${error?.errno ?? String(error)}`}`); }
      }
    }
    if (value.link === undefined) { fs.chmod(path, value.mode); fs.utime(path, value.atime, value.mtime); }
  }
}

/** Structured-cloneable site state for a disposable debugger Worker. */
export function captureDebugFilesystem(fs) { return [...snapshot(fs)]; }

/** Apply the debugger's exact filesystem delta while the owner queue is held. */
export function applyDebugFilesystem(fs, previous, next) {
  applySnapshot(fs, new Map(previous), new Map(next));
}

/** Construct real CGI inputs for the native phpdbg HTTP SAPI bridge. */
export function debugRequestEnvironment(request, { siteURL, filename, pathInfo = '', cookieHeader = '' }) {
  const site = new URL(siteURL);
  const url = new URL(request.url);
  if (url.origin !== site.origin || !url.pathname.startsWith(site.pathname)) throw new TypeError('Debug requests must target the active site.');
  sourcePath(filename);
  const method = String(request.method || 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('Invalid PHP debug request method.');
  const headers = new Headers(request.headers || []);
  const body = request.body == null ? new Uint8Array() : new Uint8Array(request.body);
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new RangeError('PHP debug request exceeds the transport limit.');
  if (body.byteLength && ['GET', 'HEAD'].includes(method)) throw new TypeError('GET and HEAD debug requests cannot contain a body.');
  const scriptName = `${site.pathname}${filename.slice('/persist/www/'.length)}`;
  const env = {
    JEC_HTTP_REQUEST: '1', REQUEST_METHOD: method, QUERY_STRING: url.search.slice(1), REQUEST_URI: `${url.pathname}${url.search}`,
    SCRIPT_FILENAME: filename, PATH_TRANSLATED: filename, SCRIPT_NAME: scriptName, PHP_SELF: `${scriptName}${pathInfo}`,
    DOCUMENT_ROOT: '/persist/www', SERVER_PROTOCOL: 'HTTP/1.1', SERVER_SOFTWARE: 'JoomEngine Code',
    SERVER_NAME: url.hostname, SERVER_PORT: url.port || (url.protocol === 'https:' ? '443' : '80'),
    HTTPS: url.protocol === 'https:' ? 'on' : '', HTTP_HOST: url.host,
    HTTP_COOKIE: cookieHeader, CONTENT_TYPE: headers.get('content-type') || '', CONTENT_LENGTH: String(body.byteLength),
    REMOTE_ADDR: '127.0.0.1', REQUEST_SCHEME: url.protocol.slice(0, -1), PATH_INFO: pathInfo,
  };
  for (const [name, value] of headers) {
    if (['content-length', 'content-type', 'cookie', 'host'].includes(name)) continue;
    env[`HTTP_${name.toUpperCase().replaceAll('-', '_')}`] = value;
  }
  return { env, body };
}

/**
 * One phpdbg instance per selected HTTP request, sharing the existing database
 * adapter. The caller must reserve the site's request/write queue until execute
 * settles. It must terminate the owning Worker if bounded cooperative stop fails.
 */
export class PhpDebugRuntime {
  constructor(options) {
    if ((!options?.sourceFS && !Array.isArray(options?.snapshot)) || !options.siteURL) throw new TypeError('PHP debugging requires an active site filesystem snapshot and URL.');
    this.options = options;
    this.breakpoints = new Map();
    this.listeners = new Set();
    this.references = new Map();
    this.nextReference = 1;
    this.nextBreakpoint = 1;
    this.phase = 'idle';
    this.promptSequence = 0;
    this.promptWaiters = new Set();
    this.commandQueue = Promise.resolve();
    this.inspectionQueue = Promise.resolve();
    this.capabilities = { conditionalBreakpoints: true };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event, body = {}) {
    const message = { event, body };
    try { this.options.onEvent?.(message); } catch { /* Observers cannot interrupt PHP. */ }
    for (const listener of this.listeners) { try { listener(message); } catch { /* Same rule. */ } }
  }
  async execute(request, callbacks = {}) {
    if (this.phase !== 'idle') throw new Error('A PHP debug request is already active.');
    this.phase = 'starting';
    this.stopped = false;
    this.callbacks = callbacks;
    this.references.clear();
    const before = this.options.sourceFS ? snapshot(this.options.sourceFS) : new Map(this.options.snapshot);
    let processPromise;
    let processSettled = false;
    let commandFailure;
    const checkStopped = () => { if (this.stopped) throw new Error('PHP debugging was stopped. The request was not replayed.'); };
    try {
      const filename = this.options.resolveScript ? await this.options.resolveScript(request) : this.options.filename || '/persist/www/index.php';
      const { env, body } = debugRequestEnvironment(request, { ...this.options, filename,
        cookieHeader: typeof this.options.cookieHeader === 'function' ? this.options.cookieHeader() : this.options.cookieHeader });
      const { PhpDbgWeb } = this.options.Runtime ? {} : await import(this.options.moduleUrl);
      checkStopped();
      const Runtime = this.options.Runtime || PhpDbgWeb;
      const adapter = this.options.adapter || {};
      this.php = new Runtime({ ...adapter, version: this.options.phpVersion, ENV: env,
        sharedLibs: this.options.sharedLibs, files: [...(this.options.files || []), ...(adapter.files || [])],
        ini: this.options.ini || adapter.ini || '', autoTransaction: false, persist: [],
        ...this.options.runtimeOptions });
      this.php.addEventListener('output', event => this.emit('output', { category: 'console', output: event.detail.join('') }));
      this.php.addEventListener('error', event => this.emit('output', { category: 'stderr', output: event.detail.join('') }));
      this.binary = await this.php.binary;
      checkStopped();
      this.binary.jecDebugError = (message, filename, line) => this.emit('output', {
        category: 'stderr', output: `${message}\n`,
        ...(filename.startsWith('/persist/www/') && Number.isInteger(line) && line > 0
          ? { source: { path: filename }, line, column: 1 } : {}),
      });
      applySnapshot(this.binary.FS, new Map(), before);
      this.binary.FS.mkdirTree('/internal');
      // Native libc caches environ independently of the Emscripten ENV object.
      // The HTTP extension installs these before SAPI request activation.
      this.binary.FS.writeFile('/internal/jec-request-environment.bin', new TextEncoder().encode(
        Object.entries(env).map(([name, value]) => `${name}\0${value}\0`).join('')));
      this.binary.FS.writeFile('/internal/jec-request-body.bin', body);
      const prepend = this.options.prepend || '/internal/rocket-http.php';
      this.binary.FS.writeFile('/internal/jec-request.php', `<?php\nrequire_once ${phpString(prepend)};\nrequire ${phpString(filename)};\n`);
      // PhpDbgWeb.provideInput starts a browser persistence transaction even when
      // autoTransaction is false. This request instance never owns browser stores.
      this.php.startTransaction = async () => {};
      this.php.addEventListener('stdin-request', () => { void this.onPrompt().catch(error => { commandFailure = error; this.rejectPrompts(error); }); });
      const ready = this.waitForPrompt(this.promptSequence);
      processPromise = this.php.run().finally(() => { processSettled = true; });
      processPromise.catch(error => this.rejectPrompts(error));
      await ready;
      checkStopped();
      await this.send('set pagination off');
      checkStopped();
      await this.send('set colors off');
      checkStopped();
      await this.send('exec /internal/jec-request.php');
      checkStopped();
      for (const [path, points] of this.breakpoints) { await this.installBreakpoints(path, points); checkStopped(); }
      this.phase = 'running';
      callbacks.started?.();
      this.emit('continued', { threadId: 1, allThreadsContinued: true });
      await this.php.provideInput('run');
      await processPromise;
      if (commandFailure) throw commandFailure;
      if (this.stopped) throw new Error('PHP debugging was stopped. The request was not replayed.');
      if (this.binary.FS.analyzePath('/internal/jec-response-error.txt').exists) {
        throw new Error(this.binary.FS.readFile('/internal/jec-response-error.txt', { encoding: 'utf8' }));
      }
      const headerText = this.binary.FS.readFile('/internal/jec-response-headers.txt', { encoding: 'utf8' });
      const [statusText, ...lines] = headerText.split('\n');
      const status = Number(statusText);
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('PHP debugging returned an invalid HTTP response status.');
      const headers = lines.filter(Boolean).map(line => {
        const colon = line.indexOf(':');
        if (colon <= 0) throw new Error('PHP debugging returned an invalid HTTP response header.');
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      });
      const response = this.binary.FS.readFile('/internal/jec-response-body.bin', { encoding: 'binary' });
      if (response.byteLength > MAX_RESPONSE_BYTES) throw new Error('PHP debug response exceeds the transport limit.');
      return { status, statusText: '', headers, body: response, databaseUsed: true };
    } catch (error) {
      if (processPromise && !processSettled) {
        this.phase = 'stopped';
        await this.php.provideInput('quit');
        await processPromise.catch(() => {});
      }
      throw error;
    } finally {
      // Even stopped requests can already have changed files and database rows.
      // Their filesystem delta is retained; there is deliberately no replay.
      if (this.binary && processSettled) {
        const after = snapshot(this.binary.FS);
        this.snapshotEntries = [...after];
        if (this.options.sourceFS) applySnapshot(this.options.sourceFS, before, after);
      }
      this.rejectPrompts(new Error('The PHP debug request has ended.'));
      this.references.clear();
      this.php = null; this.binary = null; this.phase = 'idle';
      this.emit('terminated', {});
    }
  }
  waitForPrompt(after) {
    if (this.promptSequence > after) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = { after, resolve, reject };
      entry.timer = setTimeout(() => { this.promptWaiters.delete(entry); reject(new Error('PHP debugger command timed out.')); }, 30_000);
      this.promptWaiters.add(entry);
    });
  }
  rejectPrompts(error) {
    for (const entry of this.promptWaiters) { clearTimeout(entry.timer); entry.reject(error); }
    this.promptWaiters.clear();
  }
  async onPrompt() {
    this.promptSequence++;
    for (const entry of this.promptWaiters) if (this.promptSequence > entry.after) {
      clearTimeout(entry.timer); this.promptWaiters.delete(entry); entry.resolve();
    }
    if (!['running', 'stopping'].includes(this.phase)) return;
    const active = await this.php.isRunning();
    if (!active || this.stopped) {
      this.phase = this.stopped ? 'stopped' : 'finishing';
      await this.php.provideInput('quit');
      return;
    }
    this.phase = 'paused';
    this.references.clear();
    this.callbacks.paused?.();
    const file = await this.php.currentFile(), line = await this.php.currentLine();
    const hit = (this.breakpoints.get(file) || []).filter(point => point.line === line && point.nativeId != null);
    for (const point of hit) if (!point.verified) {
      point.verified = true;
      this.emit('breakpoint', { reason: 'changed', breakpoint: { id: point.id, line, verified: true, source: { path: file } } });
    }
    this.emit('stopped', { reason: this.pauseRequested ? 'pause' : hit.length ? 'breakpoint' : this.resumeReason || 'exception',
      threadId: 1, allThreadsStopped: true, ...(hit.length ? { hitBreakpointIds: hit.map(point => point.id) } : {}) });
    this.pauseRequested = false;
  }
  async send(command) {
    if (typeof command !== 'string' || /[\r\n\0]/.test(command) || new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) {
      throw new TypeError('Debugger commands must be one bounded line.');
    }
    const result = this.commandQueue.then(async () => {
      const waiting = this.waitForPrompt(this.promptSequence);
      await this.php.provideInput(command);
      await waiting;
      this.php.flush();
    });
    this.commandQueue = result.catch(() => {});
    return result;
  }
  async setBreakpoints(path, values) {
    sourcePath(path);
    if (!Array.isArray(values) || values.length > 1000) throw new TypeError('A source may have at most 1000 breakpoints.');
    const points = values.map(value => {
      if (!Number.isSafeInteger(value.line) || value.line < 1) throw new TypeError('Breakpoint lines are positive integers.');
      if (value.condition != null && (typeof value.condition !== 'string' || /[\r\n\0]/.test(value.condition))) throw new TypeError('A conditional breakpoint must use one PHP expression.');
      return { id: this.nextBreakpoint++, line: value.line, condition: value.condition || '', verified: false };
    });
    if (this.php && this.phase !== 'paused') throw new Error('Change breakpoints while the PHP request is paused.');
    if (this.php) {
      for (const point of this.breakpoints.get(path) || []) if (point.nativeId != null) await this.send(`break del ${point.nativeId}`);
      await this.installBreakpoints(path, points);
    }
    this.breakpoints.set(path, points);
    return points.map(({ nativeId, condition, ...point }) => ({ ...point, source: { path },
      ...(!point.verified ? { message: 'Pending the selected PHP request and source resolution.' } : {}) }));
  }
  async installBreakpoints(path, points) {
    for (const point of points) {
      const before = await this.php.bpCount();
      const expression = point.condition ? `break at ${debugPath(path)}:${point.line} if ${encodedExpression(point.condition)}` : `break ${debugPath(path)}:${point.line}`;
      await this.send(expression);
      const after = await this.php.bpCount();
      point.nativeId = after > before ? before : null;
      point.verified = false; // Registration alone does not prove this line is executable.
      this.emit('breakpoint', { reason: 'changed', breakpoint: { id: point.id, line: point.line, verified: point.verified, source: { path } } });
    }
  }
  requirePaused() { if (!this.php || this.phase !== 'paused') throw new Error('Pause PHP before inspecting or stepping.'); }
  async resume(command) {
    await this.inspectionQueue;
    this.requirePaused();
    this.phase = 'running'; this.resumeReason = command === 'continue' ? undefined : 'step'; this.references.clear(); this.callbacks.resumed?.();
    this.emit('continued', { threadId: 1, allThreadsContinued: true });
    await this.php.provideInput(command);
  }
  continue() { return this.resume('continue'); }
  next() { return this.resume('next'); }
  stepIn() { return this.resume('step'); }
  async stepOut() {
    await this.inspectionQueue;
    this.requirePaused();
    await this.send('ev jec_debug_step_out()');
    return this.resume('finish');
  }
  async pause() {
    if (!this.binary || this.phase !== 'running') throw new Error('PHP is not executing.');
    this.pauseRequested = true; this.binary.jecDebugControl = 1;
  }
  async stop() {
    if (this.phase === 'idle') return;
    this.stopped = true;
    if (this.phase === 'starting') return;
    if (this.phase === 'paused') {
      this.phase = 'stopped'; await this.php.provideInput('quit');
    } else { this.phase = 'stopping'; this.binary.jecDebugControl = 2; }
  }
  async stackTrace() {
    this.requirePaused();
    return (await this.php.dumpBacktrace()).filter(frame => frame.filename.startsWith('/persist/www/')).map(frame => ({ id: frame.frame,
      name: frame.filename.split('/').at(-1) || 'PHP', source: { path: frame.filename }, line: frame.lineNo || 1, column: 1 }));
  }
  reference(value) { const id = this.nextReference++; this.references.set(id, value); return id; }
  async withFrame(frame, action) {
    const result = this.inspectionQueue.then(async () => {
      this.requirePaused();
      if (!Number.isInteger(frame) || frame < 0) throw new TypeError('A valid PHP frame is required.');
      const php = this.php;
      const old = await php.switchFrame(frame);
      try { return await action(); } finally { if (this.php === php && this.phase === 'paused') await php.switchFrame(old); }
    });
    this.inspectionQueue = result.catch(() => {});
    return result;
  }
  async scopes(frameId) {
    return this.withFrame(frameId, async () => [
      { name: 'Locals', variablesReference: this.reference(await this.php.dumpVars() || {}), expensive: false },
      { name: 'Globals', variablesReference: this.reference(await this.php.dumpGlobals() || {}), expensive: true },
    ]);
  }
  describe(name, value) {
    const object = value !== null && (typeof value === 'object' || typeof value === 'function');
    const array = Array.isArray(value) || (object && typeof value[Symbol.iterator] === 'function' && typeof value.length === 'number');
    return { name, value: object ? (array ? `Array(${value.length})` : 'Object') : value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value),
      type: value === null ? 'null' : array ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : typeof value === 'boolean' ? 'bool' : typeof value,
      variablesReference: object ? this.reference(value) : 0,
      ...(array ? { indexedVariables: value.length } : {}) };
  }
  async variables(reference, { start = 0, count = 100 } = {}) {
    this.requirePaused();
    const value = this.references.get(reference);
    if (!value) throw new Error('The PHP variable reference expired.');
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0 || count > 1000) throw new RangeError('Inspect at most 1000 properties at a time.');
    return Reflect.ownKeys(value).filter(name => typeof name === 'string').slice(start, start + (count || 100)).map(name => {
      try { return this.describe(name, value[name]); } catch (error) { return { name, value: error.message, variablesReference: 0 }; }
    });
  }
  async evaluate(expression, frameId = 0) {
    if (typeof expression !== 'string' || !expression.trim() || /[\r\n\0]/.test(expression)) throw new TypeError('Enter one PHP expression. Evaluation may have side effects.');
    return this.withFrame(frameId, async () => {
      // phpdbg eval executes in the selected frame. A unique temporary captures
      // the value without requiring console-output parsing or JSON conversion.
      const name = `__jec_eval_${crypto.randomUUID().replaceAll('-', '')}`;
      // phpdbg prints its eval return value recursively. Return null while
      // retaining the value in the selected frame for progressive inspection.
      await this.send(`ev ($${name} = ${encodedExpression(expression)}) ? null : null;`);
      const values = await this.php.dumpVars();
      if (!Object.prototype.hasOwnProperty.call(values || {}, name)) throw new Error('PHP expression evaluation failed. See the debug console for the PHP error.');
      const value = values[name];
      const result = this.describe('', value);
      await this.send(`ev eval(${phpString(`unset($${name});`)});`);
      return { result: result.value, type: result.type, variablesReference: result.variablesReference, indexedVariables: result.indexedVariables };
    });
  }
  command(name, args = {}) {
    const allowed = { setBreakpoints: () => this.setBreakpoints(args.path, args.breakpoints),
      continue: () => this.continue(), next: () => this.next(), stepIn: () => this.stepIn(), stepOut: () => this.stepOut(),
      pause: () => this.pause(), stop: () => this.stop(), stackTrace: () => this.stackTrace(),
      scopes: () => this.scopes(args.frameId), variables: () => this.variables(args.reference, args),
      evaluate: () => this.evaluate(args.expression, args.frameId) };
    if (!Object.hasOwn(allowed, name)) throw new TypeError(`Unsupported PHP debugger operation: ${name}`);
    return allowed[name]();
  }
}
