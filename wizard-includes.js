const { existsSync, readFileSync, watch: watchDirectory } = require('node:fs');
const path = require('node:path');

function includePath(uri) {
  if (uri?.scheme !== 'file') return;
  const file = path.normalize(uri.fsPath);
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function createIncludeAccess(vscode) {
  const watchers = new Map();

  function resolve(from, name, dependencies) {
    if (from?.scheme !== 'file') return;
    let directory = path.dirname(from.fsPath);
    const root = vscode.workspace.getWorkspaceFolder(from)?.uri.fsPath ?? directory;
    const relativeName = name.replace(/[\\/]/g, path.sep);

    // Resolve explicit quoted paths from the including directory up to the
    // project root. Never search unrelated project folders for a basename.
    while (true) {
      const candidate = path.resolve(directory, relativeName);
      const location = path.relative(root, candidate);
      if (location !== '..' && !location.startsWith('..' + path.sep) && !path.isAbsolute(location)) {
        const uri = vscode.Uri.file(candidate);
        const key = includePath(uri);
        dependencies.set(key, candidate);
        const open = vscode.workspace.textDocuments.find(document => includePath(document.uri) === key);
        if (open) return { uri, text: open.getText() };
        try {
          return { uri, text: readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '') };
        } catch {
          // Try the next project directory when a header is absent or unreadable.
        }
      }
      if (!path.relative(root, directory) || path.dirname(directory) === directory) return;
      directory = path.dirname(directory);
    }
  }

  function watch(filename, refresh) {
    let directory;
    let entry;

    function dispose() {
      if (!entry) return;
      entry.listeners.delete(changed);
      if (!entry.listeners.size) {
        entry.watcher.close();
        if (watchers.get(directory) === entry) watchers.delete(directory);
      }
      entry = undefined;
    }

    function subscribe() {
      // Watch the parent directory so replacing a header atomically still
      // emits an event. A missing path can be watched from an existing ancestor.
      let parent = path.dirname(filename);
      while (!existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
      if (directory === parent && entry && watchers.get(parent) === entry) return;
      dispose();
      directory = parent;

      if (!watchers.has(directory)) {
        const listeners = new Map();
        try {
          const watcher = watchDirectory(directory, { persistent: false }, (_event, name) => {
            const changedPath = name && includePath(vscode.Uri.file(path.join(parent, name)));
            for (const [listener, watchedPath] of [...listeners]) {
              if (!changedPath || changedPath === watchedPath) listener();
            }
          });
          watcher.on('error', () => {
            if (watchers.get(parent)?.watcher === watcher) watchers.delete(parent);
            watcher.close();
          });
          watchers.set(directory, { watcher, listeners });
        } catch {
          // VS Code text document events still cover edits if this volume cannot be watched.
          return;
        }
      }
      entry = watchers.get(directory);
      const firstSegment = path.relative(directory, filename).split(path.sep)[0];
      entry.listeners.set(changed, includePath(vscode.Uri.file(path.join(directory, firstSegment))));
    }

    function changed() {
      subscribe();
      refresh();
    }

    subscribe();
    return { dispose };
  }

  return { resolve, watch };
}

module.exports = { createIncludeAccess, includePath };
