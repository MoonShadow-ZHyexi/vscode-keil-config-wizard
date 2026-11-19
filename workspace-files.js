const vscode = require('vscode');
const path = require('node:path').posix;

const fileDropMimeTypes = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls'];

function parseDroppedUris(mime, value) {
  if (typeof value !== 'string' || !value) return [];
  if (mime === 'resourceurls') {
    try {
      const resources = JSON.parse(value);
      return Array.isArray(resources) ? resources : [];
    } catch {
      return [];
    }
  }
  return value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function createWorkspaceFilesView(context, onFileRemoved) {
  const updates = new vscode.EventEmitter();
  const storageKey = 'keilWizard.files';
  const fileName = 'keil-config-wizard.json';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let files = [];
  let pending = Promise.resolve();

  function configUri(folder) {
    return vscode.Uri.joinPath(folder.uri, '.vscode', fileName);
  }

  function decodeEntry(folder, entry) {
    return entry.startsWith('uri:') ? vscode.Uri.parse(entry.slice(4)) : vscode.Uri.joinPath(folder.uri, entry);
  }

  function encodeEntry(folder, uri) {
    const prefix = folder.uri.path.replace(/\/$/, '') + '/';
    if (uri.scheme === folder.uri.scheme && uri.authority === folder.uri.authority && uri.path.startsWith(prefix)) {
      return uri.path.slice(prefix.length);
    }
    return 'uri:' + uri.toString();
  }

  async function readFolder(folder) {
    let bytes;
    try {
      bytes = await vscode.workspace.fs.readFile(configUri(folder));
    } catch (error) {
      if (error.code === 'FileNotFound') return [];
      throw error;
    }
    const data = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''));
    if (!data || !Array.isArray(data.files) || !data.files.every(item => typeof item === 'string' && item.length)) {
      throw new Error('配置文件格式不正确：' + configUri(folder).toString());
    }
    return data.files.map(entry => decodeEntry(folder, entry));
  }

  async function writeFolder(folder, uris) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
    const data = { files: uris.map(uri => encodeEntry(folder, uri)) };
    await vscode.workspace.fs.writeFile(configUri(folder), encoder.encode(JSON.stringify(data, null, 2) + '\n'));
  }

  function enqueue(operation) {
    const result = pending.then(operation);
    pending = result.catch(error => {
      vscode.window.showErrorMessage('Keil 配置文件列表操作失败：' + error.message);
    });
    return result;
  }

  async function load() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lists = await Promise.all(folders.map(readFolder));
    files = [...new Map(lists.flat().map(uri => [uri.toString(), uri])).values()];
    updates.fire();
  }

  async function migrate() {
    const old = context.workspaceState.get(storageKey, []);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!old.length || !folders.length) return;
    const lists = await Promise.all(folders.map(readFolder));
    for (const value of old) {
      const uri = vscode.Uri.parse(value);
      const folder = vscode.workspace.getWorkspaceFolder(uri) ?? folders[0];
      const index = folders.findIndex(item => item.uri.toString() === folder.uri.toString());
      if (!lists[index].some(item => item.toString() === uri.toString())) lists[index].push(uri);
    }
    for (let index = 0; index < folders.length; index++) {
      if (lists[index].length) await writeFolder(folders[index], lists[index]);
    }
    await context.workspaceState.update(storageKey, undefined);
  }

  async function changeList(uris, add) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      vscode.window.showInformationMessage('请先打开文件夹或工作区，再添加配置文件。');
      return;
    }
    const lists = await Promise.all(folders.map(readFolder));
    if (add) {
      const known = new Set(lists.flat().map(uri => uri.toString()));
      const changed = new Set();
      for (const uri of uris) {
        const key = uri.toString();
        if (known.has(key)) continue;
        const folder = vscode.workspace.getWorkspaceFolder(uri) ?? folders[0];
        const index = folders.findIndex(item => item.uri.toString() === folder.uri.toString());
        lists[index].push(uri);
        known.add(key);
        changed.add(index);
      }
      for (const index of changed) await writeFolder(folders[index], lists[index]);
    } else {
      for (let index = 0; index < folders.length; index++) {
        const next = lists[index].filter(item => !uris.some(uri => uri.toString() === item.toString()));
        if (next.length !== lists[index].length) await writeFolder(folders[index], next);
      }
    }
    await load();
    return true;
  }

  async function addDroppedFiles(data) {
    const candidates = new Map();
    for (const mime of fileDropMimeTypes) {
      for (const resource of parseDroppedUris(mime, data?.[mime])) {
        if (typeof resource !== 'string') continue;
        let uri;
        try {
          uri = vscode.Uri.parse(resource, true).with({ fragment: '' });
        } catch {
          continue;
        }
        if (uri.scheme === 'file' || uri.scheme === 'vscode-remote' || vscode.workspace.getWorkspaceFolder(uri)) {
          candidates.set(uri.toString(), uri);
        }
      }
    }
    if (!candidates.size) return;

    const checked = await Promise.allSettled([...candidates.values()].map(async uri => {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type & vscode.FileType.File ? uri : undefined;
    }));
    const files = checked.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    if (!files.length) return;
    try { await enqueue(() => changeList(files, true)); } catch {}
  }

  const view = vscode.window.createTreeView('keilWizard.files', {
    dragAndDropController: {
      dragMimeTypes: [],
      dropMimeTypes: fileDropMimeTypes,
      async handleDrop(_target, transfer, token) {
        const entries = await Promise.all(fileDropMimeTypes.map(async mime => [mime, await transfer.get(mime)?.asString()]));
        if (!token.isCancellationRequested) await addDroppedFiles(Object.fromEntries(entries));
      }
    },
    treeDataProvider: {
      onDidChangeTreeData: updates.event,
      getChildren: () => files,
      getTreeItem: uri => {
        const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
        item.id = uri.toString();
        item.description = false;
        item.tooltip = path.basename(uri.path);
        item.contextValue = 'keilWizardFile';
        item.command = { command: 'keilWizard.open', title: '打开 Keil 配置向导', arguments: [uri] };
        return item;
      }
    }
  });

  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/' + fileName);
  const refresh = () => { void enqueue(load).catch(() => {}); };
  context.subscriptions.push(
    updates,
    view,
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refresh),
    watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand('keilWizard.openSource', async uri => {
      if (!(uri instanceof vscode.Uri)) return;
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        vscode.window.showErrorMessage('无法打开源文件：' + error.message);
      }
    }),
    vscode.commands.registerCommand('keilWizard.add', async (uri, selected) => {
      const targets = Array.isArray(selected) && selected.length ? selected : [uri ?? vscode.window.activeTextEditor?.document.uri];
      const valid = targets.filter(target => target instanceof vscode.Uri && target.scheme !== 'untitled');
      if (!valid.length) return vscode.window.showInformationMessage('请先选择或打开一个已保存的文件。');
      try {
        await enqueue(() => changeList(valid, true));
        await vscode.commands.executeCommand('keilWizard.files.focus');
      } catch {}
    }),
    vscode.commands.registerCommand('keilWizard.remove', async uri => {
      if (!(uri instanceof vscode.Uri)) return;
      try {
        await enqueue(async () => {
          if (await changeList([uri], false)) onFileRemoved(uri);
        });
      } catch {}
    })
  );
  void enqueue(async () => { await migrate(); await load(); }).catch(() => {});
  return addDroppedFiles;
}

module.exports = { createWorkspaceFilesView, fileDropMimeTypes };
