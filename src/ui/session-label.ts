// Shared session labeling: Claude Code's own title when present, otherwise
// the working-directory folder name. Cards, digest, and timeline must agree.

import type { SessionSummary } from '../shared/normalized-event-types';

/** Folder name of the session's cwd (fallback: decoded project slug). */
export function projectFolderName(session: Pick<SessionSummary, 'cwd' | 'project'>): string {
  if (session.cwd) return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  return session.project.split('-').filter(Boolean).slice(-2).join('-');
}

/** Primary display label: real session title > folder name. */
export function sessionLabel(
  session: Pick<SessionSummary, 'cwd' | 'project' | 'title'>,
): string {
  return session.title || projectFolderName(session);
}

/** Folder subtitle, only when the title already occupies the primary slot. */
export function sessionSubtitle(
  session: Pick<SessionSummary, 'cwd' | 'project' | 'title'>,
): string | undefined {
  if (!session.title) return undefined;
  const folder = projectFolderName(session);
  return folder === session.title ? undefined : folder;
}
