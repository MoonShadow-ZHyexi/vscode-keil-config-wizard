const vscode = require('vscode');
const { createDocumentReader } = require('./configuration');
const { createWizardPanels } = require('./wizard-panel');
const { createEditorAssociations } = require('./editor-associations');

const editorType = 'keilWizard.editor';
const webviewType = 'keilWizard';
const rememberedFilesKey = 'keilWizard.rememberedWizardFiles';
const nativeReopenWait = 100;
const toolbarEditDelay = 120;
let finishDeactivation;

function textTabKey(tab) {
  return tab?.input instanceof vscode.TabInputText ? tab.input.uri.toString() : undefined;
}

function wizardTabKey(tab) {
  const input = tab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType === editorType ? input.uri.toString() : undefined;
}

function usesNativeEditor(uri) {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}

function activate(context) {
  const openingWizards = new Map();
  const reopenCommand = 'reopenActiveEditorWith';
  const supportsReopen = vscode.commands.getCommands().then(commands => commands.includes(reopenCommand));
  const editorAssociations = createEditorAssociations(context.workspaceState, editorType);
  const rememberedFiles = new Map((context.workspaceState.get(rememberedFilesKey) ?? []).map(key => [key, vscode.Uri.parse(key)]));
  const newTextTabs = new WeakSet();
  const pendingNativeSwitches = new Map();
  const previewTabs = new Map();
  const documents = createDocumentReader();
  let pendingModeWrite = Promise.resolve();
  let previewRestoreTimer;
  let toolbarEditTimer;
  let wizardTarget;
  let switchingEditor = false;
  let convertibleResource;
  let legacyWizardActive = false;
  let previewActive = false;
  const panelOptions = { enableScripts: true, localResourceRoots: [] };

  function syncEditorAssociations() {
    return editorAssociations.sync([...rememberedFiles.values()]);
  }

  function rememberMode(uri, wizard) {
    const key = uri.toString();
    if (wizard === rememberedFiles.has(key)) return pendingModeWrite;
    if (wizard) rememberedFiles.set(key, uri);
    else rememberedFiles.delete(key);
    const saved = context.workspaceState.update(rememberedFilesKey, [...rememberedFiles.keys()]).then(undefined, error => {
      console.warn('Keil Wizard: unable to save editor mode', error);
    });
    pendingModeWrite = Promise.all([saved, syncEditorAssociations()]);
    return pendingModeWrite;
  }

  const { panels, initializePanel, flushViewStates } = createWizardPanels(context.workspaceState, {
    readDocument: documents.read,
    switchMode,
    onViewChange() {
      updateEditorActions();
      schedulePreviewRestore();
    }
  });

  finishDeactivation = () => {
    clearTimeout(previewRestoreTimer);
    clearTimeout(toolbarEditTimer);
    for (const timer of pendingNativeSwitches.values()) clearTimeout(timer);
    pendingNativeSwitches.clear();
    return Promise.all([flushViewStates(), pendingModeWrite, syncEditorAssociations()]);
  };

  function eligible(document) {
    if (!document || document.uri.scheme === 'untitled') return false;
    return documents.isEligible(document);
  }

  function updateEditorActions() {
    clearTimeout(toolbarEditTimer);
    toolbarEditTimer = undefined;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri.toString();
    const nextResource = uri && textTabKey(tab) === uri && eligible(editor.document) ? uri : undefined;
    if (nextResource !== convertibleResource) {
      convertibleResource = nextResource;
      void vscode.commands.executeCommand('setContext', 'keilWizard.convertibleResources', nextResource ? [nextResource] : []);
    }
    const nextLegacyWizard = tab?.input instanceof vscode.TabInputWebview && tab.input.viewType === webviewType;
    if (nextLegacyWizard !== legacyWizardActive) {
      legacyWizardActive = nextLegacyWizard;
      void vscode.commands.executeCommand('setContext', 'keilWizard.legacyWizardActive', nextLegacyWizard);
    }
    const nextPreview = Boolean(activePreview(tab));
    if (nextPreview !== previewActive) {
      previewActive = nextPreview;
      void vscode.commands.executeCommand('setContext', 'keilWizard.previewActive', previewActive);
    }
  }

  function activeEditorChanged(editor) {
    const key = editor?.document.uri.toString();
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (key && textTabKey(tab) === key) handleOpenWizardTab(tab);
    updateEditorActions();
  }

  function revealWizard(key, document) {
    const existing = panels.get(key);
    if (!existing) return false;
    if (document) {
      existing.document = document;
      existing.refreshIfChanged(document);
    }
    if (!existing.panel.active) existing.panel.reveal();
    return true;
  }

  function handleOpenWizardTab(tab) {
    if (!newTextTabs.has(tab)) return;
    if (switchingEditor) {
      newTextTabs.delete(tab);
      return;
    }
    const key = textTabKey(tab);
    const existing = panels.get(key);
    if (!existing) {
      const uri = rememberedFiles.get(key);
      const editor = vscode.window.activeTextEditor;
      const restoreMode = uri && (!usesNativeEditor(uri) || !vscode.workspace.getWorkspaceFolder(uri));
      if (restoreMode && editor?.document.uri.toString() !== key) return;
      newTextTabs.delete(tab);
      if (restoreMode && !editor.document.isDirty && eligible(editor.document)) {
        void switchToWizard(editor, { animateEntry: false });
      }
      return;
    }
    newTextTabs.delete(tab);
    const preview = previewTabs.get(key);
    if (preview ? preview.text === tab : existing.previewOrigin() && tab.group.viewColumn < existing.panel.viewColumn) return;
    const tabs = tab.group.tabs;
    const nextTab = tabs[tabs.indexOf(tab) + 1];
    if (wizardTabKey(nextTab) === key) {
      // VS Code opens the replacement in the old slot before it closes the custom editor.
      const timer = setTimeout(() => {
        pendingNativeSwitches.delete(tab);
        if (vscode.window.tabGroups.activeTabGroup.activeTab === tab && tab.group.tabs.includes(nextTab) &&
            !switchingEditor && panels.get(key) === existing) {
          reuseOpenWizard(tab, existing);
        }
      }, nativeReopenWait);
      pendingNativeSwitches.set(tab, timer);
      return;
    }
    reuseOpenWizard(tab, existing);
  }

  function reuseOpenWizard(tab, existing) {
    if (!tab.isDirty) {
      existing.panel.reveal();
      void vscode.window.tabGroups.close(tab, true).then(undefined, error => {
        console.warn('Keil Wizard: unable to close the extra text tab', error);
      });
    }
  }

  function cancelNativeSwitch(tab) {
    clearTimeout(pendingNativeSwitches.get(tab));
    pendingNativeSwitches.delete(tab);
  }

  function handleClosedTab(tab, opened) {
    cancelNativeSwitch(tab);
    const key = wizardTabKey(tab);
    if (!key) return;
    const activeTab = tab.group.activeTab;
    const replacement = opened.find(candidate => candidate.group === tab.group && textTabKey(candidate) === key);
    if (!switchingEditor && (replacement || (textTabKey(activeTab) === key && pendingNativeSwitches.has(activeTab)))) {
      // A native editor switch replaces the wizard with text. An ordinary close has no replacement.
      void rememberMode(tab.input.uri, false);
    }
    if (replacement) newTextTabs.delete(replacement);
    if (textTabKey(activeTab) === key) {
      cancelNativeSwitch(activeTab);
      newTextTabs.delete(activeTab);
    }
  }

  function wizardTab(wizard) {
    const group = vscode.window.tabGroups.all.find(group => group.viewColumn === wizard.panel.viewColumn);
    return group?.tabs.find(tab => wizardTabKey(tab) === wizard.sourceUri.toString() ||
      (wizard.panel.active && tab === group.activeTab && tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType === webviewType));
  }

  function activePreview(tab) {
    for (const preview of previewTabs.values()) {
      if (preview.text === tab || preview.wizard === tab) return preview;
    }
  }

  async function closeEmptyGroup(group) {
    if (vscode.window.tabGroups.all.includes(group) && !group.tabs.length) {
      await vscode.window.tabGroups.close(group, true);
    }
  }

  async function openNativePreview(origin, original, document, savedOrigin = origin) {
    if (switchingEditor || !original || vscode.window.tabGroups.activeTabGroup.activeTab !== original) return;
    const uri = document.uri;
    const key = uri.toString();
    const originalGroup = original.group;
    let addedGroup;
    switchingEditor = true;
    try {
      const groups = new Set(vscode.window.tabGroups.all);
      await vscode.commands.executeCommand(origin === 'text' ? 'workbench.action.newGroupRight' : 'workbench.action.newGroupLeft');
      const target = vscode.window.tabGroups.activeTabGroup;
      if (groups.has(target) || target.tabs.length) throw Error('无法创建预览分栏。');
      addedGroup = target;
      if (origin === 'text') await createWizardPanel(document, target.viewColumn);
      else await vscode.window.showTextDocument(document, { viewColumn: target.viewColumn, preview: false });
      const wizard = panels.get(key);
      const textGroup = origin === 'text' ? originalGroup : target;
      const wizardGroup = origin === 'text' ? target : originalGroup;
      const text = textGroup.tabs.find(tab => textTabKey(tab) === key);
      const form = origin === 'wizard' ? original : wizard && wizardTab(wizard);
      if (!text || !form || form.group !== wizardGroup) throw Error('无法并排打开文本与配置向导。');
      previewTabs.set(key, { text, wizard: form, view: wizard, origin: savedOrigin, uri });
      wizard.setPreview(true, savedOrigin);
      await rememberMode(uri, true);
    } catch (error) {
      if (addedGroup) await closeEmptyGroup(addedGroup);
      vscode.window.showErrorMessage('无法打开源文本预览：' + error.message);
    } finally {
      switchingEditor = false;
      updateEditorActions();
    }
  }

  function schedulePreviewRestore() {
    if (switchingEditor || previewRestoreTimer) return;
    const wizard = [...panels.values()].find(wizard =>
      wizard.panel.active && wizard.previewOrigin() && !previewTabs.has(wizard.sourceUri.toString()));
    if (!wizard) return;
    // The text tab may still be arriving from VS Code's restored editor layout.
    previewRestoreTimer = setTimeout(() => {
      previewRestoreTimer = undefined;
      const key = wizard.sourceUri.toString();
      const origin = wizard.previewOrigin();
      if (switchingEditor || !origin || !wizard.panel.active || previewTabs.has(key) || panels.get(key) !== wizard) return;
      const form = wizardTab(wizard);
      if (!form) return;
      const text = vscode.window.tabGroups.all
        .filter(group => group.viewColumn < form.group.viewColumn)
        .sort((left, right) => right.viewColumn - left.viewColumn)
        .flatMap(group => group.tabs).find(tab => textTabKey(tab) === key);
      if (text) {
        previewTabs.set(key, { text, wizard: form, view: wizard, origin, uri: wizard.sourceUri });
        updateEditorActions();
      } else {
        void openNativePreview('wizard', form, wizard.document, origin);
      }
    }, nativeReopenWait);
  }

  async function closeNativePreview(preview, wizard, destination) {
    if (switchingEditor) return;
    const { uri, origin, text, wizard: form } = preview;
    const original = origin === 'text' ? text : form;
    const extra = origin === 'text' ? form : text;
    const extraGroup = extra.group;
    let editor;
    switchingEditor = true;
    try {
      if (!await vscode.window.tabGroups.close(extra, true)) return;
      previewTabs.delete(uri.toString());
      wizard.setPreview(false);
      await closeEmptyGroup(extraGroup);
      if (origin === 'text') {
        editor = await vscode.window.showTextDocument(wizard.document, { viewColumn: original.group.viewColumn, preview: original.isPreview });
      } else {
        wizard.panel.reveal(original.group.viewColumn);
      }
      await rememberMode(uri, origin === 'wizard');
    } catch (error) {
      vscode.window.showErrorMessage('无法关闭源文本预览：' + error.message);
      return;
    } finally {
      switchingEditor = false;
      updateEditorActions();
    }
    if (destination === 'wizard' && editor) await switchToWizard(editor, { preview: false });
    if (destination === 'text' && origin === 'wizard') {
      await switchToSource(wizard.panel, uri, () => wizard.setPreview(false));
    }
  }

  function switchMode(panel, uri, destination) {
    const wizard = panels.get(uri.toString());
    if (wizard?.panel !== panel) return;
    const preview = previewTabs.get(uri.toString());
    if (preview) return closeNativePreview(preview, wizard, destination);
    if (destination === 'text') return switchToSource(panel, uri, () => wizard.setPreview(false));
    wizard.setPreview(false);
  }

  function handleClosedPreviewTabs(closed) {
    if (switchingEditor) return;
    for (const [key, preview] of previewTabs) {
      const closedText = closed.includes(preview.text);
      const closedWizard = closed.includes(preview.wizard);
      if (!closedText && !closedWizard) continue;
      previewTabs.delete(key);
      if (closedText && closedWizard) continue;
      preview.view.setPreview(false);
      void rememberMode(preview.uri, !closedWizard);
    }
  }

  async function createWizardPanel(document, column, options) {
    const uri = document.uri;
    if (usesNativeEditor(uri)) {
      const key = uri.toString();
      await vscode.commands.executeCommand('vscode.openWith', uri, editorType, { viewColumn: column, preview: false });
      const opened = panels.get(key);
      if (!opened) throw Error('VS Code 未能打开配置向导编辑器。');
      return opened.panel;
    }
    const panel = vscode.window.createWebviewPanel(webviewType, uri.path.split('/').pop(), column, panelOptions);
    initializePanel(panel, document, options);
    return panel;
  }

  async function openWizard(uri, column, document) {
    const key = uri.toString();
    const alreadyOpen = revealWizard(key, document);
    if (alreadyOpen && !panels.get(key)?.document.isClosed) return;
    const pending = openingWizards.get(key);
    if (pending) return pending;
    const opening = (async () => {
      try {
        const source = document ?? await vscode.workspace.openTextDocument(uri);
        const sourceUri = source.uri;
        if (revealWizard(sourceUri.toString(), source) || alreadyOpen) return;
        await createWizardPanel(source, column);
        if (eligible(source)) await rememberMode(sourceUri, true);
      } catch (error) {
        vscode.window.showErrorMessage('无法打开配置向导：' + error.message);
      }
    })();
    openingWizards.set(key, opening);
    try {
      await opening;
    } finally {
      openingWizards.delete(key);
    }
  }

  async function restoreTabPosition(group, index, isActive) {
    const current = vscode.window.tabGroups.activeTabGroup;
    if (current.viewColumn !== group.viewColumn || !isActive() || index < 0) return;
    if (current.tabs.indexOf(current.activeTab) !== index) {
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
    }
  }

  async function switchToSource(panel, uri, leavePreview) {
    if (switchingEditor || !panel.active) return;
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group.activeTab;
    const custom = wizardTabKey(tab) !== undefined;
    if (!custom && !(tab?.input instanceof vscode.TabInputWebview)) return;
    const index = group.tabs.indexOf(tab);
    switchingEditor = true;
    try {
      if (custom && await supportsReopen) {
        if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return;
        // Reopen the active custom editor to clear any tab multi-selection first.
        await vscode.commands.executeCommand('vscode.openWith', uri, editorType, { viewColumn: group.viewColumn, preview: tab.isPreview });
        if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return;
        await vscode.commands.executeCommand(reopenCommand, 'default');
        if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
          leavePreview();
          await rememberMode(uri, false);
          return;
        }
        if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return;
      }
      const editor = await vscode.window.showTextDocument(uri, { viewColumn: group.viewColumn, preview: false });
      if (editor.viewColumn !== group.viewColumn) return;
      if (await vscode.window.tabGroups.close(tab, true)) {
        leavePreview();
        await rememberMode(uri, false);
        await restoreTabPosition(group, index, () => vscode.window.activeTextEditor === editor);
      }
    } catch (error) {
      vscode.window.showErrorMessage('无法切换到文本编辑器：' + error.message);
    } finally {
      switchingEditor = false;
      updateEditorActions();
    }
  }

  async function switchToWizard(editor, { animateEntry = true, preview } = {}) {
    const uri = editor.document.uri;
    const key = uri.toString();
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group.activeTab;
    if (textTabKey(tab) !== key) return;
    const index = group.tabs.indexOf(tab);
    switchingEditor = true;
    try {
      const reopen = await supportsReopen;
      const sourceIsActive = () => vscode.window.activeTextEditor === editor &&
        vscode.window.tabGroups.activeTabGroup.activeTab === tab;
      if (!sourceIsActive()) return;
      const existing = panels.get(key);
      wizardTarget = { key, animateEntry, preview };
      if (reopen && !existing && !editor.document.isDirty && usesNativeEditor(uri)) {
        // Reopen With acts on the selected tabs, so focus only the current file first.
        await vscode.window.showTextDocument(editor.document, { viewColumn: group.viewColumn, preview: tab.isPreview });
        if (!sourceIsActive()) return;
        await vscode.commands.executeCommand(reopenCommand, editorType);
        if (wizardTabKey(vscode.window.tabGroups.activeTabGroup.activeTab) === key) {
          await rememberMode(uri, true);
          return;
        }
        if (!sourceIsActive()) return;
      }
      const previousColumn = existing?.panel.viewColumn;
      const panel = existing ? existing.panel : await createWizardPanel(editor.document, group.viewColumn, wizardTarget);
      if (existing) {
        existing.refreshIfChanged(editor.document);
        panel.reveal(group.viewColumn);
      }
      if (!await vscode.window.tabGroups.close(tab, true)) {
        if (!existing) panel.dispose();
        else if (previousColumn !== undefined && previousColumn !== group.viewColumn) panel.reveal(previousColumn, true);
        await vscode.window.showTextDocument(editor.document, { viewColumn: group.viewColumn, preview: tab.isPreview });
        return;
      }
      if (existing && preview !== undefined) existing.setPreview(preview, 'text');
      await restoreTabPosition(group, index, () => panel.active);
      await rememberMode(uri, true);
      if (animateEntry && existing && panel.active) {
        void panel.webview.postMessage({ type: 'animateEntry' }).then(undefined, error => {
          console.warn('Keil Wizard: unable to animate the view switch', error);
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage('无法切换到配置向导：' + error.message);
    } finally {
      wizardTarget = undefined;
      switchingEditor = false;
      updateEditorActions();
    }
  }

  async function convertCurrent(mode, resource) {
    if (switchingEditor) return;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (resource instanceof vscode.Uri && (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) &&
        resource.toString() !== input.uri.toString()) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const preview = activePreview(tab);
    const activeWizard = preview ? panels.get(preview.uri.toString()) : [...panels.values()].find(({ panel }) => panel.active);
    if (activeWizard) {
      if (mode === 'preview' && !preview) return openNativePreview('wizard', tab, activeWizard.document);
      if (mode === 'wizard' && !preview) return;
      const destination = mode === 'preview' ? preview.origin : mode;
      if (!activeWizard.panel.visible) activeWizard.panel.reveal(undefined, true);
      if (!await activeWizard.panel.webview.postMessage({ type: 'prepareSourceSwitch', destination })) {
        await switchMode(activeWizard.panel, activeWizard.sourceUri, destination);
      }
      return;
    }
    if (mode === 'text') return;
    const editor = vscode.window.activeTextEditor;
    if (!eligible(editor?.document)) return;
    if (mode === 'preview') return openNativePreview('text', tab, editor.document);
    await switchToWizard(editor, { preview: false });
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(activeEditorChanged),
    vscode.window.onDidChangeVisibleTextEditors(updateEditorActions),
    vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.opened) {
        if (tab.input instanceof vscode.TabInputText) newTextTabs.add(tab);
      }
      for (const tab of event.closed) handleClosedTab(tab, event.opened);
      handleClosedPreviewTabs(event.closed);
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (event.opened.includes(activeTab) || event.changed.includes(activeTab)) handleOpenWizardTab(activeTab);
      updateEditorActions();
      schedulePreviewRestore();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void syncEditorAssociations()),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length || event.document !== vscode.window.activeTextEditor?.document) return;
      // Coalesce typing bursts. Commands still check eligibility on invocation.
      clearTimeout(toolbarEditTimer);
      toolbarEditTimer = setTimeout(updateEditorActions, toolbarEditDelay);
    }),
    vscode.commands.registerCommand('keilWizard.convertCurrent', resource => convertCurrent('wizard', resource)),
    vscode.commands.registerCommand('keilWizard.returnToText', resource => convertCurrent('text', resource)),
    vscode.commands.registerCommand('keilWizard.togglePreview', resource => convertCurrent('preview', resource)),
    vscode.window.registerCustomEditorProvider(editorType, {
      resolveCustomTextEditor(document, panel) {
        const key = document.uri.toString();
        panels.get(key)?.panel.dispose();
        panel.webview.options = panelOptions;
        initializePanel(panel, document, wizardTarget?.key === key ? wizardTarget : undefined);
        if (!switchingEditor && !openingWizards.has(key) && eligible(document)) void rememberMode(document.uri, true);
      }
    }),
    vscode.window.registerWebviewPanelSerializer(webviewType, {
      async deserializeWebviewPanel(panel, state) {
        if (typeof state?.sourceUri !== 'string' || !state.sourceUri) {
          panel.dispose();
          return;
        }
        try {
          const uri = vscode.Uri.parse(state.sourceUri, true);
          const document = uri.scheme === 'untitled'
            ? vscode.workspace.textDocuments.find(current => current.uri.toString() === uri.toString())
            : await vscode.workspace.openTextDocument(uri);
          if (!document || panels.has(document.uri.toString())) {
            panel.dispose();
            return;
          }
          panel.webview.options = panelOptions;
          initializePanel(panel, document, { restoredViewState: state.viewState });
          if (eligible(document)) await rememberMode(uri, true);
        } catch (error) {
          panel.dispose();
          vscode.window.showWarningMessage('无法恢复配置向导：' + error.message);
        }
      }
    }),
    vscode.commands.registerCommand('keilWizard.open', (uri, column) => {
      const targetColumn = column ?? vscode.window.activeTextEditor?.viewColumn ?? vscode.window.activeNotebookEditor?.viewColumn ?? vscode.ViewColumn.Active;
      if (uri instanceof vscode.Uri) return openWizard(uri, targetColumn);
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return vscode.window.showInformationMessage('请先打开带配置向导注释的文件。');
      return openWizard(document.uri, targetColumn, document);
    })
  );
  void syncEditorAssociations();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (rememberedFiles.has(textTabKey(tab))) newTextTabs.add(tab);
    }
  }
  activeEditorChanged(vscode.window.activeTextEditor);
}

function deactivate() {
  return finishDeactivation?.();
}

module.exports = { activate, deactivate };
