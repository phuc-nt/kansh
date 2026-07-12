// Best-effort "jump to session": focuses the window that owns a session.
// VSCode sessions: `code <cwd>` reuses the matching workspace window.
// CLI sessions: activate the terminal app found in the process ancestry.
// Everything else degrades to a copyable resume command in the UI.
// Security: all spawns are fixed argv arrays — no shell, no interpolation.

export interface JumpTarget {
  sessionId: string;
  entrypoint: string;
  cwd: string;
  status: 'running' | 'waiting' | 'ended';
}

export interface JumpResult {
  /** what actually happened, for the UI toast */
  action: 'opened-vscode' | 'activated-terminal' | 'copy-fallback';
  /** command the user can run manually when we couldn't focus precisely */
  resumeCommand: string;
}

const KNOWN_TERMINAL_APPS = ['iTerm2', 'iTerm', 'Terminal', 'WezTerm', 'Alacritty', 'kitty', 'Ghostty'];

async function spawnOk(argv: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function spawnText(argv: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' });
    return await new Response(proc.stdout).text();
  } catch {
    return '';
  }
}

/** Find a known terminal app among ancestors of claude processes. */
async function detectRunningTerminalApp(): Promise<string | null> {
  const output = await spawnText(['ps', '-axo', 'command=']);
  for (const app of KNOWN_TERMINAL_APPS) {
    if (output.includes(`${app}.app`)) return app === 'iTerm' ? 'iTerm2' : app;
  }
  return null;
}

export async function jumpToSession(target: JumpTarget): Promise<JumpResult> {
  // single-quote cwd so pasted commands survive spaces/backticks/$( ) in paths
  const quotedCwd = `'${(target.cwd || '~').replaceAll("'", `'\\''`)}'`;
  const resumeCommand = `cd ${quotedCwd} && claude --resume ${target.sessionId}`;

  // an ended session has no window to focus — go straight to the resume command
  if (target.status === 'ended') {
    return { action: 'copy-fallback', resumeCommand };
  }

  if (target.entrypoint.includes('vscode') && target.cwd) {
    // `code <folder>` focuses the existing window for that folder if present
    if (await spawnOk(['code', target.cwd])) {
      return { action: 'opened-vscode', resumeCommand };
    }
    if (await spawnOk(['open', '-a', 'Visual Studio Code', target.cwd])) {
      return { action: 'opened-vscode', resumeCommand };
    }
    return { action: 'copy-fallback', resumeCommand };
  }

  // CLI session: app-level activation only (tab-level focus is unreliable)
  const terminalApp = await detectRunningTerminalApp();
  if (terminalApp && (await spawnOk(['osascript', '-e', `tell application "${terminalApp}" to activate`]))) {
    return { action: 'activated-terminal', resumeCommand };
  }
  return { action: 'copy-fallback', resumeCommand };
}
