const vscode = require('vscode');
const { createHash, randomBytes } = require('node:crypto');
const { parse, numericValue, replacement, defaultInput, isEditable } = require('./configuration');
const { render, renderControl, renderForm } = require('./wizard-webview');

function describeSource(text, uri) {
  const rows = parse(text, uri);
  // Values and source spans change on ordinary edits without rebuilding the form.
  const structure = JSON.stringify(rows.map(({ raw, offset, numeric, annotationEnd, disabled, elements, commented, ...item }) => item));
  for (const row of rows) {
    if (!isEditable(row)) continue;
    const end = text.indexOf('\n', row.offset + row.raw.length);
    const before = text.slice(row.annotationEnd, row.offset).trim().replace(/[\t ]+/g, ' ');
    const suffix = text.slice(row.offset + row.raw.length, end < 0 ? text.length : end).trim();
    const after = suffix.replace(/^([)\]};,]*)[\t ]*(?:\/\/.*|\/\*(?:[^*]|\*(?!\/))*\*\/)$/, '$1');
    try {
      const value = row.numeric ? numericValue(row).toString() : row.raw;
      row.sourceState = createHash('sha256').update(JSON.stringify([before, after, value])).digest('hex');
    } catch {
      // Invalid bit fields remain visible as diagnostics and have no editable value.
    }
  }
  return { text, rows, structure };
}

function rebasedControls(applied, current, uri) {
  if (!applied) return [];
  const committed = applied.text === current.text ? current : describeSource(applied.text, uri);
  if (committed.structure !== applied.before.structure) return [];
  return committed.rows.flatMap(({ sourceState: after }, index) => {
    const before = applied.before.rows[index].sourceState;
    return before && after && before !== after && current.rows[index]?.sourceState === after
      ? [{ index, before, after }]
      : [];
  });
}

function createWizardPanels(workspaceState, { switchMode, onViewChange }) {
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

  function initializePanel(panel, document, { restoredViewState, animateEntry = false, preview } = {}) {
    const sourceUri = document.uri;
    const key = sourceUri.toString();
    const viewStateKey = 'keilWizard.viewState:' + key;
    const savedState = { ...workspaceState.get(viewStateKey), ...pendingViewStates.get(viewStateKey), ...restoredViewState };
    let viewState = {
      scroll: savedState.scroll,
      collapsedGroups: Array.isArray(savedState.collapsedGroups) ? savedState.collapsedGroups : [],
      preview: savedState.preview === true,
      previewOrigin: savedState.previewOrigin === 'text' ? 'text' : 'wizard'
    };
    let rendered;
    let revision = 0;
    let completed;
    let wasVisible = panel.visible;
    let wasActive = panel.active;
    let applying = false;
    let disposed = false;

    const saveViewState = state => {
      viewState = state;
      pendingViewStates.set(viewStateKey, state);
      viewStateTimer ??= setTimeout(flushViewStates, 200);
    };
    const sendControls = (resumeEdits = false, replaceForm = false) => {
      if (disposed || !panel.visible) return;
      const { rows } = rendered;
      void panel.webview.postMessage({
        type: 'updateControls',
        revision,
        resumeEdits,
        completedChange: completed?.id,
        rebased: completed?.rebased.filter(({ index, after }) => rows[index]?.sourceState === after) ?? [],
        formHtml: replaceForm ? renderForm(rows) : undefined,
        controls: replaceForm ? [] : rows.flatMap((row, index) => row.type === 'end' ? [] : [{
          index,
          disabled: row.disabled === true,
          resetEnabled: !row.disabled && isEditable(row),
          html: ['h', 'z', 'n'].includes(row.type) ? undefined : renderControl(row, index)
        }])
      }).then(undefined, error => {
        console.warn('Keil Wizard: unable to update controls', error);
      });
    };

    const setPreview = (enabled, origin = 'wizard') => {
      if (viewState.preview === enabled && (!enabled || viewState.previewOrigin === origin)) return;
      saveViewState({ ...viewState, preview: enabled, previewOrigin: origin });
      if (rendered && !disposed) onViewChange();
    };
    if (preview !== undefined) setPreview(preview, 'text');

    const refresh = (text, changeId, applied) => {
      if (disposed) return;
      const previous = rendered;
      const current = describeSource(text, sourceUri);
      rendered = current;
      if (!previous) {
        panel.webview.html = render(current.rows, ++revision, randomBytes(16).toString('hex'), key, viewState, animateEntry);
        return;
      }
      const replaceForm = current.structure !== previous.structure;
      if (replaceForm) revision++;
      if (changeId !== undefined) completed = { id: changeId, rebased: rebasedControls(applied, current, sourceUri) };
      sendControls(false, replaceForm);
    };
    const refreshIfChanged = current => {
      if (applying) return;
      const text = current.getText();
      if (text !== rendered.text) refresh(text);
    };
    panels.set(key, {
      panel, document, refreshIfChanged, setPreview, sourceUri,
      previewOrigin: () => viewState.preview ? viewState.previewOrigin : undefined
    });
    const listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === key && event.contentChanges.length) refreshIfChanged(event.document);
    });
    const messageListener = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'sourceSwitchReady') {
        return switchMode(panel, sourceUri, message.destination === 'wizard' ? 'wizard' : 'text');
      }
      if (message?.type === 'viewReady') return sendControls(true, message.revision !== revision);
      if (message?.type === 'saveViewState') {
        const { scroll, collapsedGroups } = message;
        if (!disposed && Number.isFinite(scroll) &&
            Array.isArray(collapsedGroups) && collapsedGroups.every(key => typeof key === 'string')) {
          saveViewState({ ...viewState, scroll, collapsedGroups });
        }
        return;
      }
      if (message?.type !== 'changeValue' || !Number.isSafeInteger(message.id) || applying) return;
      if (completed && message.id <= completed.id) return sendControls();
      applying = true;
      let current;
      let applied;
      try {
        current = await vscode.workspace.openTextDocument(sourceUri);
        if (disposed) return;
        const conflict = '该配置项的源文件内容已变化，已刷新，请重新确认配置值。';
        for (let attempt = 0; attempt < 2; attempt++) {
          const text = current.getText();
          const before = text === rendered.text ? rendered : describeSource(text, sourceUri);
          if (current.isClosed || message.revision !== revision || before.structure !== rendered.structure) throw Error(conflict);
          const row = before.rows[message.index];
          if (!row?.sourceState || (message.reset !== true && typeof message.value !== 'string')) throw Error('此配置项不可编辑。');
          // Resolve defaults against the latest parsed row, just like manual edits.
          const input = message.reset === true ? defaultInput(row) : message.value;
          if (['q', 'e', 'c'].includes(row.type) && !/^[01]$/.test(input)) throw Error('开关值无效。');
          const value = replacement(row, input);
          if (value === row.raw) break;
          if (row.sourceState !== message.expected) throw Error(conflict);
          const start = row.offset;
          const end = start + row.raw.length;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(sourceUri, new vscode.Range(current.positionAt(start), current.positionAt(end)), value);
          if (!await vscode.workspace.applyEdit(edit)) {
            if (attempt === 0 && !disposed && !current.isClosed && current.getText() !== text) continue;
            throw Error('VS Code 无法应用修改。');
          }
          applied = { before, text: text.slice(0, start) + value + text.slice(end) };
          if (current.isClosed) current = await vscode.workspace.openTextDocument(sourceUri);
          if (!await current.save()) throw Error('修改已写入编辑器，但自动保存失败，请打开源文件后手动保存。');
          break;
        }
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      } finally {
        applying = false;
        refresh(current?.getText() ?? rendered.text, message.id, applied);
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
    const viewListener = panel.onDidChangeViewState(() => {
      const becameVisible = panel.visible && !wasVisible;
      const lostFocus = wasActive && !panel.active;
      wasVisible = panel.visible;
      wasActive = panel.active;
      if (becameVisible || lostFocus) sendControls(true);
      onViewChange();
    });
    panel.onDidDispose(() => viewListener.dispose());
    refresh(document.getText());
    onViewChange();
  }

  return { panels, initializePanel, flushViewStates };
}

module.exports = { createWizardPanels };
