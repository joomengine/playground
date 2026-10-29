import { initialize, getService, IEditorService, IEditorGroupsService, IWorkbenchLayoutService,
  IWorkingCopyService, IFileService, ILogService, IWorkspaceContextService, IConfigurationService,
  ICommandService, IModelService, IExplorerService, IStatusbarService, IReplaceService, IMarkerService, ITextFileService, IWorkingCopyFileService, IDebugService, IQuickInputService, SyncDescriptor } from '@codingame/monaco-vscode-api';
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override';
import getFilesServiceOverride, { registerCustomProvider } from '@codingame/monaco-vscode-files-service-override';
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override';
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override';
import getExtensionsServiceOverride from '@codingame/monaco-vscode-extensions-service-override';
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override';
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override';
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override';
import getNotificationsServiceOverride from '@codingame/monaco-vscode-notifications-service-override';
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override';
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override';
import { ISearchService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service';
import { SearchProviderType } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search';
import { SearchService } from '@codingame/monaco-vscode-search-service-override/vscode/vs/workbench/services/search/common/searchService';
import { CommandsRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands';
import { Action2, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions';
import { SUPPORTED_ENCODINGS } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/encoding';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { JoomlaFileSystemProvider } from './file-provider.mjs';
import { mountDetachedTools } from './detached-tools.mjs';
import { JoomlaSearchProvider } from './search-provider.mjs';
import * as monaco from 'monaco-editor';
import { installPhpLanguageServices } from './languages.mjs';
import { WORKBENCH_MESSAGES } from './workbench-messages.mjs';
import { attachEditorRecovery } from './editor-session.mjs';

import '@codingame/monaco-vscode-theme-defaults-default-extension';
import '@codingame/monaco-vscode-theme-seti-default-extension';
import '@codingame/monaco-vscode-php-default-extension';
import '@codingame/monaco-vscode-javascript-default-extension';
import '@codingame/monaco-vscode-typescript-basics-default-extension';
import '@codingame/monaco-vscode-html-default-extension';
import '@codingame/monaco-vscode-css-default-extension';
import '@codingame/monaco-vscode-scss-default-extension';
import '@codingame/monaco-vscode-less-default-extension';
import '@codingame/monaco-vscode-json-default-extension';
import '@codingame/monaco-vscode-xml-default-extension';
import '@codingame/monaco-vscode-ini-default-extension';
import '@codingame/monaco-vscode-yaml-default-extension';
import '@codingame/monaco-vscode-sql-default-extension';
import '@codingame/monaco-vscode-markdown-basics-default-extension';
import '@codingame/monaco-vscode-shellscript-default-extension';
import '@codingame/monaco-vscode-typescript-language-features-default-extension';
import '@codingame/monaco-vscode-html-language-features-default-extension';
import '@codingame/monaco-vscode-css-language-features-default-extension';
import '@codingame/monaco-vscode-json-language-features-default-extension';

let initialized = false;

/** One workbench per iframe realm. Hiding/layout changes must preserve that realm. */
export async function mountWorkbench({ container, workspace, siteId, onSave = () => {},
  onError = () => {}, onDirtyChange = () => {}, debuggerBackend, getDebugConfiguration, storageId, phpVersion, onLanguageStatus = () => {}, onDetachedTools, t }) {
  const message = (key, values = {}) => {
    let text = t?.(key, values);
    if (!text || text === key) text = WORKBENCH_MESSAGES[key] || key;
    return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  };
  if (initialized) throw new Error('JoomEngine Code is already initialized in this view. Reuse its session.');
  initialized = true;
  const provider = new JoomlaFileSystemProvider(workspace, siteId, { onSave, onError });
  registerCustomProvider('jec', provider);
  const workerFiles = {
    extensionHostWorkerMain: './extension-host-worker.js', webWorkerExtensionHostIframe: './extension-host.html',
    editorWorkerService: './editor-worker.js', TextMateWorker: './textmate-worker.js', LocalFileSearchWorker: './search-worker.js',
  };
  globalThis.MonacoEnvironment = {
    getWorkerUrl(_id, label) {
      const filename = workerFiles[label];
      return filename ? new URL(filename, import.meta.url).href : undefined;
    },
    getWorkerOptions() { return { type: 'module' }; },
    getWorker(_id, label) {
      const filename = workerFiles[label];
      if (!filename) throw new Error(`JoomEngine Code has no bundled worker for ${label}.`);
      return new Worker(new URL(filename, import.meta.url), { type: 'module', name: `JoomEngine Code ${label}` });
    },
  };
  let debugServices = {}, debugExtension;
  if (debuggerBackend) {
    await import('vscode/localExtensionHost');
    const ansi = await import('@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/terminal/common/terminalColorRegistry');
    if (!ansi.ansiColorIdentifiers.length) ansi.registerColors();
    const [{ default: getDebugServiceOverride }, { registerExtension, ExtensionHostKind }] = await Promise.all([
      import('@codingame/monaco-vscode-debug-service-override'), import('@codingame/monaco-vscode-api/extensions'),
    ]);
    debugServices = getDebugServiceOverride();
    debugExtension = registerExtension({ name: 'php-debugger', publisher: 'joomengine', version: '0.1.0',
      engines: { vscode: '*' }, displayName: message('code.workbench.debugExtension'),
      contributes: { breakpoints: [{ language: 'php' }], debuggers: [{ type: 'joomengine-php', label: 'JoomEngine Code PHP', languages: ['php'],
        configurationAttributes: { launch: { required: ['url', 'method'], properties: {
          url: { type: 'string', description: message('code.workbench.debugURL') },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
          refresh: { type: 'boolean', default: false, description: message('code.workbench.debugRefresh') },
        } } } }] },
    }, ExtensionHostKind.LocalProcess);
  }
  await initialize({
    ...getFilesServiceOverride(), ...getConfigurationServiceOverride(), ...getModelServiceOverride(),
    ...getWorkbenchServiceOverride(), ...getThemeServiceOverride(), ...getTextmateServiceOverride(),
    ...getLanguagesServiceOverride(), ...getSearchServiceOverride(), ...getExplorerServiceOverride(),
    ...getWorkingCopyServiceOverride({ storage: 'memory' }), ...getPreferencesServiceOverride(),
    ...getNotificationsServiceOverride(), ...getDialogsServiceOverride(), ...getAccessibilityServiceOverride(),
    ...getExtensionsServiceOverride({ enableWorkerExtensionHost: true }), ...debugServices,
    // The upstream convenience override eagerly indexes all workspace filenames.
    // Use its normal search service and our bounded worker-backed provider instead.
    [ISearchService.toString()]: new SyncDescriptor(SearchService, [], true),
  }, container, {
    workspaceProvider: { workspace: { folderUri: provider.uri('/'), id: siteId }, trusted: true, open: async () => false },
    productConfiguration: { nameShort: 'JoomEngine Code', nameLong: 'JoomEngine Code', applicationName: 'joomengine-code',
      dataFolderName: '.joomengine-code', urlProtocol: 'joomengine-code', enableTelemetry: false },
    configurationDefaults: {
      'files.autoSave': 'off', 'files.hotExit': 'off', 'files.enableTrash': false,
      'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern',
      'workbench.iconTheme': 'vs-seti', 'window.title': '${dirty}${activeEditorShort}${separator}JoomEngine Code',
      'window.menuBarVisibility': 'compact', 'window.commandCenter': false,
      'workbench.activity.showAccounts': false, 'workbench.enableExperiments': false,
      'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
      // The pinned experimental background tokenizer can deliver stale state
      // deltas while native models are replaced during rename/recovery.
      'editor.experimental.asyncTokenization': false,
      'editor.minimap.enabled': false, 'workbench.editor.enablePreview': false,
      'security.workspace.trust.enabled': false,
      'js/ts.tsserver.web.typeAcquisition.enabled': false, 'typescript.tsserver.web.typeAcquisition.enabled': false,
      'json.schemaDownload.enable': false,
    },
  }, { userHome: URI.from({ scheme: 'jec', authority: siteId, path: '/' }) });
  const [editors, groups, layout, copies, commands, search, files, log, context, configuration, models, explorer, statusbar, replacements, markers, textFiles, workingCopyFiles, quickInput] = await Promise.all([
    IEditorService, IEditorGroupsService, IWorkbenchLayoutService, IWorkingCopyService, ICommandService,
    ISearchService, IFileService, ILogService, IWorkspaceContextService, IConfigurationService, IModelService, IExplorerService, IStatusbarService, IReplaceService, IMarkerService, ITextFileService, IWorkingCopyFileService, IQuickInputService,
  ].map(service => getService(service)));
  provider.isDirty = (path, recursive = false) => {
    const target = provider.canonicalPaths.get(path) || path;
    return copies.workingCopies.some(copy => {
      if (copy.resource.scheme !== 'jec' || copy.resource.authority !== siteId || !copy.isDirty()) return false;
      const canonical = provider.canonicalPaths.get(copy.resource.path) || copy.resource.path;
      return [copy.resource.path, canonical].some(candidate => candidate === path || candidate === target
        || (recursive && [path, target].some(parent => candidate.startsWith(parent === '/' ? '/' : `${parent}/`))));
    });
  };
  for (const method of ['move', 'copy', 'delete']) {
    const original = workingCopyFiles[method].bind(workingCopyFiles);
    const guarded = (operations, ...args) => {
      for (const operation of operations) {
        const target = method === 'delete' ? operation.resource : operation.file.target;
        if (target.scheme === 'jec' && target.authority === siteId && provider.isDirty(target.path, true)) {
          throw new Error(`Save or discard the unsaved changes in ${target.path} before ${method === 'delete' ? 'deleting' : 'replacing'} this path.`);
        }
      }
      return original(operations, ...args);
    };
    workingCopyFiles[method] = guarded;
    Object.defineProperty(workingCopyFiles, method, { value: guarded, configurable: true, writable: true });
  }
  const writeFile = files.writeFile.bind(files);
  const coordinatedWrite = async (resource, contents, options) => {
    if (resource.scheme === 'jec' && resource.authority === siteId && options?.etag === '' && provider.isDirty(resource.path)) {
      // VS Code uses ETAG_DISABLED for its explicit Overwrite conflict action
      // (or a user's disabled conflict preference). Preserve the worker's atomic
      // revision check even for that deliberately accepted replacement.
      await provider.authorizeOverwrite(resource.path);
    }
    return writeFile(resource, contents, options);
  };
  // Lazy VS Code services cache bound methods on a proxy; update that cache
  // as well as the underlying service when wrapping an operation.
  files.writeFile = coordinatedWrite;
  Object.defineProperty(files, 'writeFile', { value: coordinatedWrite, configurable: true, writable: true });
  const searchProvider = new JoomlaSearchProvider(provider);
  // Native Search shows confirmation and per-file diff previews. Serialize its
  // accepted writes with PHP requests, and reject a result that became stale.
  const replace = replacements.replace.bind(replacements);
  const coordinatedReplace = (match, ...options) => provider.withBatch(async () => {
    const matches = Array.isArray(match) ? match : [match];
    const paths = new Set(matches.map(item => item.resource || item.parent?.()?.resource)
      .filter(Boolean).map(resource => provider.path(resource)));
    for (const path of paths) {
      if (provider.isDirty(path)) throw new Error(`Save or discard the unsaved changes in ${path} before replacing search results.`);
      const expected = searchProvider.revisions.get(path) || provider.revisions.get(path);
      const current = await provider.request('stat', { path, revision: true });
      if (!expected || current?.revision !== expected) throw new Error(`${path} changed after this search. Search again and review the replacement preview.`);
    }
    const result = await replace(match, ...options);
    if (copies.workingCopies.some(copy => paths.has(copy.resource.path) && copy.isDirty())) {
      throw new Error('Some replacements could not be saved. Review the dirty files and recovery report before retrying.');
    }
    return result;
  });
  replacements.replace = coordinatedReplace;
  Object.defineProperty(replacements, 'replace', { value: coordinatedReplace, configurable: true, writable: true });
  let savingAll;
  const saveAll = () => savingAll ||= provider.withBatch(() => editors.saveAll({ includeUntitled: true }))
    .finally(() => { savingAll = null; });
  const subscriptions = [
    textFiles.files.onDidResolve(({ model }) => {
      const resource = model.resource;
      if (resource.scheme === 'jec' && resource.authority === siteId) provider.acceptReadRevision(resource.path);
    }),
    search.registerSearchResultProvider('jec', SearchProviderType.file, searchProvider),
    search.registerSearchResultProvider('jec', SearchProviderType.text, searchProvider),
    copies.onDidChangeDirty(() => onDirtyChange(copies.dirtyCount)),
    CommandsRegistry.registerCommand('saveAll', () => saveAll()),
    CommandsRegistry.registerCommand('workbench.action.files.saveAll', () => saveAll()),
  ];
  for (const id of ['workbench.action.files.saveFiles', 'workbench.files.action.saveAllInGroup']) {
    const original = CommandsRegistry.getCommand(id);
    if (original) subscriptions.push(CommandsRegistry.registerCommand(id, (accessor, ...args) =>
      provider.withBatch(() => original.handler(accessor, ...args))));
  }
  let vscode, debugService;
  if (debugExtension) {
    vscode = await debugExtension.getApi();
    debugService = await getService(IDebugService);
    const { InlineDebugAdapter } = await import('./debug-adapter.mjs');
    subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('joomengine-php', {
      createDebugAdapterDescriptor() {
        return new vscode.DebugAdapterInlineImplementation(new InlineDebugAdapter(debuggerBackend, { siteId }));
      },
    }));
    subscriptions.push(vscode.debug.registerDebugConfigurationProvider('joomengine-php', {
      provideDebugConfigurations: async () => [{ type: 'joomengine-php', request: 'launch', name: message('code.workbench.debugNext'),
        ...(await getDebugConfiguration?.()) }],
      async resolveDebugConfiguration(_folder, value) {
        const config = { type: 'joomengine-php', request: 'launch', name: message('code.workbench.debugNext'),
          ...(await getDebugConfiguration?.()), ...value };
        if (!config.url || !config.method) {
          await vscode.window.showErrorMessage(message('code.workbench.debugSelect'));
          return undefined;
        }
        return config;
      },
    }));
  }
  const phpStatus = statusbar.addEntry({ name: message('code.workbench.phpServices'), text: '$(symbol-method) PHP',
    ariaLabel: message('code.workbench.phpServices'), command: 'joomengineCode.refreshPhpIndex' }, 'joomengineCode.phpLanguage', 1, 100);
  const phpLanguages = installPhpLanguageServices({ monaco, workspace: { ...workspace,
    request: (operation, args) => provider.request(operation, args) }, siteId, phpVersion, onError,
    onStatus(status) {
      const reasonKey = Object.keys(WORKBENCH_MESSAGES).find(key => key.startsWith('code.workbench.reason.') && WORKBENCH_MESSAGES[key] === status.reason);
      phpStatus.update({ name: message('code.workbench.phpServices'), text: `$(symbol-method) ${message('code.workbench.phpStatus', { phase: message(`code.workbench.phase.${status.phase}`) })}`,
        ariaLabel: message('code.workbench.phpStatusLabel', { phase: message(`code.workbench.phase.${status.phase}`) }),
        tooltip: message('code.workbench.phpIndexed', { count: status.files, reason: reasonKey ? message(reasonKey) : (status.reason || '') }),
        command: 'joomengineCode.refreshPhpIndex' });
      onLanguageStatus(status);
    },
  });
  subscriptions.push(phpStatus, phpLanguages, registerAction2(class extends Action2 {
    constructor() { super({ id: 'joomengineCode.refreshPhpIndex', title: message('code.workbench.refreshIndex'), f1: true }); }
    run() { return phpLanguages.refresh(); }
  }));
  let lastActivePath = null, lastActiveArea;
  const rememberActivePath = event => {
    if (event?.target?.closest?.('.explorer-viewlet')) { lastActiveArea = 'explorer'; lastActivePath = explorer.getContext(false)[0]?.resource?.path || lastActivePath; }
    else if (event?.target?.closest?.('.editor-instance')) { lastActiveArea = 'editor'; lastActivePath = editors.activeEditor?.resource?.path || lastActivePath; }
  };
  container.addEventListener('focusin', rememberActivePath);
  container.addEventListener('pointerup', rememberActivePath);
  container.addEventListener('keyup', rememberActivePath);
  subscriptions.push({ dispose() { container.removeEventListener('focusin', rememberActivePath); container.removeEventListener('pointerup', rememberActivePath); container.removeEventListener('keyup', rememberActivePath); } });
  const observer = new ResizeObserver(() => layout.layout());
  observer.observe(container);
  let detached = null, detachedPart = null;
  function relativeLayout(value) {
    const normalize = entries => {
      const total = entries.reduce((sum, entry) => sum + (entry.size || 1), 0);
      return entries.map(entry => ({ size: (entry.size || 1) / total,
        ...(entry.groups ? { groups: normalize(entry.groups) } : {}) }));
    };
    return { orientation: value.orientation, groups: normalize(value.groups) };
  }
  function relocateGroups(source, target) {
    const sourceGroups = source.getGroups(2); // Native grid appearance order.
    const activeIndex = sourceGroups.indexOf(source.activeGroup);
    target.applyLayout(relativeLayout(source.getLayout()));
    const targetGroups = target.getGroups(2);
    for (let index = 0; index < sourceGroups.length; index++) {
      groups.mergeGroup(sourceGroups[index], targetGroups[index]);
    }
    target.activateGroup(targetGroups[Math.max(0, activeIndex)]);
  }
  let recovery;
  const appliedRenames = new Map();
  const api = {
    provider,
    async reconcileApplied(result) {
      let renames = (result.results || []).filter(entry => entry.operation === 'rename');
      if (renames.length && result.recoveryId) {
        appliedRenames.set(result.recoveryId, renames);
        while (appliedRenames.size > 8) appliedRenames.delete(appliedRenames.keys().next().value);
      } else if (result.ok && result.results?.some(entry => entry.operation === 'recover')) {
        renames = (appliedRenames.get(result.recoveryId) || []).map(entry => ({ path: entry.target, target: entry.path })).reverse();
        appliedRenames.delete(result.recoveryId);
      }
      for (const entry of renames) {
        provider.uri(entry.path); provider.uri(entry.target);
        if (vscode) {
          const moved = vscode.debug.breakpoints.filter(point => point.location?.uri.scheme === 'jec'
            && point.location.uri.authority === siteId && (point.location.uri.path === entry.path || point.location.uri.path.startsWith(`${entry.path}/`)));
          if (moved.length) {
            vscode.debug.removeBreakpoints(moved);
            vscode.debug.addBreakpoints(moved.map(point => new vscode.SourceBreakpoint(new vscode.Location(
              provider.uri(`${entry.target}${point.location.uri.path.slice(entry.path.length)}`), point.location.range),
              point.enabled, point.condition, point.hitCondition, point.logMessage)));
          }
        }
        for (const group of groups.groups) {
          const replacements = [];
          for (const editor of group.editors) {
            const resource = editor.resource;
            if (resource?.scheme !== 'jec' || resource.authority !== siteId
              || (resource.path !== entry.path && !resource.path.startsWith(`${entry.path}/`))) continue;
            if (editor.isDirty()) { onError(new Error(`The saved file moved to ${entry.target}, but ${resource.path} has a new unsaved draft. Save it under the intended name before closing.`)); continue; }
            const target = `${entry.target}${resource.path.slice(entry.path.length)}`;
            replacements.push({ editor, replacement: { resource: provider.uri(target), options: {
              index: group.getIndexOfEditor(editor), pinned: group.isPinned(editor), sticky: group.isSticky(editor),
              preserveFocus: true, inactive: editor !== group.activeEditor,
              viewState: editor === group.activeEditor ? group.activeEditorPane?.getViewState?.() : undefined,
            } } });
          }
          if (replacements.length) await editors.replaceEditors(replacements, group);
        }
      }
    },
    layout: () => layout.layout(),
    getEditorLayout: () => relativeLayout((detachedPart || groups.mainPart).getLayout()),
    getEditorGroups: () => (detachedPart || groups.mainPart).getGroups(2).map(group => ({
      paths: group.editors.filter(editor => editor.resource?.scheme === 'jec').map(editor => editor.resource.path),
      activePath: group.activeEditor?.resource?.path,
    })),
    openFile: (path, lineNumber, column = 1) => editors.openEditor({ resource: provider.uri(path),
      options: { pinned: true, ...(lineNumber ? { selection: { startLineNumber: lineNumber, startColumn: column } } : {}) } }, detachedPart?.activeGroup),
    async openWithEncoding(path, encoding) {
      if (!Object.hasOwn(SUPPORTED_ENCODINGS, encoding)) throw new Error('Select one of the supported file encodings.');
      if (provider.isDirty(path)) throw new Error(`Save or discard ${path} before reopening it with another encoding.`);
      return editors.openEditor({ resource: provider.uri(path), encoding, options: { pinned: true, forceReload: true } }, detachedPart?.activeGroup);
    },
    saveAll,
    hasDirty: () => copies.hasDirty,
    getDirtyCount: () => copies.dirtyCount,
    isDirty: (path, recursive = false) => provider.isDirty(path, recursive),
    getActivePath() {
      const selected = explorer.getContext(false)[0]?.resource;
      if (!document.hasFocus() && lastActiveArea === 'explorer') return selected?.path || lastActivePath;
      if (!document.hasFocus() && lastActivePath) return lastActivePath;
      const resource = explorer.hasViewFocus() ? selected : editors.activeEditor?.resource || selected;
      return resource?.scheme === 'jec' && resource.authority === siteId ? resource.path : null;
    },
    getOpenFiles() {
      const seen = new Set();
      return editors.editors.filter(editor => editor.resource?.scheme === 'jec'
        && editor.resource.authority === siteId && !seen.has(editor.resource.path) && seen.add(editor.resource.path))
        .map(editor => ({ path: editor.resource.path, canonicalPath: provider.canonicalPaths.get(editor.resource.path), dirty: editor.isDirty(),
          text: models.getModel(editor.resource)?.getValue() }));
    },
    getSelection() {
      const control = editors.activeTextEditorControl;
      const model = control?.getModel?.();
      const selection = control?.getSelection?.();
      if (!model?.uri || !selection || model.uri.scheme !== 'jec' || model.uri.authority !== siteId) return null;
      return { path: model.uri.path, canonicalPath: provider.canonicalPaths.get(model.uri.path), text: model.getValueInRange(selection), selection: {
        startLineNumber: selection.startLineNumber, startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber, endColumn: selection.endColumn,
      } };
    },
    getDiagnostics(path) { return markers.read(path ? { resource: provider.uri(path) } : {})
      .filter(marker => marker.resource.scheme === 'jec' && marker.resource.authority === siteId).slice(0, 200)
      .map(marker => ({ path: marker.resource.path, message: marker.message, severity: marker.severity,
        startLineNumber: marker.startLineNumber, startColumn: marker.startColumn, endLineNumber: marker.endLineNumber, endColumn: marker.endColumn })); },
    getContext() { return { selection: api.getSelection(), openFiles: api.getOpenFiles().map(file => ({
      path: file.path, canonicalPath: file.canonicalPath, content: file.text, unsaved: file.dirty,
    })) }; },
    discardAll: () => editors.revertAll(),
    command: (id, ...args) => commands.executeCommand(id, ...args),
    getDebugState: () => ['inactive', 'initializing', 'stopped', 'running'][debugService?.state || 0],
    subscribeDebugState(listener) {
      listener(api.getDebugState());
      return debugService?.onDidChangeState(() => listener(api.getDebugState()));
    },
    async startDebugging(configuration) {
      if (!vscode) throw new Error(message('code.workbench.debugUnavailable'));
      return vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
        type: 'joomengine-php', request: 'launch', name: message('code.workbench.debugRequest'), ...configuration,
      });
    },
    async stopDebugging() { await vscode?.debug.stopDebugging(); },
    getBreakpoints() {
      return (vscode?.debug.breakpoints || []).filter(point => point.location?.uri.scheme === 'jec'
        && point.location.uri.authority === siteId).map(point => ({ path: point.location.uri.path,
          line: point.location.range.start.line, column: point.location.range.start.character,
          enabled: point.enabled, condition: point.condition, hitCondition: point.hitCondition, logMessage: point.logMessage }));
    },
    restoreBreakpoints(points) {
      if (!vscode) return;
      vscode.debug.addBreakpoints(points.map(point => new vscode.SourceBreakpoint(
        new vscode.Location(provider.uri(point.path), new vscode.Position(point.line, point.column || 0)),
        point.enabled !== false, point.condition, point.hitCondition, point.logMessage)));
    },
    onBreakpointsChanged(listener) { return vscode?.debug.onDidChangeBreakpoints(listener); },
    async flushDrafts() { await recovery?.flush?.(); },
    async detach({ onClose = () => {} } = {}) {
      if (detached) { detached.focus(); return detached; }
      const part = await groups.createAuxiliaryEditorPart();
      detachedPart = part;
      relocateGroups(groups.mainPart, part);
      // VS Code normally closes clean tabs when an auxiliary window closes. This
      // view is a relocation of the same session, so return every tab beforehand.
      const closePart = part.close.bind(part);
      part.close = () => {
        relocateGroups(part, groups.mainPart);
        return closePart();
      };
      const window = part.getContainer().ownerDocument.defaultView;
      let companion;
      let resolveClosed;
      const closed = new Promise(resolve => { resolveClosed = resolve; });
      const closeSubscription = part.onWillClose(() => {
        companion?.dispose(); detachedPart = null; detached = null; closeSubscription.dispose(); resolveClosed(); onClose();
      });
      const redock = async () => {
        part.close();
      };
      detached = { closed, focus: () => window.focus(), close: () => window.close(), redock };
      companion = mountDetachedTools({ part, provider, openFile: api.openFile, saveAll, redock, onError, onDetachedTools, t });
      return detached;
    },
    async redock() { await detached?.redock(); },
    async dispose() {
      const failures = [];
      try { await detached?.redock(); } catch (error) { failures.push(error); try { detached?.close(); } catch (cause) { failures.push(cause); } }
      try { await recovery?.dispose(); } catch (error) { failures.push(error); }
      observer.disconnect();
      for (const subscription of subscriptions) { try { subscription.dispose(); } catch (error) { failures.push(error); } }
      try { await debugExtension?.dispose(); } catch (error) { failures.push(error); }
      try { provider.dispose(); } catch (error) { failures.push(error); }
      // The host removes the dedicated iframe only after handling dirty documents.
      // VS Code services have a realm lifetime and cannot be reinitialized in place.
      if (failures.length) throw new AggregateError(failures, 'Some JoomEngine Code views could not close cleanly; all remaining cleanup was attempted.');
    },
  };
  const changeEncoding = CommandsRegistry.getCommand('workbench.action.editor.changeEncoding');
  if (changeEncoding) subscriptions.push(CommandsRegistry.registerCommand('workbench.action.editor.changeEncoding', async (accessor, ...args) => {
    const resource = editors.activeEditor?.resource;
    if (editors.activeTextEditorControl || resource?.scheme !== 'jec' || resource.authority !== siteId) return changeEncoding.handler(accessor, ...args);
    const selected = await quickInput.pick(Object.entries(SUPPORTED_ENCODINGS).map(([encoding, value]) => ({ encoding, label: value.labelLong, description: encoding })), { title: resource.path });
    if (selected) return api.openWithEncoding(resource.path, selected.encoding);
  }));
  try {
    recovery = await attachEditorRecovery({ storageId, workspace, provider, models, editors, api, onError });
    subscriptions.push(registerAction2(class extends Action2 {
      constructor() { super({ id: 'joomengineCode.recoverMissingDrafts', title: message('code.workbench.recoverDrafts'), f1: true }); }
      run() { return recovery.recoverMissing?.(); }
    }));
  } catch (error) { onError(new Error(message('code.workbench.recoveryUnavailable', { error: error.message }))); }
  onDirtyChange(copies.dirtyCount);
  await commands.executeCommand('workbench.view.explorer');
  return api;
}
