const vscode = require('vscode');

const setting = 'editorAssociations';
const ownershipKey = 'keilWizard.managedEditorAssociations';

function associationPatterns(uri) {
  if (!['file', 'vscode-remote'].includes(uri.scheme) || !uri.path.startsWith('/')) return [];
  const path = uri.path.replace(/[\[\]{}*?]/g, character => '[' + character + ']');
  // VS Code versions differ on whether path glob matching includes the URI scheme.
  return [uri.scheme + ':' + path, path];
}

function createEditorAssociations(workspaceState, editorType) {
  const owned = new Set(workspaceState.get(ownershipKey) ?? []);
  let pending = Promise.resolve();

  function sync(uris) {
    const wanted = new Set(uris.filter(uri => vscode.workspace.getWorkspaceFolder(uri)).flatMap(associationPatterns));
    pending = pending.then(async () => {
      if (!wanted.size && !owned.size) return;
      const configuration = vscode.workspace.getConfiguration('workbench');
      const layers = configuration.inspect(setting);
      const current = layers?.workspaceValue ?? {};
      const next = { ...current };
      const nextOwned = new Set(owned);
      let changed = false;
      for (const pattern of owned) {
        if (wanted.has(pattern)) continue;
        nextOwned.delete(pattern);
        if (current[pattern] === editorType) {
          delete next[pattern];
          changed = true;
        }
      }
      for (const pattern of wanted) {
        if (Object.hasOwn(current, pattern) || Object.hasOwn(layers?.globalValue ?? {}, pattern)) continue;
        next[pattern] = editorType;
        nextOwned.add(pattern);
        changed = true;
      }
      if (changed) {
        const value = Object.keys(next).length ? next : undefined;
        await configuration.update(setting, value, vscode.ConfigurationTarget.Workspace);
      }
      if (owned.size !== nextOwned.size || [...owned].some(pattern => !nextOwned.has(pattern))) {
        owned.clear();
        for (const pattern of nextOwned) owned.add(pattern);
        await workspaceState.update(ownershipKey, [...owned]);
      }
    }).catch(error => {
      console.warn('Keil Wizard: unable to update editor associations', error);
    });
    return pending;
  }

  return { sync };
}

module.exports = { createEditorAssociations };
