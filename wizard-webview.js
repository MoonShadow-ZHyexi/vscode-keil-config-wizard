const { integer, numericValue, display } = require('./configuration');
const { initializeWebview } = require('./wizard-webview-client');

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderControl(row, index) {
  if (!'oqes'.includes(row.type) || row.unsupported) return '此标注暂不支持';
  if (!row.raw) return '未找到可编辑的值';
  try {
    const id = ' data-index="' + index + '"';
    if (row.type === 'q' || row.type === 'e') {
      return '<input type="checkbox"' + id + (numericValue(row) !== 0n ? ' checked' : '') + '>';
    }
    if (row.choices.length) {
      const value = numericValue(row);
      const selected = row.choices.findIndex(([key]) => integer(key, row.assembly) === value);
      return '<select' + id + '>' +
        (selected >= 0 ? '' : '<option selected disabled>当前值 ' + escape(display(row)) + '</option>') +
        row.choices.map(([key, label], choiceIndex) => '<option value="' + escape(key) + '"' + (choiceIndex === selected ? ' selected' : '') + '>' + escape(label || key) + '</option>').join('') + '</select>';
    }
    return '<input type="text"' + id + ' value="' + escape(display(row)) + '">';
  } catch (error) {
    return escape(error.message);
  }
}

function render(rows, revision, nonce, panelKey = '', viewState = {}, animateEntry = false) {
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
    const control = renderControl(row, index);
    const hint = [row.help, row.range?.filter(Boolean).join(' / ')].filter(Boolean).join(' · ');
    const name = escape(row.type === 'e' ? '启用' : row.label);
    const help = escape(hint);
    body += '<label' + (row.type === 'e' ? '' : ' id="item-' + index + '"') +
      '><span class="setting-copy"><span class="setting-name" title="' + name + '">' + name + '</span>' +
      (hint ? '<small title="' + help + '">' + help + '</small>' : '') +
      '</span><span class="setting-control" data-control-index="' + index + '">' + control + '</span></label>';
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
    .setting-control{flex:0 0 min(220px,55%);min-width:0;display:flex;justify-content:flex-start;align-items:center}
    input:not([type=checkbox]),select{font:inherit;width:100%;height:36px;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;padding:6px 10px}
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
    JSON.stringify(panelKey).replace(/</g, '\\u003c') + ', ' +
    JSON.stringify(viewState).replace(/</g, '\\u003c') + ', ' + animateEntry + ');</script></html>';
}

module.exports = { render, renderControl };
