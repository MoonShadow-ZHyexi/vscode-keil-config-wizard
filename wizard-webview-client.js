function initializeWebview(revision, sourceUri, savedScrollPosition, animateEntry, pageId, savedCollapsedGroups) {
  const vscode = acquireVsCodeApi();
  const content = document.querySelector('.content');
  const form = document.querySelector('.configuration');
  const toolbar = document.querySelector('.tree-toolbar');
  const restoredState = vscode.getState();
  let collapsedGroups = restoredState?.viewState?.collapsedGroups ?? savedCollapsedGroups;
  let lastViewState;
  const restoredEdits = restoredState?.edits?.pageId === pageId ? restoredState.edits : undefined;
  const pendingChanges = restoredEdits?.pendingChanges ?? [];
  const submittedTextValues = new WeakMap();
  const settings = new Map();
  const deferredControls = new Map();
  let sequence = 0;
  let nextChangeId = restoredEdits?.nextChangeId ?? 0;
  let textDraft;
  let changeInFlight = false;
  let destination;
  let exitAnimation;

  function isTextField(field) {
    return field?.type === 'text' || field?.type === 'textarea';
  }

  function indexSettings() {
    settings.clear();
    for (const setting of form.querySelectorAll('[data-setting-index]')) {
      settings.set(Number(setting.dataset.settingIndex), setting);
    }
  }

  function fieldAt(index) {
    return settings.get(index)?.querySelector('[data-index]');
  }

  function fade(from, to, timing) {
    if (document.body.classList.contains('vscode-reduce-motion') ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return content.animate([{ opacity: from }, { opacity: to }], timing);
  }

  const entryTiming = { duration: 130, easing: 'ease-out' };

  function sendNextChange() {
    if (changeInFlight) return;
    if (!pendingChanges.length) {
      if (!destination || exitAnimation) return;
      const animation = destination === 'text' && fade(1, 0.7, { duration: 90, easing: 'ease-in', fill: 'forwards' });
      const finish = () => {
        exitAnimation = undefined;
        vscode.postMessage({ type: 'sourceSwitchReady', destination });
        destination = undefined;
        // Restore opacity if the editor is still visible after the switch request.
        if (animation) window.setTimeout(() => animation.cancel(), 150);
      };
      exitAnimation = animation || undefined;
      if (animation) animation.onfinish = finish;
      else finish();
      return;
    }
    exitAnimation?.cancel();
    exitAnimation = undefined;
    changeInFlight = true;
    vscode.postMessage(pendingChanges[0]);
  }

  function restoreField({ index, value, expected }) {
    const field = fieldAt(index);
    if (!field) return;
    if (field.type === 'checkbox') field.checked = value === '1';
    else field.value = value;
    field.dataset.sourceState = expected;
    return field;
  }

  function persistEdits() {
    const draft = textDraft && {
      index: Number(textDraft.dataset.index),
      value: textDraft.value,
      expected: textDraft.dataset.sourceState
    };
    vscode.setState({ ...vscode.getState(), sourceUri, edits: { pageId, nextChangeId, pendingChanges, draft } });
  }

  function queueChange(field, reset = false) {
    if (field.disabled) return;
    const value = field.type === 'checkbox' ? String(Number(field.checked)) : field.value;
    if (!reset && isTextField(field)) {
      if (submittedTextValues.get(field) === value) {
        persistEdits();
        return;
      }
      submittedTextValues.set(field, value);
    }
    pendingChanges.push({
      type: 'changeValue', id: ++nextChangeId, revision,
      index: Number(field.dataset.index), value, expected: field.dataset.sourceState, reset
    });
    persistEdits();
    sendNextChange();
  }

  function commitDraft() {
    const field = textDraft;
    textDraft = undefined;
    if (field?.isConnected) queueChange(field);
  }

  function saveViewState(persist = true) {
    const scroll = content.scrollTop;
    if (scroll === lastViewState?.scroll && collapsedGroups === lastViewState.collapsedGroups) return;
    const viewState = { scroll, collapsedGroups };
    lastViewState = viewState;
    vscode.setState({ ...vscode.getState(), sourceUri, viewState });
    if (persist) vscode.postMessage({ type: 'saveViewState', revision, ...viewState });
  }

  function setBranchCollapsed(button, collapsed) {
    button.setAttribute('aria-expanded', String(!collapsed));
    document.getElementById(button.getAttribute('aria-controls')).hidden = collapsed;
  }

  function restoreTreeState() {
    const collapsed = new Set(collapsedGroups);
    const buttons = form.querySelectorAll('.tree-toggle');
    toolbar.hidden = buttons.length === 0;
    for (const button of buttons) {
      setBranchCollapsed(button, collapsed.has(button.dataset.groupKey));
    }
  }

  function updateControl(item, completedIndex, blurredField) {
    const setting = settings.get(item.index);
    if (!setting) return true;
    setting.classList.toggle('setting-disabled', item.disabled);
    const reset = setting.querySelector('.reset-setting');
    if (reset) reset.disabled = !item.resetEnabled;
    const container = setting.querySelector('.setting-control');
    if (!container) return true;
    const current = container.firstElementChild;
    if (item.disabled && textDraft === current) {
      textDraft = undefined;
      persistEdits();
    }
    if (current?.matches('input,select,textarea')) current.disabled = item.disabled;
    // Save the latest source update until a focused or queued edit can be replaced safely.
    if (!item.disabled && (textDraft === current ||
        pendingChanges.some(change => change.revision === revision && change.index === item.index) ||
        (item.index !== completedIndex && current !== blurredField && current === document.activeElement && isTextField(current)))) {
      return false;
    }
    const template = document.createElement('template');
    template.innerHTML = item.html;
    const updated = template.content.firstElementChild;
    if (current?.matches('input,select,textarea') && updated && current.tagName === updated.tagName && current.type === updated.type) {
      if (current.tagName === 'SELECT') {
        const oldOptions = [...current.options];
        const newOptions = [...updated.options];
        const sameOptions = oldOptions.length === newOptions.length && oldOptions.every((option, index) =>
          option.value === newOptions[index].value && option.textContent === newOptions[index].textContent && option.disabled === newOptions[index].disabled);
        if (!sameOptions) current.replaceChildren(...updated.childNodes);
      }
      if (current.type === 'checkbox') current.checked = updated.checked;
      else {
        current.value = updated.value;
        if (isTextField(current)) submittedTextValues.set(current, updated.value);
      }
      current.dataset.sourceState = updated.dataset.sourceState;
    } else if (container.innerHTML !== item.html) {
      container.innerHTML = item.html;
    }
    return true;
  }

  form.addEventListener('focusout', ({ target }) => {
    const index = Number(target.dataset.index);
    const item = deferredControls.get(index);
    if (item && updateControl(item, undefined, target)) deferredControls.delete(index);
  });

  form.addEventListener('click', ({ target }) => {
    const reset = target.closest('.reset-setting');
    if (reset && !reset.disabled) {
      const field = reset.closest('.setting-row').querySelector('[data-index]');
      if (field) {
        commitDraft();
        queueChange(field, true);
      }
      return;
    }
    const button = target.closest('.tree-toggle');
    if (!button) return;
    const key = button.dataset.groupKey;
    const children = document.getElementById(button.getAttribute('aria-controls'));
    const collapse = button.getAttribute('aria-expanded') === 'true';
    if (collapse && textDraft && children.contains(textDraft)) commitDraft();
    collapsedGroups = collapse ? [...collapsedGroups, key] : collapsedGroups.filter(group => group !== key);
    setBranchCollapsed(button, collapse);
    saveViewState();
  });

  toolbar.addEventListener('click', ({ target }) => {
    const button = target.closest('[data-tree-action]');
    if (!button) return;
    const collapse = button.dataset.treeAction === 'collapse';
    if (collapse) commitDraft();
    collapsedGroups = collapse ? [...form.querySelectorAll('.tree-toggle')].map(branch => branch.dataset.groupKey) : [];
    restoreTreeState();
    saveViewState();
  });

  indexSettings();
  restoreTreeState();
  content.scrollTop = restoredState?.viewState?.scroll ?? savedScrollPosition;
  saveViewState(false);
  content.addEventListener('scroll', () => saveViewState());
  window.addEventListener('blur', commitDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) commitDraft();
  });
  window.addEventListener('message', event => {
    if (event.data?.type === 'animateEntry') fade(0.7, 1, entryTiming);
    if (event.data?.type === 'prepareSourceSwitch') {
      destination = event.data.destination ?? 'text';
      commitDraft();
      const focused = document.activeElement;
      if (focused?.matches('[data-index]')) focused.blur();
      sendNextChange();
    }
    if (event.data?.type === 'updateControls' && event.data.revision >= revision) {
      if (event.data.sequence <= sequence) return;
      if (!event.data.full && event.data.sequence !== sequence + 1) {
        vscode.postMessage({ type: 'viewReady', revision });
        return;
      }
      if (event.data.revision > revision) {
        if (typeof event.data.formHtml !== 'string') {
          vscode.postMessage({ type: 'viewReady', revision });
          return;
        }
        commitDraft();
        revision = event.data.revision;
        form.innerHTML = event.data.formHtml;
        deferredControls.clear();
        indexSettings();
        restoreTreeState();
      }
      sequence = event.data.sequence;
      let completed;
      while (pendingChanges[0]?.id <= event.data.completedChange) completed = pendingChanges.shift();
      if (completed) {
        changeInFlight = false;
        for (const { index, before, after } of event.data.rebased) {
          const field = fieldAt(index);
          if (field?.dataset.sourceState === before) field.dataset.sourceState = after;
          for (const change of pendingChanges) {
            if (change.revision === revision && change.index === index && change.expected === before) change.expected = after;
          }
        }
        persistEdits();
      }
      if (event.data.resumeEdits) commitDraft();
      for (const item of event.data.controls) {
        deferredControls.set(item.index, item);
      }
      for (const [index, item] of deferredControls) {
        if (updateControl(item, completed?.index)) deferredControls.delete(index);
      }
      sendNextChange();
    }
  });

  document.addEventListener('input', ({ target }) => {
    if (!target.matches('[data-index]:enabled') || !isTextField(target)) return;
    textDraft = target;
    persistEdits();
  });
  document.addEventListener('change', ({ target }) => {
    if (!target.dataset.index) return;
    if (textDraft === target) textDraft = undefined;
    queueChange(target);
  });
  for (const change of pendingChanges) {
    if (change.revision !== revision || change.reset) continue;
    const field = restoreField(change);
    if (isTextField(field)) submittedTextValues.set(field, change.value);
  }
  if (restoredEdits?.draft) textDraft = restoreField(restoredEdits.draft);
  if (restoredState?.edits && !restoredEdits) persistEdits();
  vscode.postMessage({ type: 'viewReady', revision });
  if (animateEntry && !restoredState) fade(0.7, 1, entryTiming);
}

module.exports = { initializeWebview };
