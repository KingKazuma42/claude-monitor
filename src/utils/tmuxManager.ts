import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

export type Platform =
  | 'ubuntu'
  | 'debian'
  | 'amazon-linux'
  | 'rhel'
  | 'fedora'
  | 'arch'
  | 'macos'
  | 'unknown';

/**
 * Detect the current OS platform for package manager selection.
 */
export function detectPlatform(): Platform {
  if (os.platform() === 'darwin') {
    return 'macos';
  }

  if (os.platform() === 'linux') {
    try {
      const release = fs.readFileSync('/etc/os-release', 'utf-8').toLowerCase();
      if (release.includes('ubuntu')) return 'ubuntu';
      if (release.includes('debian')) return 'debian';
      if (release.includes('amazon linux') || release.includes('amzn')) return 'amazon-linux';
      if (release.includes('fedora')) return 'fedora';
      if (release.includes('red hat') || release.includes('centos') || release.includes('rhel')) return 'rhel';
      if (release.includes('arch')) return 'arch';
    } catch {
      // /etc/os-release not available
    }
    return 'unknown';
  }

  return 'unknown';
}

/**
 * Return the platform-appropriate command to install tmux, or null if unknown.
 */
export function getInstallCommand(platform: Platform): string | null {
  switch (platform) {
    case 'ubuntu':
    case 'debian':
      return 'sudo apt-get install -y tmux';
    case 'amazon-linux':
      return 'sudo yum install -y tmux';
    case 'rhel':
    case 'fedora':
      return 'sudo dnf install -y tmux';
    case 'arch':
      return 'sudo pacman -S --noconfirm tmux';
    case 'macos':
      return 'brew install tmux';
    default:
      return null;
  }
}

/**
 * Returns true if tmux is available in PATH.
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync('tmux -V', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if a tmux session with the given name currently exists.
 */
export function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellEscape(sessionName)}`, {
      stdio: 'ignore',
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a Map of (pane process PID → tmux session name) for all running tmux panes.
 *
 * This is used in process monitoring: when a Claude process is found, its PID or PPID
 * is looked up here to determine if it is running inside a named tmux session.
 *
 * Returns an empty map if tmux is not running or not installed.
 */
export function getPanePidToSessionName(): Map<number, string> {
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_pid} #{session_name}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    const map = new Map<number, string>();
    for (const line of output.trim().split('\n')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      const pid = parseInt(line.slice(0, spaceIdx), 10);
      const sessionName = line.slice(spaceIdx + 1).trim();
      if (!isNaN(pid) && sessionName) {
        map.set(pid, sessionName);
      }
    }
    return map;
  } catch {
    // tmux not running or not installed
    return new Map();
  }
}

/**
 * Generate a tmux-safe session name from an optional label or workDir basename.
 * Ensures uniqueness by appending a counter if the name is already in use.
 */
export function makeTmuxSessionName(workDir: string, label?: string): string {
  const raw = label || workDir.split('/').filter(Boolean).pop() || 'claude';
  // Keep only characters safe for tmux session names
  const sanitized = raw.replace(/[^a-zA-Z0-9\-_.]/g, '_').slice(0, 28);
  const base = `claude-${sanitized}`;

  if (!tmuxSessionExists(base)) {
    return base;
  }

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!tmuxSessionExists(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
