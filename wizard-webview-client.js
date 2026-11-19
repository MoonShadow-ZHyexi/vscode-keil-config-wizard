function initializeWebview(revision, sourceUri, savedState, animateEntry) {
  const vscode = acquireVsCodeApi();
  const layout = document.querySelector('.layout');
  const content = document.querySelector('.content');
  const outline = document.querySelector('.outline');
  const outlineList = document.querySelector('.outline-list');
  const splitter = document.querySelector('.splitter');
  const menuContext = JSON.parse(layout.dataset.vscodeContext);
  const restoredState = vscode.getState();
  const state = restoredState?.viewState ?? savedState ?? {};
  const collapsed = new Set(state.collapsed || []);
  const minimumOutlineWidth = 112;
  let outlineWidth = Math.max(minimumOutlineWidth, state.width || 240);
  let outlineHidden = state.outlineHidden === true;
  let outlineScroll = state.outlineScroll || 0;
  let drag;

  const parents = [];
  const entries = Array.from(outlineList.querySelectorAll('.outline-row'), row => {
    const depth = Number(row.dataset.depth);
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const target = document.getElementById(row.dataset.id);
    const entry = {
      row, depth, id: row.dataset.id, target, parent: parents.at(-1),
      heading: target.querySelector('legend'),
      label: row.querySelector('.outline-item'),
      toggle: row.querySelector('.outline-toggle')
    };
    parents.push(entry);
    return entry;
  });
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));
  let activeSection;
  let highlighted;
  let outlineJump;
  let lastSnapshot;
  const pendingChanges = [];
  let changeInFlight = false;
  let switchingToSource = false;
  let exitAnimation;

  function fade(from, to, timing) {
    if (document.body.classList.contains('vscode-reduce-motion') ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return layout.animate([{ opacity: from }, { opacity: to }], timing);
  }

  const entryTiming = { duration: 130, easing: 'ease-out' };

  function sendNextChange() {
    if (changeInFlight) return;
    if (!pendingChanges.length) {
      if (!switchingToSource || exitAnimation) return;
      const animation = fade(1, 0.7, { duration: 90, easing: 'ease-in', fill: 'forwards' });
      const finish = () => {
        exitAnimation = undefined;
        switchingToSource = false;
        vscode.postMessage({ type: 'sourceSwitchReady' });
        // Restore opacity if the editor is still visible after the switch request.
        if (animation) window.setTimeout(() => animation.cancel(), 150);
      };
      exitAnimation = animation;
      if (animation) animation.onfinish = finish;
      else finish();
      return;
    }
    exitAnimation?.cancel();
    exitAnimation = undefined;
    changeInFlight = true;
    vscode.postMessage({ revision, ...pendingChanges[0] });
  }

  function saveState(persist = true) {
    const snapshot = {
      width: outlineWidth,
      outlineHidden,
      scroll: content.scrollTop,
      outlineScroll: outline.hidden ? outlineScroll : outlineList.scrollTop,
      collapsed: [...collapsed],
      activeSection: activeSection?.id ?? null
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSnapshot) return;
    lastSnapshot = serialized;
    vscode.setState({ sourceUri, viewState: snapshot });
    if (persist) vscode.postMessage({ type: 'saveViewState', state: snapshot });
  }

  function highlightCurrent(reveal = true) {
    let visible = activeSection;
    while (visible?.row.hidden) visible = visible.parent;
    if (highlighted !== visible) {
      highlighted?.label.removeAttribute('aria-current');
      highlighted = visible;
      highlighted?.label.setAttribute('aria-current', 'location');
    }
    if (!reveal || !visible || outline.hidden) return;
    const row = visible.row.getBoundingClientRect();
    const viewport = outlineList.getBoundingClientRect();
    if (row.top < viewport.top) outlineList.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) outlineList.scrollTop += row.bottom - viewport.bottom;
  }

  function updateOutline() {
    for (const { row, id, parent, toggle, label } of entries) {
      row.hidden = Boolean(parent && (parent.row.hidden || collapsed.has(parent.id)));
      if (toggle) {
        const expanded = !collapsed.has(id);
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', (expanded ? '折叠 ' : '展开 ') + label.textContent);
      }
    }
  }

  function updateCurrent(reveal = true) {
    const boundary = content.getBoundingClientRect().top + 40;
    activeSection = undefined;
    for (const entry of entries) {
      if (entry.heading.getBoundingClientRect().top > boundary) break;
      activeSection = entry;
    }
    highlightCurrent(reveal);
  }

  function maximumOutlineWidth() {
    return Math.max(0, layout.clientWidth - splitter.offsetWidth - 120);
  }

  function applyOutlineWidth() {
    const max = maximumOutlineWidth();
    const width = outlineHidden || max < minimumOutlineWidth ? 0 : Math.min(max, outlineWidth);
    const wasHidden = outline.hidden;
    if (!wasHidden && !width) outlineScroll = outlineList.scrollTop;
    outline.hidden = width === 0;
    if (wasHidden !== outline.hidden) {
      menuContext.keilWizardOutlineVisible = !outline.hidden;
      layout.dataset.vscodeContext = JSON.stringify(menuContext);
    }
    layout.style.setProperty('--outline-width', width + 'px');
    splitter.setAttribute('aria-valuemax', String(max));
    splitter.setAttribute('aria-valuenow', String(Math.round(width)));
    splitter.title = width ? '拖动以调整大纲宽度' : '向右拖动以打开大纲';
    if (wasHidden && width) {
      outlineList.scrollTop = outlineScroll;
    }
  }

  function setOutlineVisibility(visible) {
    outlineHidden = !visible;
    applyOutlineWidth();
    saveState();
  }

  function setCollapsed(entry, isCollapsed) {
    if (isCollapsed) collapsed.add(entry.id);
    else collapsed.delete(entry.id);
    updateOutline();
    highlightCurrent();
    saveState();
  }

  updateOutline();
  applyOutlineWidth();
  content.scrollTop = state.scroll || 0;
  outlineJump = content.scrollTop;
  activeSection = entriesById.get(state.activeSection);
  if (activeSection) highlightCurrent(false);
  else updateCurrent(false);
  saveState(false);

  content.addEventListener('scroll', () => {
    if (content.scrollTop !== outlineJump) {
      outlineJump = undefined;
      updateCurrent();
    }
    saveState();
  });
  outlineList.addEventListener('scroll', () => {
    if (outline.hidden) return;
    outlineScroll = outlineList.scrollTop;
    saveState();
  });
  window.addEventListener('resize', applyOutlineWidth);
  window.addEventListener('message', event => {
    if (event.data?.type === 'setOutlineVisibility') setOutlineVisibility(event.data.visible);
    if (event.data?.type === 'animateEntry') fade(0.7, 1, entryTiming);
    if (event.data?.type === 'prepareSourceSwitch') {
      switchingToSource = true;
      const focused = document.activeElement;
      if (focused?.matches('input[data-index],select[data-index]')) focused.blur();
      sendNextChange();
    }
    if (event.data?.type === 'updateControls') {
      revision = event.data.revision;
      const completedIndex = event.data.completedChange && changeInFlight ? pendingChanges[0].index : undefined;
      if (event.data.completedChange && changeInFlight) {
        pendingChanges.shift();
        changeInFlight = false;
      }
      for (const item of event.data.controls) {
        if (pendingChanges.some(change => change.index === item.index)) continue;
        const container = document.querySelector('[data-control-index="' + item.index + '"]');
        if (!container) continue;
        const active = document.activeElement;
        if (item.index !== completedIndex && container.contains(active) && active.tagName === 'INPUT' && active.type === 'text') continue;
        const template = document.createElement('template');
        template.innerHTML = item.html;
        const current = container.firstElementChild;
        const updated = template.content.firstElementChild;
        if (current && updated && current.tagName === updated.tagName && current.type === updated.type) {
          if (current.tagName === 'SELECT') {
            const oldOptions = [...current.options];
            const newOptions = [...updated.options];
            const sameOptions = oldOptions.length === newOptions.length && oldOptions.every((option, index) =>
              option.value === newOptions[index].value && option.textContent === newOptions[index].textContent && option.disabled === newOptions[index].disabled);
            if (!sameOptions) current.replaceChildren(...updated.childNodes);
          }
          if (current.type === 'checkbox') current.checked = updated.checked;
          else current.value = updated.value;
        } else if (container.innerHTML !== item.html) {
          container.innerHTML = item.html;
        }
      }
      sendNextChange();
    }
  });

  outline.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (action) {
      collapsed.clear();
      if (action.dataset.action === 'collapse') {
        for (const entry of entries) if (entry.toggle) collapsed.add(entry.id);
      }
      updateOutline();
      highlightCurrent();
      saveState();
      return;
    }

    const toggle = event.target.closest('.outline-toggle');
    const label = event.target.closest('.outline-item');
    const entry = entriesById.get((toggle || label)?.closest('.outline-row').dataset.id);
    if (toggle) {
      setCollapsed(entry, !collapsed.has(entry.id));
    } else if (label) {
      content.scrollTop += entry.target.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
      outlineJump = content.scrollTop;
      activeSection = entry;
      highlightCurrent();
      saveState();
    }
  });

  outlineList.addEventListener('keydown', event => {
    const row = event.target.closest('.outline-row');
    if (!row || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const entry = entriesById.get(row.dataset.id);
    const visible = entries.filter(item => !item.row.hidden);
    const index = visible.indexOf(entry);
    let next;
    switch (event.key) {
      case 'ArrowUp': next = visible[index - 1]; break;
      case 'ArrowDown': next = visible[index + 1]; break;
      case 'Home': next = visible[0]; break;
      case 'End': next = visible.at(-1); break;
      case 'ArrowLeft':
        if (entry.toggle && !collapsed.has(entry.id)) setCollapsed(entry, true);
        else next = entry.parent;
        break;
      case 'ArrowRight':
        if (entry.toggle && collapsed.has(entry.id)) setCollapsed(entry, false);
        else if (visible[index + 1]?.parent === entry) next = visible[index + 1];
        break;
      default: return;
    }
    event.preventDefault();
    next?.label.focus();
  });

  splitter.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    drag = {
      pointerId: event.pointerId,
      width: outlineWidth,
      offset: event.clientX - splitter.getBoundingClientRect().left
    };
    splitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId) return;
    const width = event.clientX - layout.getBoundingClientRect().left - drag.offset;
    outlineHidden = width < minimumOutlineWidth;
    outlineWidth = outlineHidden ? drag.width : Math.max(minimumOutlineWidth, Math.min(width, maximumOutlineWidth()));
    applyOutlineWidth();
    saveState();
  });
  splitter.addEventListener('lostpointercapture', event => {
    if (drag?.pointerId === event.pointerId) drag = undefined;
  });
  splitter.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (outline.hidden) {
      if (event.key === 'ArrowRight') setOutlineVisibility(true);
      return;
    }
    const width = Math.min(outlineWidth, maximumOutlineWidth()) + (event.key === 'ArrowRight' ? 10 : -10);
    outlineHidden = width < minimumOutlineWidth;
    if (!outlineHidden) outlineWidth = Math.min(width, maximumOutlineWidth());
    applyOutlineWidth();
    saveState();
  });
  document.addEventListener('change', ({ target }) => {
    if (!target.dataset.index) return;
    const value = target.type === 'checkbox' ? String(Number(target.checked)) : target.value;
    pendingChanges.push({ index: Number(target.dataset.index), value });
    sendNextChange();
  });
  if (animateEntry && !restoredState) fade(0.7, 1, entryTiming);
}

module.exports = { initializeWebview };
