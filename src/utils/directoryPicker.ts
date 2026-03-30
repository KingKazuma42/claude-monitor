import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'out', 'build', '__pycache__', '.venv', 'venv',
]);

function listSubdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, 'ja'));
  } catch {
    return [];
  }
}

/**
 * Interactive directory picker.
 * Starts at `startDir` and lets the user drill into subdirectories.
 * Returns the chosen path, or undefined if cancelled.
 */
export async function pickDirectory(startDir: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);
  const homeDir = os.homedir();

  while (true) {
    const subdirs = listSubdirs(currentDir);
    const canGoUp = currentDir !== path.parse(currentDir).root;

    const items: vscode.QuickPickItem[] = [];

    // ── Action items ──
    items.push({
      label: '$(check) ここで開く',
      description: currentDir,
      alwaysShow: true,
    });

    if (canGoUp) {
      items.push({
        label: '$(arrow-up) 上の階層へ',
        description: path.dirname(currentDir),
        alwaysShow: true,
      });
    }

    if (subdirs.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // ── Subdirectory items ──
    for (const name of subdirs) {
      const fullPath = path.join(currentDir, name);
      // Show a hint if this subdir itself has children
      const hasChildren = listSubdirs(fullPath).length > 0;
      items.push({
        label: `$(folder) ${name}`,
        description: hasChildren ? '▸' : undefined,
      });
    }

    const displayDir = currentDir.startsWith(homeDir)
      ? '~' + currentDir.slice(homeDir.length)
      : currentDir;

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Claudeセッションを開くディレクトリ',
      placeHolder: displayDir,
      matchOnDescription: false,
    });

    if (!picked) return undefined;  // Cancelled

    if (picked.label.startsWith('$(check)')) {
      return currentDir;
    } else if (picked.label.startsWith('$(arrow-up)')) {
      currentDir = path.dirname(currentDir);
    } else {
      const dirName = picked.label.replace('$(folder) ', '');
      currentDir = path.join(currentDir, dirName);
    }
  }
}

/**
 * Determine the best default start directory:
 * 1. Single workspace folder root
 * 2. Multiple workspace folders: active editor's workspace folder, or first folder
 * 3. No workspace folders: active editor's directory
 * 4. Home directory
 */
export function getDefaultStartDir(): string {
  const folders = vscode.workspace.workspaceFolders;

  // Single workspace folder: use it
  if (folders?.length === 1) {
    return folders[0].uri.fsPath;
  }

  // Multiple workspace folders: try to find the one containing active editor
  if (folders && folders.length > 1) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && !activeEditor.document.isUntitled) {
      const editorPath = activeEditor.document.uri.fsPath;
      const matchingFolder = folders.find(f => editorPath.startsWith(f.uri.fsPath));
      if (matchingFolder) {
        return matchingFolder.uri.fsPath;
      }
    }
    // No active editor or not in any workspace folder: use first folder
    return folders[0].uri.fsPath;
  }

  // No workspace folders: try active editor's directory
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && !activeEditor.document.isUntitled) {
    return path.dirname(activeEditor.document.uri.fsPath);
  }

  // Fallback: home directory
  return os.homedir();
}
