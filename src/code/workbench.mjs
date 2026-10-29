import { initialize, getService, IEditorService, IEditorGroupsService, IWorkbenchLayoutService,
  IWorkingCopyService, IFileService, ILogService, IWorkspaceContextService, IConfigurationService,
  ICommandService, IModelService, SyncDescriptor } from '@codingame/monaco-vscode-api';
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override';
import getFilesServiceOverride, { registerCustomProvider } from '@codingame/monaco-vscode-files-service-override';
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override';
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override';
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
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { JoomlaFileSystemProvider } from './file-provider.mjs';
import { JoomlaSearchProvider } from './search-provider.mjs';
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

let initialized = false;

/** One workbench per iframe realm. Hiding/layout changes must preserve that realm. */
export async function mountWorkbench({ container, workspace, siteId, onSave = () => {},
  onError = () => {}, onDirtyChange = () => {}, debuggerBackend, getDebugConfiguration, storageId }) {
  if (initialized) throw new Error('JoomEngine Code is already initialized in this view. Reuse its session.');
  initialized = true;
  const provider = new JoomlaFileSystemProvider(workspace, siteId, { onSave, onError });
  registerCustomProvider('jec', provider);
  const workerFiles = {
    editorWorkerService: './editor-worker.js', TextMateWorker: './textmate-worker.js', LocalFileSearchWorker: './search-worker.js',
  };
  globalThis.MonacoEnvironment = {
    getWorker(_id, label) {
      const filename = workerFiles[label];
      if (!filename) throw new Error(`JoomEngine Code has no bundled worker for ${label}.`);
      return new Worker(new URL(filename, import.meta.url), { type: 'module', name: `JoomEngine Code ${label}` });
    },
  };
  let debugServices = {}, debugExtension;
  if (debuggerBackend) {
    await import('vscode/localExtensionHost');
    const [{ default: getDebugServiceOverride }, { registerExtension, ExtensionHostKind }] = await Promise.all([
      import('@codingame/monaco-vscode-debug-service-override'), import('@codingame/monaco-vscode-api/extensions'),
    ]);
    debugServices = getDebugServiceOverride();
    debugExtension = registerExtension({ name: 'php-debugger', publisher: 'joomengine', version: '0.1.0',
      engines: { vscode: '*' }, displayName: 'JoomEngine Code PHP Debugger',
      contributes: { debuggers: [{ type: 'joomengine-php', label: 'JoomEngine Code PHP', languages: ['php'],
        configurationAttributes: { launch: { required: ['url', 'method'], properties: {
          url: { type: 'string', description: 'Exact Joomla request URL to debug once.' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
          refresh: { type: 'boolean', default: false, description: 'Refresh the current preview after arming the matching GET request.' },
        } } } }] },
    }, ExtensionHostKind.LocalProcess);
  }
  await initialize({
    ...getFilesServiceOverride(), ...getConfigurationServiceOverride(), ...getModelServiceOverride(),
    ...getWorkbenchServiceOverride(), ...getThemeServiceOverride(), ...getTextmateServiceOverride(),
    ...getLanguagesServiceOverride(), ...getSearchServiceOverride(), ...getExplorerServiceOverride(),
    ...getWorkingCopyServiceOverride({ storage: 'memory' }), ...getPreferencesServiceOverride(),
    ...getNotificationsServiceOverride(), ...getDialogsServiceOverride(), ...getAccessibilityServiceOverride(),
    ...debugServices,
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
      'editor.minimap.enabled': false, 'workbench.editor.enablePreview': false,
      'security.workspace.trust.enabled': false,
    },
  }, { userHome: URI.from({ scheme: 'jec', authority: siteId, path: '/' }) });
  const [editors, groups, layout, copies, commands, search, files, log, context, configuration, models] = await Promise.all([
    IEditorService, IEditorGroupsService, IWorkbenchLayoutService, IWorkingCopyService, ICommandService,
    ISearchService, IFileService, ILogService, IWorkspaceContextService, IConfigurationService, IModelService,
  ].map(service => getService(service)));
  const searchProvider = new JoomlaSearchProvider(provider);
  let savingAll;
  const saveAll = () => savingAll ||= provider.withBatch(() => editors.saveAll({ includeUntitled: true }))
    .finally(() => { savingAll = null; });
  const subscriptions = [
    search.registerSearchResultProvider('jec', SearchProviderType.file, searchProvider),
    search.registerSearchResultProvider('jec', SearchProviderType.text, searchProvider),
    copies.onDidChangeDirty(() => onDirtyChange(copies.dirtyCount)),
    CommandsRegistry.registerCommand('saveAll', () => saveAll()),
    CommandsRegistry.registerCommand('workbench.action.files.saveAll', () => saveAll()),
  ];
  let vscode;
  if (debugExtension) {
    vscode = await debugExtension.getApi();
    const { InlineDebugAdapter } = await import('./debug-adapter.mjs');
    subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('joomengine-php', {
      createDebugAdapterDescriptor() {
        return new vscode.DebugAdapterInlineImplementation(new InlineDebugAdapter(debuggerBackend, { siteId }));
      },
    }));
    subscriptions.push(vscode.debug.registerDebugConfigurationProvider('joomengine-php', {
      provideDebugConfigurations: async () => [{ type: 'joomengine-php', request: 'launch', name: 'Debug next Joomla request',
        ...(await getDebugConfiguration?.()) }],
      async resolveDebugConfiguration(_folder, value) {
        const config = { type: 'joomengine-php', request: 'launch', name: 'Debug next Joomla request',
          ...(await getDebugConfiguration?.()), ...value };
        if (!config.url || !config.method) {
          await vscode.window.showErrorMessage('Select the exact Joomla request URL and method before starting PHP debugging.');
          return undefined;
        }
        return config;
      },
    }));
  }
  const observer = new ResizeObserver(() => layout.layout());
  observer.observe(container);
  let detached = null;
  let recovery;
  const api = {
    provider,
    layout: () => layout.layout(),
    openFile: path => editors.openEditor({ resource: provider.uri(path), options: { pinned: true } }),
    saveAll,
    hasDirty: () => copies.hasDirty,
    getDirtyCount: () => copies.dirtyCount,
    isDirty(path, recursive = false) {
      return copies.workingCopies.some(copy => copy.isDirty() && copy.resource.scheme === 'jec'
        && copy.resource.authority === siteId && (copy.resource.path === path
          || (recursive && copy.resource.path.startsWith(path === '/' ? '/' : `${path}/`))));
    },
    getOpenFiles() {
      const seen = new Set();
      return editors.editors.filter(editor => editor.resource?.scheme === 'jec'
        && editor.resource.authority === siteId && !seen.has(editor.resource.path) && seen.add(editor.resource.path))
        .map(editor => ({ path: editor.resource.path, dirty: editor.isDirty(),
          text: models.getModel(editor.resource)?.getValue() }));
    },
    getSelection() {
      const control = editors.activeTextEditorControl;
      const model = control?.getModel?.();
      const selection = control?.getSelection?.();
      if (!model?.uri || !selection || model.uri.scheme !== 'jec' || model.uri.authority !== siteId) return null;
      return { path: model.uri.path, text: model.getValueInRange(selection), selection: {
        startLineNumber: selection.startLineNumber, startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber, endColumn: selection.endColumn,
      } };
    },
    getContext() { return { selection: api.getSelection(), openFiles: api.getOpenFiles() }; },
    discardAll: () => editors.revertAll(),
    command: (id, ...args) => commands.executeCommand(id, ...args),
    async startDebugging(configuration) {
      if (!vscode) throw new Error('The PHP debugger runtime is not available for this site.');
      return vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
        type: 'joomengine-php', request: 'launch', name: 'Debug Joomla request', ...configuration,
      });
    },
    async stopDebugging() { await vscode?.debug.stopDebugging(); },
    async flushDrafts() { await recovery?.flush?.(); },
    async detach({ onClose = () => {} } = {}) {
      if (detached) { detached.focus(); return detached; }
      const part = await groups.createAuxiliaryEditorPart();
      for (const group of [...groups.mainPart.groups]) groups.mergeGroup(group, part.activeGroup);
      // VS Code normally closes clean tabs when an auxiliary window closes. This
      // view is a relocation of the same session, so return every tab beforehand.
      const closePart = part.close.bind(part);
      part.close = () => {
        for (const group of [...part.groups]) groups.mergeGroup(group, groups.mainPart.activeGroup);
        return closePart();
      };
      const window = part.getContainer().ownerDocument.defaultView;
      let resolveClosed;
      const closed = new Promise(resolve => { resolveClosed = resolve; });
      const closeSubscription = part.onWillClose(() => {
        detached = null; closeSubscription.dispose(); resolveClosed(); onClose();
      });
      const redock = async () => {
        part.close();
      };
      detached = { closed, focus: () => window.focus(), redock };
      return detached;
    },
    async redock() { await detached?.redock(); },
    async dispose() {
      await detached?.redock();
      await recovery?.dispose();
      observer.disconnect();
      subscriptions.forEach(subscription => subscription.dispose());
      await debugExtension?.dispose();
      provider.dispose();
      // The host removes the dedicated iframe only after handling dirty documents.
      // VS Code services have a realm lifetime and cannot be reinitialized in place.
    },
  };
  try {
    recovery = await attachEditorRecovery({ storageId, workspace, provider, models, editors, api, onError });
    subscriptions.push(registerAction2(class extends Action2 {
      constructor() { super({ id: 'joomengineCode.recoverMissingDrafts', title: 'JoomEngine Code: Recover missing drafts', f1: true }); }
      run() { return recovery.recoverMissing?.(); }
    }));
  } catch (error) { onError(new Error(`Draft recovery is unavailable: ${error.message}`)); }
  onDirtyChange(copies.dirtyCount);
  await commands.executeCommand('workbench.view.explorer');
  return api;
}
