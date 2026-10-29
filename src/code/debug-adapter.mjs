const THREAD_ID = 1;
const EVENTS = new Set(['stopped', 'continued', 'output', 'breakpoint', 'terminated', 'exited', 'thread', 'invalidated', 'loadedSource']);

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0x7fffffff) throw new TypeError(`${name} must be an integer from ${minimum} to 2147483647.`);
  return value;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\\]/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) throw new TypeError('The source must be inside the active JoomEngine Code workspace.');
  return value;
}

/** Keep PHP paths and editor URIs tied to the same active site. */
export function createDebugSourceMapper({ siteId, root = '/persist/www', toEditorPath, toRuntimePath } = {}) {
  if (typeof siteId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(siteId)) throw new TypeError('Invalid JoomEngine Code site identity.');
  relativePath(root);
  root = root.replace(/\/+$/, '');
  if (!root) throw new TypeError('The debugger workspace cannot be the filesystem root.');
  const runtime = value => {
    relativePath(value);
    if (value !== root && !value.startsWith(`${root}/`)) throw new TypeError('The PHP source is outside the active workspace.');
    return value;
  };
  const editor = value => {
    if (typeof value !== 'string') throw new TypeError('An editor source URI is required.');
    const match = /^jec:\/\/([^/?#]+)(\/[^?#]*)$/.exec(value);
    if (!match || match[1] !== siteId) throw new TypeError('The source URI belongs to a different workspace.');
    const decoded = decodeURIComponent(match[2]);
    // Encoded separators must not create a different document identity.
    if (/%(?:2f|5c|00)/i.test(match[2])) throw new TypeError('Encoded separators are not valid in source URIs.');
    return relativePath(decoded);
  };
  return {
    toRuntime(value) {
      const checked = value?.startsWith('jec://') ? runtime(`${root}${editor(value)}`) : runtime(value);
      return toRuntimePath ? runtime(toRuntimePath(value)) : checked;
    },
    toEditor(value) {
      runtime(value);
      const result = toEditorPath ? toEditorPath(value) : `jec://${siteId}${(value.slice(root.length) || '/').split('/').map(encodeURIComponent).join('/')}`;
      editor(result);
      return result;
    },
  };
}

/**
 * An in-browser VS Code DebugAdapter implementation. The backend executes real
 * PHP and owns breakpoints, frame/variable handles and lifecycle events. All PHP
 * source locations use one-based lines/columns internally. start(config) arms
 * execution and resolves promptly; it must not await the paused HTTP request.
 *
 * The backend supplies start, stop, setBreakpoints, continue, next, stepIn,
 * stepOut, pause, stackTrace, scopes, variables, evaluate and subscribe. Its
 * subscribe callback receives DAP-shaped { event, body } notifications from the
 * actual engine. No stopped/continued/inspection results are synthesized here.
 */
export class InlineDebugAdapter {
  #backend;
  #mapper;
  #listeners = new Set();
  #subscription;
  #sequence = 0;
  #lastRequest = -1;
  #initialized = false;
  #launch = null;
  #configurationAttempted = false;
  #started = false;
  #paused = false;
  #terminated = false;
  #disposed = false;
  #generation = 0;
  #setupQueue = Promise.resolve();
  #stopPromise = null;
  #linesAt1 = true;
  #columnsAt1 = true;

  constructor(backend, options) {
    for (const name of ['subscribe', 'start', 'stop', 'setBreakpoints', 'continue', 'next', 'stepIn', 'stepOut', 'pause', 'stackTrace', 'scopes', 'variables', 'evaluate']) {
      if (typeof backend?.[name] !== 'function') throw new TypeError(`The PHP debugger backend must implement ${name}().`);
    }
    this.#backend = backend;
    this.#mapper = createDebugSourceMapper(options);
    this.#subscription = backend.subscribe(event => this.#receive(event));
  }

  /** VS Code Event<DebugProtocolMessage>, without a dependency on its emitter. */
  onDidSendMessage = (listener, thisArgs, disposables) => {
    if (typeof listener !== 'function') throw new TypeError('A debug protocol listener is required.');
    const entry = { listener, thisArgs };
    if (!this.#disposed) this.#listeners.add(entry);
    const disposable = { dispose: () => this.#listeners.delete(entry) };
    disposables?.push(disposable);
    return disposable;
  };

  #send(message) {
    if (this.#disposed) return;
    const value = { seq: ++this.#sequence, ...message };
    for (const { listener, thisArgs } of [...this.#listeners]) {
      try { listener.call(thisArgs, value); } catch { /* A client observer cannot interrupt PHP. */ }
    }
  }

  #event(event, body = {}) { this.#send({ type: 'event', event, body }); }

  #end(body = {}) {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#paused = false;
    this.#generation++;
    this.#event('terminated', body);
  }

  #source(source, fallback) {
    if (!source && !fallback) return undefined;
    const value = { ...(source || {}), path: source?.path ?? fallback };
    delete value.sources;
    delete value.sourceReference;
    if (typeof value.path !== 'string') { delete value.path; return value; }
    try { value.path = this.#mapper.toEditor(value.path); }
    catch {
      // Internal PHP frames remain inspectable, but are not file-service entry points.
      return { name: 'PHP internal source', presentationHint: 'deemphasize' };
    }
    return value;
  }

  #line(value) { return value === undefined ? undefined : value - (this.#linesAt1 ? 0 : 1); }
  #column(value) { return value === undefined ? undefined : value - (this.#columnsAt1 ? 0 : 1); }

  #location(value) {
    const result = { ...value };
    if (result.source || result.path) result.source = this.#source(result.source, result.path);
    delete result.path;
    for (const key of ['line', 'endLine']) if (result[key] !== undefined) result[key] = this.#line(result[key]);
    for (const key of ['column', 'endColumn']) if (result[key] !== undefined) result[key] = this.#column(result[key]);
    return result;
  }

  #receive(message) {
    if (this.#disposed || this.#terminated || !this.#initialized || !EVENTS.has(message?.event)) return;
    let body = { ...(message.body || {}) };
    if (message.event === 'terminated') { this.#end(body); return; }
    if (message.event === 'stopped') {
      this.#paused = true;
      body = { threadId: THREAD_ID, allThreadsStopped: true, ...body };
    }
    if (message.event === 'continued') {
      this.#paused = false;
      body = { threadId: THREAD_ID, allThreadsContinued: true, ...body };
    }
    if (message.event === 'breakpoint' && body.breakpoint) body.breakpoint = this.#location(body.breakpoint);
    if (message.event === 'loadedSource') body.source = this.#source(body.source);
    if (message.event === 'output') body = this.#location(body);
    this.#event(message.event, body);
  }

  #response(request, body, error) {
    this.#send({ type: 'response', request_seq: request.seq, command: request.command, success: !error,
      ...(error ? { message: error.message || String(error), body: { error: { id: 1,
        format: error.message || String(error), showUser: true } } } : body === undefined ? {} : { body }) });
  }

  async handleMessage(request) {
    if (this.#disposed || request?.type !== 'request') return;
    if (!Number.isSafeInteger(request.seq) || request.seq < 0 || typeof request.command !== 'string') return;
    if (request.seq <= this.#lastRequest) {
      this.#response(request, undefined, new Error('Debug request sequence numbers must increase; the request was not repeated.'));
      return;
    }
    this.#lastRequest = request.seq;
    const generation = this.#generation;
    try {
      const body = await this.#dispatch(request.command, request.arguments || {});
      if (this.#disposed) return;
      if (generation !== this.#generation && !['disconnect', 'terminate', 'configurationDone'].includes(request.command)) {
        throw new Error('The PHP debug session ended before this operation completed.');
      }
      this.#response(request, body);
      if (request.command === 'initialize') this.#event('initialized');
      if (['disconnect', 'terminate'].includes(request.command)) this.#end();
    } catch (error) { if (!this.#disposed) this.#response(request, undefined, error); }
  }

  #thread(args) {
    if (args.threadId !== undefined && args.threadId !== THREAD_ID) throw new Error('The requested PHP thread does not exist.');
  }

  #execution() {
    if (!this.#started) throw new Error('Start a PHP debug session before controlling execution.');
  }

  #inspection() {
    if (!this.#paused) throw new Error('Pause a PHP request before inspecting its state.');
  }

  #alive() {
    if (this.#disposed || this.#terminated) throw new Error('The PHP debug session has ended.');
  }

  #prepare(callback) {
    const result = this.#setupQueue.then(() => { this.#alive(); return callback(); });
    this.#setupQueue = result.catch(() => {});
    return result;
  }

  #stop() {
    this.#stopPromise ??= Promise.resolve().then(() => this.#backend.stop());
    return this.#stopPromise;
  }

  async #breakpoints(args) {
    const path = this.#mapper.toRuntime(args.source?.path);
    const values = args.breakpoints ?? args.lines?.map(line => ({ line })) ?? [];
    if (!Array.isArray(values)) throw new TypeError('Breakpoints must be an array.');
    if (values.length > 10_000) throw new RangeError('A source file cannot contain more than 10000 breakpoints.');
    const prepared = values.map(value => {
      const line = integer(value?.line, 'Breakpoint line', this.#linesAt1 ? 1 : 0) + (this.#linesAt1 ? 0 : 1);
      const column = value.column === undefined ? undefined : integer(value.column, 'Breakpoint column', this.#columnsAt1 ? 1 : 0) + (this.#columnsAt1 ? 0 : 1);
      let unsupported;
      if (value.condition && !this.#backend.capabilities?.conditionalBreakpoints) unsupported = 'Conditional breakpoints are not supported by the loaded PHP runtime.';
      if (value.hitCondition) unsupported = 'Hit-count breakpoints are not supported by the loaded PHP runtime.';
      if (value.logMessage) unsupported = 'Logpoints are not supported by the loaded PHP runtime.';
      if (value.condition !== undefined && (typeof value.condition !== 'string' || value.condition.length > 65_536)) throw new TypeError('A breakpoint condition must be a PHP expression of at most 65536 characters.');
      if (column !== undefined && !this.#backend.capabilities?.columnBreakpoints) unsupported = 'PHP breakpoints apply to complete source lines.';
      return { input: { line, ...(column === undefined ? {} : { column }), ...(value.condition ? { condition: value.condition } : {}) }, unsupported };
    });
    const accepted = prepared.filter(value => !value.unsupported);
    const results = await this.#backend.setBreakpoints(path, accepted.map(value => value.input));
    if (!Array.isArray(results) || results.length !== accepted.length) throw new Error('The PHP runtime returned an invalid breakpoint result.');
    let index = 0;
    return { breakpoints: prepared.map(value => {
      const result = value.unsupported ? { verified: false, message: value.unsupported } : results[index++];
      if (typeof result?.verified !== 'boolean') throw new Error('The PHP runtime did not report breakpoint verification.');
      return this.#location({ ...value.input, ...result, source: result.source || { path } });
    }) };
  }

  async #dispatch(command, args) {
    if (command === 'initialize') {
      if (this.#initialized) throw new Error('The debug adapter has already been initialized.');
      if (args.pathFormat && !['path', 'uri'].includes(args.pathFormat)) throw new Error('Unsupported debugger path format.');
      this.#linesAt1 = args.linesStartAt1 !== false;
      this.#columnsAt1 = args.columnsStartAt1 !== false;
      this.#initialized = true;
      return { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true,
        supportsDelayedStackTraceLoading: true,
        supportsConditionalBreakpoints: this.#backend.capabilities?.conditionalBreakpoints === true,
        supportsEvaluateForHovers: false, supportsSetVariable: false, supportsRestartRequest: false,
        exceptionBreakpointFilters: [] };
    }
    if (!this.#initialized) throw new Error('Initialize JoomEngine Code debugging first.');
    if (this.#terminated && !['disconnect', 'terminate'].includes(command)) throw new Error('The PHP debug session has ended.');
    switch (command) {
      case 'launch':
        if (this.#launch) throw new Error('This adapter already has a PHP launch configuration.');
        if (args.noDebug) throw new Error('Use the normal Playground preview to execute without debugging.');
        this.#launch = { ...args };
        return {};
      case 'configurationDone':
        if (!this.#launch) throw new Error('Launch a PHP debug session before completing configuration.');
        if (this.#configurationAttempted) throw new Error('PHP debug configuration has already been submitted.');
        this.#configurationAttempted = true;
        await this.#setupQueue;
        this.#alive();
        await this.#backend.start(this.#launch);
        if (this.#disposed) { await this.#backend.stop(); throw new Error('The PHP debug session was disposed during startup.'); }
        this.#started = true;
        return {};
      case 'setBreakpoints': return this.#prepare(() => this.#breakpoints(args));
      case 'setExceptionBreakpoints':
        if ((args.filters || []).length || (args.filterOptions || []).length || (args.exceptionOptions || []).length) {
          throw new Error('Exception filters are not supported by the loaded PHP runtime.');
        }
        return { breakpoints: [] };
      case 'threads': return { threads: this.#started && !this.#terminated ? [{ id: THREAD_ID, name: 'Joomla PHP request' }] : [] };
      case 'stackTrace': {
        this.#thread(args); this.#inspection();
        const start = integer(args.startFrame ?? 0, 'Start frame');
        const levels = integer(args.levels ?? 0, 'Frame count');
        const frames = await this.#backend.stackTrace();
        if (!Array.isArray(frames)) throw new Error('The PHP runtime returned an invalid call stack.');
        return { stackFrames: frames.slice(start, levels ? start + levels : undefined).map(frame => this.#location({ column: 1, ...frame })), totalFrames: frames.length };
      }
      case 'scopes': {
        this.#inspection();
        const scopes = await this.#backend.scopes(integer(args.frameId, 'Stack frame'));
        if (!Array.isArray(scopes)) throw new Error('The PHP runtime returned invalid variable scopes.');
        return { scopes: scopes.map(scope => this.#location(scope)) };
      }
      case 'variables': {
        this.#inspection();
        const reference = integer(args.variablesReference, 'Variable reference', 1);
        const start = integer(args.start ?? 0, 'Variable start');
        const count = integer(args.count ?? 0, 'Variable count');
        if (args.filter !== undefined && !['named', 'indexed'].includes(args.filter)) throw new TypeError('Invalid variable filter.');
        const variables = await this.#backend.variables(reference, { start, count, ...(args.filter === undefined ? {} : { filter: args.filter }) });
        if (!Array.isArray(variables)) throw new Error('The PHP runtime returned invalid variables.');
        return { variables };
      }
      case 'evaluate': {
        this.#inspection();
        if (typeof args.expression !== 'string' || !args.expression.trim() || args.expression.length > 65_536) throw new TypeError('A PHP expression of at most 65536 characters is required.');
        if (args.context === 'hover') throw new Error('Automatic hover evaluation is disabled because PHP expressions can have side effects.');
        const frameId = args.frameId === undefined ? undefined : integer(args.frameId, 'Stack frame');
        const result = await this.#backend.evaluate(args.expression, frameId);
        if (typeof result?.result !== 'string' || !Number.isInteger(result.variablesReference) || result.variablesReference < 0) throw new Error('The PHP runtime returned an invalid evaluation result.');
        return result;
      }
      case 'continue':
        this.#thread(args); this.#execution(); await this.#backend.continue(); return { allThreadsContinued: true };
      case 'next': case 'stepIn': case 'stepOut': case 'pause':
        this.#thread(args); this.#execution(); await this.#backend[command](); return {};
      case 'disconnect': case 'terminate':
        if (args.restart) throw new Error('Restart the PHP debugger explicitly after this session ends.');
        await this.#stop(); return {};
      default: throw new Error(`Unsupported JoomEngine Code debugger request: ${command}.`);
    }
  }

  dispose() {
    if (this.#disposed) return this.#stopPromise;
    this.#disposed = true;
    this.#generation++;
    this.#listeners.clear();
    try {
      if (typeof this.#subscription === 'function') this.#subscription();
      else this.#subscription?.dispose?.();
    } catch { /* Runtime cleanup must continue if an event subscription failed. */ }
    // VS Code's dispose contract is synchronous, but callers can await cleanup.
    const stopping = this.#stop();
    stopping.catch(() => {});
    return stopping;
  }
}
