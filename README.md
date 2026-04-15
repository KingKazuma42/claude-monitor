# Claude Monitor

`claude-monitor` is a VS Code extension for monitoring and controlling local Claude Code CLI sessions.

> Status: **WIP**

## Overview

This extension discovers local Claude Code terminals, watches `.claude/projects/**/*.jsonl` activity, and displays session status, conversation history, and output logs in a VS Code activity view.

## Features

- Detects local Claude sessions in terminals
- Monitors Claude Code JSONL output files
- Prefers Claude Code statusline context snapshots when available
- Shows an accordion dashboard with context pressure and source coverage
- Shows session status (`thinking`, `waiting`, `idle`, `stopped`)
- Sends instructions to sessions
- Focuses terminals and kills sessions
- Supports IPC across VS Code windows for non-local sessions
- Delays permission popups so short auto-accept transitions do not notify unnecessarily
- **Cron Scheduler** — schedule recurring instructions to be sent automatically to Claude sessions

## Cron Scheduler

The Cron Scheduler lets you define recurring instructions that are automatically sent to active Claude sessions on a time-based schedule.

### Opening the Scheduler

- Click the **⏰ clock icon** in the Claude Monitor panel toolbar, or
- Run `Claude Monitor: Cron Schedules` from the VS Code command palette.

### Schedule Types

| Type | Description |
|------|-------------|
| **Every N minutes** | Fires at a fixed interval (e.g. every 30 minutes) |
| **Daily at HH:MM** | Fires once per day at the specified local time |

### Targeting

Each schedule can target:
- **All active sessions** — instruction is broadcast to every non-stopped session
- **Specific session** — instruction is delivered only to the selected session; if the session restarts, delivery falls back to the same working directory

### Notifications

When a schedule fires, a brief status-bar message confirms how many sessions received the instruction.

## Getting Started

### Prerequisites

- VS Code
- Node.js / npm
- Claude Code CLI installed and launched in a terminal

### Clone from GitHub

```bash
git clone https://github.com/KingKazuma42/claude-monitor.git
cd claude-monitor
```

### Setup

```bash
npm install
npm run compile
```

### Run in VS Code

- Open the repository in VS Code: `code .`
- Press `F5` to launch the extension in a new Extension Development Host window.
- Open the `Claude Monitor` activity bar view.

### Package and install as a normal extension

```bash
# Package the extension
npm install -g vsce
npm run compile
npm run package

# Install the generated VSIX into VS Code
code --install-extension claude-monitor-0.3.0.vsix
```

Alternatively, use VS Code's command palette:
- `Extensions: Install from VSIX...`
- select `claude-monitor-0.3.0.vsix`

### Build

```bash
npm install
npm run compile
```

### Run in VS Code

- Press `F5` in VS Code to launch the extension in a new Extension Development Host window.
- Open the `Claude Monitor` activity bar view.

### Optional: install the statusline bridge

To let `claude-monitor` use Claude Code's `context_window` data directly, open `Claude Monitor: Settings` from the panel gear or the command palette, then choose the Statusline Bridge action.

This installs a small script under `~/.claude/claude-monitor/` and updates `~/.claude/settings.json` so Claude Code writes per-session status snapshots that `claude-monitor` can read.

The dashboard can also be toggled from `Claude Monitor: Settings` or via the `claudeMonitor.showUsageDashboard` setting.

## Security and Privacy

This repository contains only extension source code and build metadata.
It does not include private API keys, credentials, or user-specific configuration.

## License

This project is licensed under the MIT License.
