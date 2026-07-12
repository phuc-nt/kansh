// Discovers Claude Code session transcript files under ~/.claude/projects.
// Read-only: never writes into the claude data directory.

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DiscoveredSession {
  sessionId: string;
  /** project directory slug, e.g. "-Users-phucnt-workspace-kansh" */
  project: string;
  /** absolute path to the main transcript jsonl */
  transcriptPath: string;
  /** absolute path to the subagents dir (may not exist) */
  subagentsDir: string;
  mtimeMs: number;
}

export const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/**
 * Scan all project dirs for session transcripts modified within `windowMs`.
 * Session id is the jsonl basename; subagents live in a sibling dir named after
 * the session id. `root` is injectable for tests; defaults to the real claude dir.
 */
export async function discoverRecentSessions(
  windowMs: number,
  root = CLAUDE_PROJECTS_ROOT,
): Promise<DiscoveredSession[]> {
  const cutoff = Date.now() - windowMs;
  const sessions: DiscoveredSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return []; // no claude data dir on this machine
  }

  for (const project of projectDirs) {
    const projectPath = join(root, project);
    let entries: string[];
    try {
      entries = await readdir(projectPath);
    } catch {
      continue; // not a directory or unreadable
    }

    for (const entry of entries) {
      if (!SESSION_ID_RE.test(entry)) continue;
      const transcriptPath = join(projectPath, entry);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(transcriptPath)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;

      const sessionId = entry.replace(/\.jsonl$/, '');
      sessions.push({
        sessionId,
        project,
        transcriptPath,
        subagentsDir: join(projectPath, sessionId, 'subagents'),
        mtimeMs,
      });
    }
  }

  return sessions;
}

/** List subagent transcript files (agent-*.jsonl) for a session, empty if none. */
export async function listSubagentTranscripts(subagentsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(subagentsDir);
    return entries
      .filter((e) => /^agent-[0-9a-f]+\.jsonl$/.test(e))
      .map((e) => join(subagentsDir, e));
  } catch {
    return [];
  }
}
