const vscode = require('vscode');
const { parse } = require('./configuration');
const { createWizardPanels } = require('./wizard-panel');
const { createEditorAssociations } = require('./editor-associations');

const editorType = 'keilWizard.editor';
const webviewType = 'keilWizard';
const nativeReopenWait = 100;
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
  const newTextTabs = new WeakSet();
  const pendingNativeSwitches = new Map();
  let animatedEditor;
  let switchingEditor = false;
  let convertibleResource;
  let legacyWizardActive = false;
  const panelOptions = { enableScripts: true, localResourceRoots: [] };

  function syncEditorAssociations() {
    const openFiles = vscode.window.tabGroups.all.flatMap(group =>
      group.tabs.flatMap(tab => wizardTabKey(tab) ? [tab.input.uri] : []));
    return editorAssociations.sync(openFiles);
  }

  const { panels, initializePanel, setOutlineVisibility, flushViewStates } = createWizardPanels(context.workspaceState, {
    switchToSource,
    onViewChange: updateEditorActions
  });

  finishDeactivation = () => {
    for (const timer of pendingNativeSwitches.values()) clearTimeout(timer);
    pendingNativeSwitches.clear();
    return Promise.all([flushViewStates(), editorAssociations.sync([])]);
  };

  function eligible(editor) {
    const document = editor?.document;
    if (!document || document.uri.scheme === 'untitled') return false;
    return parse(document.getText(), document.uri).some(row =>
      ['o', 'q', 'e', 's'].includes(row.type) && row.raw && !row.unsupported);
  }

  function updateEditorActions() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri.toString();
    const nextResource = uri && textTabKey(tab) === uri && eligible(editor) ? uri : undefined;
    if (nextResource !== convertibleResource) {
      convertibleResource = nextResource;
      void vscode.commands.executeCommand('setContext', 'keilWizard.convertibleResources', nextResource ? [nextResource] : []);
    }
    const nextLegacyWizard = tab?.input instanceof vscode.TabInputWebview && tab.input.viewType === webviewType;
    if (nextLegacyWizard !== legacyWizardActive) {
      legacyWizardActive = nextLegacyWizard;
      void vscode.commands.executeCommand('setContext', 'keilWizard.legacyWizardActive', nextLegacyWizard);
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
    if (!newTextTabs.delete(tab) || switchingEditor) return;
    const key = textTabKey(tab);
    const existing = panels.get(key);
    if (!existing) return;
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

  function handleClosedTab(tab) {
    cancelNativeSwitch(tab);
    const key = wizardTabKey(tab);
    if (!key) return;
    const activeTab = tab.group.activeTab;
    if (textTabKey(activeTab) === key) {
      cancelNativeSwitch(activeTab);
      newTextTabs.delete(activeTab);
    }
  }

  async function createWizardPanel(document, column, animateEntry = false) {
    const uri = document.uri;
    if (usesNativeEditor(uri)) {
      const key = uri.toString();
      if (animateEntry) animatedEditor = key;
      await vscode.commands.executeCommand('vscode.openWith', uri, editorType, { viewColumn: column, preview: false });
      const opened = panels.get(key);
      if (!opened) throw Error('VS Code 未能打开配置向导编辑器。');
      return opened.panel;
    }
    const panel = vscode.window.createWebviewPanel(webviewType, uri.path.split('/').pop(), column, panelOptions);
    initializePanel(panel, document, undefined, animateEntry);
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
        await syncEditorAssociations();
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

  async function switchToSource(panel, uri) {
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
          await syncEditorAssociations();
          return;
        }
        if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return;
      }
      const editor = await vscode.window.showTextDocument(uri, { viewColumn: group.viewColumn, preview: false });
      if (editor.viewColumn !== group.viewColumn) return;
      if (await vscode.window.tabGroups.close(tab, true)) {
        await syncEditorAssociations();
        await restoreTabPosition(group, index, () => vscode.window.activeTextEditor === editor);
      }
    } catch (error) {
      vscode.window.showErrorMessage('无法切换到文本编辑器：' + error.message);
    } finally {
      switchingEditor = false;
      updateEditorActions();
    }
  }

  async function switchToWizard(editor) {
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
      if (reopen && !existing && !editor.document.isDirty && usesNativeEditor(uri)) {
        // Reopen With acts on the selected tabs, so focus only the current file first.
        await vscode.window.showTextDocument(editor.document, { viewColumn: group.viewColumn, preview: tab.isPreview });
        if (!sourceIsActive()) return;
        animatedEditor = key;
        await vscode.commands.executeCommand(reopenCommand, editorType);
        if (wizardTabKey(vscode.window.tabGroups.activeTabGroup.activeTab) === key) {
          await syncEditorAssociations();
          return;
        }
        if (!sourceIsActive()) return;
      }
      const previousColumn = existing?.panel.viewColumn;
      const panel = existing ? existing.panel : await createWizardPanel(editor.document, group.viewColumn, true);
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
      await restoreTabPosition(group, index, () => panel.active);
      await syncEditorAssociations();
      if (existing && panel.active) {
        void panel.webview.postMessage({ type: 'animateEntry' }).then(undefined, error => {
          console.warn('Keil Wizard: unable to animate the view switch', error);
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage('无法切换到配置向导：' + error.message);
    } finally {
      animatedEditor = undefined;
      switchingEditor = false;
      updateEditorActions();
    }
  }

  async function convertCurrent(returnToTextOnly, resource) {
    if (switchingEditor) return;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (resource instanceof vscode.Uri && (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) &&
        resource.toString() !== input.uri.toString()) return;
    const activePanel = [...panels.values()].find(({ panel }) => panel.active);
    if (activePanel) {
      if (!await activePanel.panel.webview.postMessage({ type: 'prepareSourceSwitch' })) {
        await switchToSource(activePanel.panel, activePanel.sourceUri);
      }
      return;
    }
    if (returnToTextOnly) return;
    const editor = vscode.window.activeTextEditor;
    if (!eligible(editor)) return;
    await switchToWizard(editor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(activeEditorChanged),
    vscode.window.onDidChangeVisibleTextEditors(updateEditorActions),
    vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.opened) {
        if (tab.input instanceof vscode.TabInputText) newTextTabs.add(tab);
      }
      for (const tab of event.closed) handleClosedTab(tab);
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (event.opened.includes(activeTab) || event.changed.includes(activeTab)) handleOpenWizardTab(activeTab);
      updateEditorActions();
      if (event.opened.some(wizardTabKey) || event.closed.some(wizardTabKey)) {
        void syncEditorAssociations();
      }
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(event => {
      if (event.opened.length || event.closed.length) void syncEditorAssociations();
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === vscode.window.activeTextEditor?.document) updateEditorActions();
    }),
    vscode.commands.registerCommand('keilWizard.convertCurrent', resource => convertCurrent(false, resource)),
    vscode.commands.registerCommand('keilWizard.returnToText', resource => convertCurrent(true, resource)),
    vscode.window.registerCustomEditorProvider(editorType, {
      resolveCustomTextEditor(document, panel) {
        const key = document.uri.toString();
        panels.get(key)?.panel.dispose();
        panel.webview.options = panelOptions;
        initializePanel(panel, document, undefined, animatedEditor === key);
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
          initializePanel(panel, document, state.viewState);
        } catch (error) {
          panel.dispose();
          vscode.window.showWarningMessage('无法恢复配置向导：' + error.message);
        }
      }
    }),
    vscode.commands.registerCommand('keilWizard.showOutline', menuContext => setOutlineVisibility(menuContext, true)),
    vscode.commands.registerCommand('keilWizard.hideOutline', menuContext => setOutlineVisibility(menuContext, false)),
    vscode.commands.registerCommand('keilWizard.open', (uri, column) => {
      const targetColumn = column ?? vscode.window.activeTextEditor?.viewColumn ?? vscode.window.activeNotebookEditor?.viewColumn ?? vscode.ViewColumn.Active;
      if (uri instanceof vscode.Uri) return openWizard(uri, targetColumn);
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return vscode.window.showInformationMessage('请先打开带配置向导注释的文件。');
      return openWizard(document.uri, targetColumn, document);
    })
  );
  void syncEditorAssociations();
  activeEditorChanged(vscode.window.activeTextEditor);
}

function deactivate() {
  return finishDeactivation?.();
}

module.exports = { activate, deactivate };
