const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { createWorkspaceFilesView, fileDropMimeTypes } = require('./workspace-files');
const { parseInteger, formatInteger } = require('./integer-literals');
let flushViewStatesOnDeactivate;

const wizardStart = /<<<\s*Use Configuration Wizard in Context Menu\s*>>>/i;
const cTokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z_$][\w$]*|[+-]?(?:\d|\.\d)(?:[eEpP][+-]|[\w$.'])*/g;
const asmTokens = new RegExp(/;[^\r\n]*|[+-]?&[\da-fA-F][\w$.']*/.source + '|' + cTokens.source, 'g');

function parse(source, uri) {
  if (!wizardStart.test(source)) return [];
  const assembly = /\.(?:s|asm|a51|a66|inc|src|ini)$/i.test(uri?.path ?? '');
  const tokens = assembly ? asmTokens : cTokens;
  const rows = [];
  let active = false;
  let current;
  const pending = [];
  for (const token of source.matchAll(tokens)) {
    const raw = token[0];
    if (raw.startsWith('//') || raw.startsWith('/*') || raw.startsWith(';')) {
      for (const part of raw.split(/\r?\n/)) {
        if (wizardStart.test(part)) active = true;
        if (!active) continue;
        if (/<<<\s*end of configuration section\s*>>>/i.test(part)) return rows;
        const tag = /^\s*(?:\/\/|\/\*|\*|;)?\s*<([^<>]+)>\s*(.*?)\s*(?:\*\/)?$/.exec(part);
        if (!tag) continue;
        const [, annotation, label] = tag;
        const kind = annotation.replace(/\s/g, '');
        if (kind === 'i' && current) {
          current.help = [current.help, label].filter(Boolean).join(' ');
          continue;
        }
        const choice = /^([+-]?[\w'&]+)=$/.exec(kind);
        if (choice && current && parseInteger(choice[1], assembly)) {
          current.choices.push([choice[1], label]);
          continue;
        }
        const range = /^([+-]?[\w'&]+)-([+-]?[\w'&]+)(?::([+-]?[\w'&]+))?$/.exec(kind)?.slice(1);
        if (range && current && range.every(value => value === undefined || parseInteger(value, assembly))) {
          current.range = range;
          continue;
        }
        if (kind.startsWith('#') && current) {
          current.unsupported = true;
          continue;
        }
        const option = /^([oqes])(\d*)(?:\.(\d+)(?:\.\.(\d+))?)?$/.exec(kind);
        if (option) {
          const [, type, skip, low, high] = option;
          current = { type, label, skip: Number(skip), low, high, choices: [], assembly };
          rows.push(current);
          pending.push(current);
        } else {
          current = undefined;
          rows.push({ type: kind === 'h' ? 'h' : /^\/[he]$/.test(kind) ? 'end' : 'unsupported', label: label || kind });
        }
      }
    } else if (active && pending.length) {
      const isNumeric = /^[+-]?(?:\d|\.\d|&)/.test(raw);
      const numeric = isNumeric ? parseInteger(raw, assembly) : undefined;
      for (let index = pending.length - 1; index >= 0; index--) {
        const current = pending[index];

        if (!(current.type === 's' ? raw.startsWith('"') : isNumeric)) continue;
        if (current.skip > 0) {
          current.skip--;
          continue;
        }
        Object.assign(current, { raw, offset: token.index, numeric });
        if (isNumeric && !numeric) current.unsupported = true;
        pending.splice(index, 1);
      }
    }
  }
  return rows;
}

function integer(value, assembly) {
  const literal = parseInteger(value, assembly);
  if (!literal) throw Error('请输入有效的整数字面量。');
  return literal.value;
}

function field(row) {
  if (row.low === undefined || row.type === 's') return;
  const low = BigInt(row.low);
  const high = BigInt(row.high ?? row.low);
  if (high < low || high > 63n) throw Error('位域须在 0–63 位之间。');
  return { low, mask: (1n << (high - low + 1n)) - 1n };
}

function numericValue(row) {
  const value = row.numeric.value;
  const bits = field(row);
  return bits ? (value >> bits.low) & bits.mask : value;
}

function display(row) {
  if (row.type === 's') return row.raw.slice(1, -1);
  return row.low === undefined ? row.raw : formatInteger(numericValue(row), row.numeric, false);
}

function replacement(row, input) {
  if (row.type === 's') {
    if (!/^(?:[^"\\\x00-\x1f\x7f]|\\[^\x00-\x1f\x7f])*$/.test(input)) throw Error('字符串包含未转义的引号、反斜杠或控制字符。');
    if (row.low !== undefined && input.length > Number(row.low)) throw Error('字符串超过标注长度。');
    return '"' + input + '"';
  }
  let value = integer(input.trim(), row.assembly);
  if (row.choices.length && !row.choices.some(([choice]) => integer(choice, row.assembly) === value)) throw Error('请选择列表中的值。');
  if (row.range) {
    const [min, max, step] = row.range.map(item => item === undefined ? 1n : integer(item, row.assembly));
    if (value < min || value > max || step < 1n || (value - min) % step !== 0n) throw Error('数值超出标注范围或不符合步长。');
  }
  const bits = field(row);
  const original = row.numeric.value;
  if (bits) {
    if (value < 0n || value > bits.mask) throw Error('数值超出位域范围。');
    value = (original & ~(bits.mask << bits.low)) | (value << bits.low);
  }
  if (value === original) return row.raw;
  return formatInteger(value, row.numeric);
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function initializeWebview(revision, dropMimeTypes, sourceUri, savedState) {
  const vscode = acquireVsCodeApi();
  const layout = document.querySelector('.layout');
  const content = document.querySelector('.content');
  const outline = document.querySelector('.outline');
  const outlineList = document.querySelector('.outline-list');
  const splitter = document.querySelector('.splitter');
  const menuContext = JSON.parse(layout.dataset.vscodeContext);
  const state = vscode.getState()?.viewState ?? savedState ?? {};
  const collapsed = new Set(state.collapsed || []);
  const minimumOutlineWidth = 112;
  let outlineWidth = Math.max(minimumOutlineWidth, state.width || 240);
  let outlineHidden = state.outlineHidden !== false;
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
  document.addEventListener('dragover', event => {
    const transfer = event.dataTransfer;
    if (!transfer || !dropMimeTypes.some(mime => transfer.types.includes(mime))) return;
    event.preventDefault();
    transfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', event => {
    const transfer = event.dataTransfer;
    if (!transfer || !dropMimeTypes.some(mime => transfer.types.includes(mime))) return;
    event.preventDefault();
    const data = Object.fromEntries(dropMimeTypes.map(mime => [mime, transfer.getData(mime)]));
    vscode.postMessage({ type: 'dropFiles', data });
  });
  document.addEventListener('change', ({ target }) => {
    if (!target.dataset.index) return;
    document.querySelectorAll('input,select').forEach(control => control.disabled = true);
    const value = target.type === 'checkbox' ? String(Number(target.checked)) : target.value;
    vscode.postMessage({ revision, index: Number(target.dataset.index), value });
  });
}

function render(rows, revision, nonce, panelKey = '', viewState = {}) {
  let body = '';
  const outlineItems = [];
  let depth = 0;
  rows.forEach((row, index) => {
    if (row.type === 'end') {
      if (depth) {
        body += '</fieldset>';
        depth--;
      }
      return;
    }
    if (row.type === 'h' || row.type === 'e') {
      outlineItems.push({ index, depth, label: row.label || '未命名分组' });
      const heading = escape(row.label);
      body += '<fieldset id="item-' + index + '"><legend title="' + heading + '">' + heading + '</legend>';
      depth++;
      if (row.type === 'h') return;
    }
    let control = '此标注暂不支持';
    if ('oqes'.includes(row.type) && !row.unsupported) {
      control = '未找到可编辑的值';
      if (row.raw) {
        try {
          const id = ' data-index="' + index + '"';
          if (row.type === 'q' || row.type === 'e') {
            control = '<input type="checkbox"' + id + (numericValue(row) !== 0n ? ' checked' : '') + '>';
          } else if (row.choices.length) {
            const value = numericValue(row);
            const selected = row.choices.findIndex(([key]) => integer(key, row.assembly) === value);
            control = '<select' + id + '>' +
              (selected >= 0 ? '' : '<option selected disabled>当前值 ' + escape(display(row)) + '</option>') +
              row.choices.map(([key, label], choiceIndex) => '<option value="' + escape(key) + '"' + (choiceIndex === selected ? ' selected' : '') + '>' + escape(label || key) + '</option>').join('') + '</select>';
          } else {
            control = '<input type="text"' + id + ' value="' + escape(display(row)) + '">';
          }
        } catch (error) {
          control = escape(error.message);
        }
      }
    }
    const hint = [row.help, row.range?.filter(Boolean).join(' / ')].filter(Boolean).join(' · ');
    const name = escape(row.type === 'e' ? '启用' : row.label);
    const help = escape(hint);
    body += '<label' + (row.type === 'e' ? '' : ' id="item-' + index + '"') +
      '><span class="setting-copy"><span class="setting-name" title="' + name + '">' + name + '</span>' +
      (hint ? '<small title="' + help + '">' + help + '</small>' : '') +
      '</span><span class="setting-control">' + control + '</span></label>';
  });
  body += '</fieldset>'.repeat(depth);
  const [outlineTitle, ...outlineGroups] = outlineItems;
  const nextTopLevel = outlineGroups.findIndex(item => item.depth === 0);
  const outline = outlineGroups.map((item, position) => {
    const hasChildren = outlineGroups[position + 1]?.depth > item.depth;
    const underTitle = nextTopLevel < 0 || position < nextTopLevel;
    const level = item.depth - Number(underTitle);
    const rowClass = level === 0 ? 'outline-row outline-section' : 'outline-row';
    const target = 'item-' + item.index;
    const label = escape(item.label);
    const toggle = hasChildren
      ? '<button type="button" class="outline-toggle" aria-expanded="true" aria-label="折叠 ' + label + '"></button>'
      : '<span class="outline-spacer" aria-hidden="true"></span>';
    const icon = hasChildren ? 'outline-folder' : 'outline-file';
    return '<div class="' + rowClass + '" data-depth="' + item.depth + '" data-indent="' + Math.min(level, 5) + '" data-id="' + target + '">' +
      toggle + '<span class="' + icon + '" aria-hidden="true"></span>' +
      '<button type="button" class="outline-item" title="' + label + '">' + label + '</button></div>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + nonce + '\'; script-src \'nonce-' + nonce + '\'">' +
    '<style nonce="' + nonce + '">*{box-sizing:border-box}html,body{height:100%;margin:0;padding:0}body{font-size:16px;line-height:1.5;overflow:hidden}.layout{display:flex;height:100%;--outline-width:240px}.outline{flex:0 0 var(--outline-width);min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-sideBar-background)}' +
    `
    .outline[hidden]{display:none}
    .outline-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:4px;padding:12px 10px 8px;border-bottom:1px solid var(--vscode-panel-border)}
    .outline-title{flex:1;min-width:0;margin:0;font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-sideBarTitle-foreground)}
    .outline-actions{display:flex;flex:none;gap:4px}
    .outline-actions button,.outline-toggle{border:0;background:transparent;color:inherit;cursor:pointer}
    .outline-actions button{display:grid;place-items:center;width:24px;height:24px;padding:0;border-radius:4px}
    .outline-action-icon{position:relative;width:12px;height:12px;border:1px solid currentColor;border-radius:2px;box-shadow:2px -2px 0 -1px var(--vscode-sideBar-background),3px -3px 0 -1px currentColor}
    .outline-action-icon::before,.outline-action-icon::after{position:absolute;inset:0;margin:auto;background:currentColor}
    .outline-action-icon::before{content:"";width:6px;height:1px}
    [data-action="expand"] .outline-action-icon::after{content:"";width:1px;height:6px}
    .outline-actions button:hover,.outline-row:hover{background:var(--vscode-list-hoverBackground)}
    .outline button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .outline-list{flex:1;min-height:0;overflow:auto;padding-bottom:12px;color:var(--vscode-sideBar-foreground);font-size:14px}
    .outline-row{display:flex;align-items:center;min-height:26px;padding:0 6px;gap:4px}
    .outline-row[hidden]{display:none}
    .outline-section{min-height:30px;border-top:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border));background:var(--vscode-sideBarSectionHeader-background);color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-sideBar-foreground));font-weight:600}
    .outline-section:first-child{border-top-color:transparent}
    .outline-row:has(.outline-item[aria-current="location"]){background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
    .outline-item{align-self:stretch;flex:1;min-width:0;padding:2px 4px;border:0;background:transparent;color:inherit;font:inherit;text-align:start;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;cursor:pointer}
    .outline-toggle,.outline-spacer{flex:0 0 18px;height:22px}
    .outline-toggle{display:grid;place-items:center;padding:0}
    .outline-toggle::before{content:"";display:inline-block;width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(-45deg)}
    .outline-toggle[aria-expanded="true"]::before{transform:translateY(-2px) rotate(45deg)}
    .outline-folder,.outline-file{position:relative;flex:none;border:1px solid currentColor;border-radius:2px;opacity:.75}
    .outline-folder{width:13px;height:9px;margin-top:2px}
    .outline-folder::before{content:"";position:absolute;left:-1px;top:-4px;width:6px;height:4px;border:1px solid currentColor;border-bottom:0;border-radius:2px 2px 0 0}
    .outline-file{width:9px;height:11px;margin-inline:2px}
    .outline-row[data-indent="1"]{padding-left:calc(6px + min(4ch, 45%))}
    .outline-row[data-indent="2"]{padding-left:calc(6px + min(8ch, 45%))}
    .outline-row[data-indent="3"]{padding-left:calc(6px + min(12ch, 45%))}
    .outline-row[data-indent="4"]{padding-left:calc(6px + min(16ch, 45%))}
    .outline-row[data-indent="5"]{padding-left:calc(6px + min(20ch, 45%))}
    .empty-outline{font-size:14px;color:var(--vscode-descriptionForeground);padding:0 10px}
    .splitter{flex:0 0 6px;cursor:col-resize;background:var(--vscode-panel-border);touch-action:none}
    .splitter:hover,.splitter:focus-visible{background:var(--vscode-focusBorder);outline:none}
    .content{flex:1;min-width:0;overflow:auto;padding:32px 32px 48px}
    .configuration{container-type:inline-size;white-space:nowrap}
    .configuration p,legend,.setting-name,.setting-copy small,.setting-control{overflow:hidden;text-overflow:ellipsis}
    fieldset{min-width:0;border:1px solid var(--vscode-panel-border);border-radius:8px;margin:20px 0;padding:10px 20px 16px}
    legend{max-width:100%;font-size:18px;font-weight:600;padding:0 8px}
    label{display:flex;align-items:center;justify-content:space-between;gap:clamp(4px,3cqw,24px);padding:14px 2px;border-bottom:1px solid var(--vscode-panel-border)}
    label:last-child{border-bottom:0}
    .setting-copy{flex:1;min-width:0}
    .setting-name,.setting-copy small{display:block}
    .setting-copy small{font-size:14px;margin-top:4px;color:var(--vscode-descriptionForeground)}
    .setting-control{flex:0 0 auto;max-width:min(100%,max(36px,55%))}
    input,select{font:inherit;min-width:0;max-width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;padding:8px 10px}
    input:focus,select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    input[type=checkbox]{width:20px;height:20px;margin:0;vertical-align:middle;accent-color:var(--vscode-button-background)}
    @container(max-width:480px){
      fieldset{padding-inline:8px}
      fieldset fieldset{padding-inline:0;border-inline:0;border-radius:0}
      legend{padding-inline:4px}
      input:not([type=checkbox]),select{padding-inline:4px}
    }
    ` +
    'p{color:var(--vscode-descriptionForeground);margin:0 0 24px}' +
    '@media(max-width:600px){.content{padding:20px 16px 32px}}</style>' +
    '<div class="layout" data-vscode-context="' + escape(JSON.stringify({ keilWizardPanel: panelKey, keilWizardOutlineVisible: false })) + '">' +
    '<nav id="keil-outline" class="outline" aria-label="配置大纲" hidden><div class="outline-header">' +
    (outlineTitle ? '<h2 class="outline-title" title="' + escape(outlineTitle.label) + '">' + escape(outlineTitle.label) + '</h2>' : '<span class="outline-title empty-outline">没有分组</span>') +
    '<div class="outline-actions">' +
    '<button type="button" data-action="expand" title="全部展开" aria-label="全部展开"><span class="outline-action-icon" aria-hidden="true"></span></button>' +
    '<button type="button" data-action="collapse" title="全部折叠" aria-label="全部折叠"><span class="outline-action-icon" aria-hidden="true"></span></button>' +
    '</div></div><div class="outline-list">' +
    outline +
    '</div></nav><div class="splitter" role="separator" aria-label="调整大纲宽度" aria-orientation="vertical" aria-controls="keil-outline" aria-valuemin="0" tabindex="0"></div><main class="content"><div class="configuration">' +
    (body || '<p>没有找到带配置向导起始标记的配置项。</p>') + '</div></main></div>' +
    '<script nonce="' + nonce + '">(' + initializeWebview.toString() + ')(' + revision + ', ' +
    JSON.stringify(fileDropMimeTypes) + ', ' + JSON.stringify(panelKey).replace(/</g, '\\u003c') + ', ' +
    JSON.stringify(viewState).replace(/</g, '\\u003c') + ');</script></html>';
}

function activate(context) {
  const panels = new Map();
  const panelOptions = { enableScripts: true, localResourceRoots: [] };
  const pendingViewStates = new Map();
  let viewStateTimer;
  let writingViewStates = Promise.resolve();

  function flushViewStates() {
    clearTimeout(viewStateTimer);
    viewStateTimer = undefined;
    if (!pendingViewStates.size) return writingViewStates;
    const updates = [...pendingViewStates].map(async ([key, state]) => {
      try {
        await context.workspaceState.update(key, state);
      } catch (error) {
        console.warn('Keil Wizard: unable to save view state', error);
      }
    });
    pendingViewStates.clear();
    writingViewStates = Promise.all([writingViewStates, ...updates]).then(() => {});
    return writingViewStates;
  }
  flushViewStatesOnDeactivate = flushViewStates;

  const addDroppedFiles = createWorkspaceFilesView(context, uri => {
    panels.get(uri.toString())?.panel.dispose();
  });

  function initializePanel(panel, document, restoredViewState) {
    const sourceUri = document.uri;
    const key = sourceUri.toString();
    const viewStateKey = 'keilWizard.viewState:' + key;
    let viewState = restoredViewState ?? pendingViewStates.get(viewStateKey) ?? context.workspaceState.get(viewStateKey);
    let renderedText = document.getText();
    let revision = 0;
    let applying = false;
    let disposed = false;

    const refresh = (text = renderedText) => {
      if (disposed) return;
      renderedText = text;
      panel.webview.html = render(parse(text, sourceUri), ++revision, randomBytes(16).toString('hex'), key, viewState);
    };
    const refreshIfChanged = current => {
      if (applying) return;
      const text = current.getText();
      if (text !== renderedText) refresh(text);
    };
    panels.set(key, { panel, refreshIfChanged });
    const listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === key && event.contentChanges.length) refreshIfChanged(event.document);
    });
    const messageListener = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'dropFiles') return addDroppedFiles(message.data);
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
        const row = parse(text, sourceUri)[message.index];
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
        refresh(current?.getText());
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      panels.delete(key);
      listener.dispose();
      messageListener.dispose();
      void flushViewStates();
    });
    refresh();
  }

  function setOutlineVisibility(menuContext, visible) {
    const target = panels.get(menuContext?.keilWizardPanel) ?? [...panels.values()].find(({ panel }) => panel.active);
    return target?.panel.webview.postMessage({ type: 'setOutlineVisibility', visible });
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('keilWizard', {
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
    vscode.commands.registerCommand('keilWizard.open', async uri => {
      const targetColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.window.activeNotebookEditor?.viewColumn ?? vscode.ViewColumn.Active;
      let document = vscode.window.activeTextEditor?.document;
      if (uri instanceof vscode.Uri) {
        try {
          document = await vscode.workspace.openTextDocument(uri);
        } catch (error) {
          return vscode.window.showErrorMessage('无法打开配置文件：' + error.message);
        }
      }
      if (!document) return vscode.window.showInformationMessage('请先打开带配置向导注释的文件。');
      const sourceUri = document.uri;
      const existing = panels.get(sourceUri.toString());
      if (existing) {
        existing.refreshIfChanged(document);
        existing.panel.reveal(targetColumn);
        return;
      }
      const panel = vscode.window.createWebviewPanel('keilWizard', sourceUri.path.split('/').pop(), targetColumn, panelOptions);
      initializePanel(panel, document);
    })
  );
}

function deactivate() {
  return flushViewStatesOnDeactivate?.();
}

module.exports = { activate, deactivate };
