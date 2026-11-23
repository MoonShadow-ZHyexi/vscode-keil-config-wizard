const { numericValue, display, isEditable, selectedChoiceIndex } = require('./configuration');
const { initializeWebview } = require('./wizard-webview-client');

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderControl(row, index) {
  if (row.issue) return '<span class="setting-issue" title="' + escape(row.issue) + '">' + escape(row.issue) + '</span>';
  if (row.type === 'unsupported' || row.unsupported) return '此标注暂不支持';
  if (!isEditable(row)) return '未找到可编辑的值';
  try {
    const id = ' data-index="' + index + '" aria-labelledby="setting-' + index + '" data-source-state="' + escape(row.sourceState) + '"' +
      (row.disabled ? ' disabled' : '');
    if (['q', 'e', 'c'].includes(row.type)) {
      return '<input type="checkbox"' + id + (numericValue(row) !== 0n ? ' checked' : '') + '>';
    }
    if (row.type === 'a') {
      return '<textarea rows="2" spellcheck="false"' + id + '>' + escape(display(row)) + '</textarea>';
    }
    if (row.choices.length) {
      const selected = selectedChoiceIndex(row);
      return '<select' + id + '>' +
        (selected >= 0 ? '' : '<option selected disabled>当前值 ' + escape(display(row)) + '</option>') +
        row.choices.map(([key, label], choiceIndex) => '<option value="' + escape(key) + '"' + (choiceIndex === selected ? ' selected' : '') + '>' + escape(label || key) + '</option>').join('') + '</select>';
    }
    return '<input type="text"' + id + ' value="' + escape(display(row)) + '">';
  } catch (error) {
    return escape(error.message);
  }
}

function renderForm(rows) {
  let body = '';
  const levels = [{ key: '', groups: new Map() }];
  rows.forEach((row, index) => {
    if (row.type === 'end') {
      if (levels.length > 1) {
        body += '</ul></li>';
        levels.pop();
      }
      return;
    }

    const isGroup = row.type === 'h' || row.type === 'e' || row.type === 'z';
    const name = escape(row.label || (isGroup ? '未命名分组' : ''));
    const hint = [row.help, row.range?.filter(Boolean).join(' / ')].filter(Boolean).join(' · ');
    const help = escape(hint);
    const caption = '<span class="setting-copy"><span class="setting-name" id="setting-' + index + '" title="' + name + '">' + name +
      '</span>' + (hint ? '<small title="' + help + '">' + help + '</small>' : '') + '</span>';
    // Reset has its own button so refreshing the input cannot replace it or its focus.
    const reset = row.defaultValue === undefined ? '' :
      '<button type="button" class="reset-setting" title="恢复默认值：' + escape(row.defaultValue) +
      '"' + (row.disabled || !isEditable(row) ? ' disabled' : '') + '>恢复默认</button>';
    const control = ['h', 'z', 'n'].includes(row.type) ? '' :
      '<span class="setting-actions"><span class="setting-control" data-control-index="' + index + '">' +
      renderControl(row, index) + '</span>' + reset + '</span>';
    const rowAttributes = (row.disabled ? ' setting-disabled' : '') + '" data-setting-index="' + index + '">';

    if (isGroup) {
      const parent = levels.at(-1);
      const group = JSON.stringify([row.type, row.label]);
      const occurrence = (parent.groups.get(group) ?? 0) + 1;
      parent.groups.set(group, occurrence);
      const key = parent.key + group + ':' + occurrence + '/';
      levels.push({ key, groups: new Map() });
      const heading = row.type === 'z'
        ? '<div class="tree-fixed"><span class="tree-marker" aria-hidden="true"></span>' + caption + '</div>'
        : '<button type="button" class="tree-toggle" data-group-key="' + escape(key) + '" aria-expanded="true" aria-controls="branch-' + index +
          '" aria-labelledby="setting-' + index + '"><span class="tree-chevron" aria-hidden="true"></span>' + caption + '</button>';
      body += '<li><div class="setting-row tree-branch' + rowAttributes + heading + control +
        '</div><ul class="tree-list tree-children" role="list" id="branch-' + index + '">';
      return;
    }
    body += '<li class="setting-row tree-leaf' + (row.type === 'n' ? ' setting-note' : '') + rowAttributes +
      '<span class="tree-marker" aria-hidden="true"></span>' + caption + control + '</li>';
  });
  return body ? '<ul class="tree-list" role="list">' + body + '</ul></li>'.repeat(levels.length - 1) + '</ul>'
    : '<p>没有找到带配置向导起始标记的配置项。</p>';
}

function render(rows, revision, nonce, sourceUri, { scroll, collapsedGroups }, animateEntry = false) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + nonce + '\'; script-src \'nonce-' + nonce + '\'">' +
    '<style nonce="' + nonce + '">' +
    `
    *{box-sizing:border-box}
    html,body{height:100%;margin:0;padding:0}
    body{font-size:16px;line-height:1.5;overflow:hidden}
    .content{height:100%;overflow:auto;padding:0 32px 48px}
    .tree-toolbar{position:sticky;top:0;z-index:1;display:flex;gap:8px;padding:10px 0;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
    .tree-toolbar[hidden]{display:none}
    .tree-toolbar button,.reset-setting{padding:3px 8px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;font-size:13px;cursor:pointer}
    .tree-toolbar button:hover,.reset-setting:enabled:hover{background:var(--vscode-button-secondaryHoverBackground)}
    .tree-toolbar button:focus-visible,.tree-toggle:focus-visible,.reset-setting:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .reset-setting:disabled{opacity:.55;cursor:default}
    .configuration{container-type:inline-size;white-space:nowrap}
    .configuration p,.setting-name,.setting-copy small,.setting-control{overflow:hidden;text-overflow:ellipsis}
    .tree-list{list-style:none;margin:0;padding:0}
    .tree-children{margin-inline-start:8px;padding-inline-start:clamp(4px,2.8cqw,22px);border-inline-start:1px solid var(--vscode-tree-indentGuidesStroke,var(--vscode-panel-border))}
    .setting-row{display:flex;align-items:center;gap:clamp(6px,1.6cqw,14px);min-height:42px;padding-inline:8px;border-bottom:1px solid var(--vscode-panel-border)}
    .setting-row:hover{background:var(--vscode-list-hoverBackground)}
    .tree-branch{min-height:38px;background:var(--vscode-sideBarSectionHeader-background,transparent)}
    .tree-toggle,.tree-fixed{flex:1;min-width:0;min-height:38px;display:flex;align-items:center;gap:clamp(6px,1.6cqw,14px);padding:5px 0;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;text-align:start;white-space:nowrap}
    .tree-toggle{cursor:pointer}
    .tree-chevron,.tree-marker{display:grid;place-items:center;flex:0 0 14px}
    .tree-chevron::before{content:"";width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg)}
    .tree-toggle[aria-expanded="true"] .tree-chevron::before{transform:translateY(-2px) rotate(45deg)}
    .tree-marker::before{content:"";width:8px;height:1px;background:var(--vscode-tree-indentGuidesStroke,var(--vscode-descriptionForeground))}
    .tree-leaf .setting-copy{padding-block:8px}
    .setting-copy{flex:1;min-width:0}
    .setting-name,.setting-copy small{display:block}
    .setting-copy small{font-size:14px;margin-top:4px;color:var(--vscode-descriptionForeground)}
    .setting-note{white-space:normal;color:var(--vscode-descriptionForeground)}
    .setting-issue{color:var(--vscode-errorForeground);white-space:normal}
    .setting-disabled,.setting-disabled small,.setting-disabled :is(input,select,textarea):disabled{color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground))}
    .setting-disabled :is(input,select,textarea):disabled{opacity:.55}
    .setting-actions{flex:0 0 min(220px,55%);min-width:0;display:flex;align-items:center;gap:6px}
    .setting-control{flex:1;min-width:0;display:flex;justify-content:flex-start;align-items:center}
    input:not([type=checkbox]),select,textarea{font:inherit;width:100%;height:36px;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;padding:6px 10px}
    textarea{height:auto;resize:vertical;margin-block:5px}
    input:focus,select:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    input[type=checkbox]{width:20px;height:20px;margin:0;vertical-align:middle;accent-color:var(--vscode-button-background)}
    @container(max-width:480px){
      .setting-row{padding-inline:4px}
      .tree-children{margin-inline-start:6px;padding-inline-start:4px}
      input:not([type=checkbox]),select,textarea,.reset-setting{padding-inline:4px}
    }
    p{color:var(--vscode-descriptionForeground);margin:0 0 24px}
    @media(max-width:600px){.content{padding:0 16px 32px}}
    </style>` +
    '<main class="content"><div class="tree-toolbar" role="group" aria-label="配置分组" hidden>' +
    '<button type="button" data-tree-action="expand">全部展开</button><button type="button" data-tree-action="collapse">全部折叠</button></div>' +
    '<div class="configuration">' + renderForm(rows) + '</div></main>' +
    '<script nonce="' + nonce + '">(' + initializeWebview.toString() + ')(' + revision + ', ' +
    JSON.stringify(sourceUri).replace(/</g, '\\u003c') + ', ' +
    (Number.isFinite(scroll) ? scroll : 0) + ', ' + animateEntry + ', ' + JSON.stringify(nonce) + ', ' +
    JSON.stringify(collapsedGroups ?? []).replace(/</g, '\\u003c') + ');</script></html>';
}

module.exports = { render, renderControl, renderForm };
