const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { parse, replacement } = require('./configuration');
const { render, renderControl } = require('./wizard-webview');

function createWizardPanels(workspaceState, { switchToSource, onViewChange }) {
  const panels = new Map();
  const pendingViewStates = new Map();
  let viewStateTimer;
  let writingViewStates = Promise.resolve();

  function flushViewStates() {
    clearTimeout(viewStateTimer);
    viewStateTimer = undefined;
    if (!pendingViewStates.size) return writingViewStates;
    const updates = [...pendingViewStates].map(async ([key, state]) => {
      try {
        await workspaceState.update(key, state);
      } catch (error) {
        console.warn('Keil Wizard: unable to save view state', error);
      }
    });
    pendingViewStates.clear();
    writingViewStates = Promise.all([writingViewStates, ...updates]).then(() => {});
    return writingViewStates;
  }

  function initializePanel(panel, document, restoredViewState, animateEntry = false) {
    const sourceUri = document.uri;
    const key = sourceUri.toString();
    const viewStateKey = 'keilWizard.viewState:' + key;
    let viewState = restoredViewState ?? pendingViewStates.get(viewStateKey) ?? workspaceState.get(viewStateKey);
    let renderedText = document.getText();
    let renderedRows;
    let renderedStructure;
    let revision = 0;
    let applying = false;
    let disposed = false;

    const renderPage = (rows, entry = false) => {
      panel.webview.html = render(rows, revision, randomBytes(16).toString('hex'), key, viewState, entry);
    };

    const refresh = (text = renderedText, completedChange = false) => {
      if (disposed) return;
      renderedText = text;
      const rows = parse(text, sourceUri);
      const structure = JSON.stringify(rows.map(({ raw, offset, numeric, ...item }) => item));
      revision++;
      if (panel.visible && structure === renderedStructure) {
        const sentRevision = revision;
        const renderIfCurrent = () => {
          if (!disposed && sentRevision === revision) renderPage(rows);
        };
        void panel.webview.postMessage({
          type: 'updateControls',
          revision,
          completedChange,
          controls: rows.flatMap((row, index) => row.type === 'h' || row.type === 'end' ? [] : [{ index, html: renderControl(row, index) }])
        }).then(delivered => {
          if (!delivered) renderIfCurrent();
        }, error => {
          console.warn('Keil Wizard: unable to update controls', error);
          renderIfCurrent();
        });
      } else {
        renderPage(rows, animateEntry && !renderedRows);
      }
      renderedRows = rows;
      renderedStructure = structure;
    };
    const refreshIfChanged = current => {
      if (applying) return;
      const text = current.getText();
      if (text !== renderedText) refresh(text);
    };
    panels.set(key, { panel, document, refreshIfChanged, sourceUri });
    const listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === key && event.contentChanges.length) refreshIfChanged(event.document);
    });
    const messageListener = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'sourceSwitchReady') return switchToSource(panel, sourceUri);
      if (message?.type === 'saveViewState') {
        if (!disposed && message.state && typeof message.state === 'object' && !Array.isArray(message.state)) {
          viewState = message.state;
          pendingViewStates.set(viewStateKey, viewState);
          viewStateTimer ??= setTimeout(flushViewStates, 200);
        }
        return;
      }
      if (applying) return;
      applying = true;
      let current;
      try {
        if (message.revision !== revision) throw Error('源文件已变化，请重新确认配置值。');
        current = await vscode.workspace.openTextDocument(sourceUri);
        if (disposed) return;
        const text = current.getText();
        if (current.isClosed || text !== renderedText) throw Error('源文件已变化，请重新确认配置值。');
        const row = renderedRows[message.index];
        if (!row?.raw || row.unsupported || typeof message.value !== 'string') throw Error('此配置项不可编辑。');
        if (['q', 'e'].includes(row.type) && !/^[01]$/.test(message.value)) throw Error('开关值无效。');
        const value = replacement(row, message.value);
        if (value !== row.raw) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(sourceUri, new vscode.Range(current.positionAt(row.offset), current.positionAt(row.offset + row.raw.length)), value);
          if (!await vscode.workspace.applyEdit(edit)) throw Error('VS Code 无法应用修改。');
          if (current.isClosed) current = await vscode.workspace.openTextDocument(sourceUri);
          if (!await current.save()) throw Error('修改已写入编辑器，但自动保存失败，请打开源文件后手动保存。');
        }
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      } finally {
        applying = false;
        refresh(current?.getText(), true);
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      if (panels.get(key)?.panel === panel) panels.delete(key);
      listener.dispose();
      messageListener.dispose();
      void flushViewStates();
      onViewChange();
    });
    const viewListener = panel.onDidChangeViewState(onViewChange);
    panel.onDidDispose(() => viewListener.dispose());
    refresh();
    onViewChange();
  }

  function setOutlineVisibility(menuContext, visible) {
    const target = panels.get(menuContext?.keilWizardPanel) ?? [...panels.values()].find(({ panel }) => panel.active);
    return target?.panel.webview.postMessage({ type: 'setOutlineVisibility', visible });
  }

  return { panels, initializePanel, setOutlineVisibility, flushViewStates };
}

module.exports = { createWizardPanels };
