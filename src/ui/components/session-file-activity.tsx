// File activity expander: which files this session is working on and how hard.
// Presentational; data comes from session.filesTouched (already capped+sorted).

import { memo, useState } from 'react';
import type { FileTouch } from '../../shared/normalized-event-types';

const MAX_ROWS = 10;

/** Path relative to the session cwd when possible; middle-ellipsis via CSS. */
function displayPath(path: string, cwd: string): string {
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1);
  return path;
}

export const SessionFileActivity = memo(function SessionFileActivity({
  filesTouched,
  cwd,
  sessionId,
}: {
  filesTouched: FileTouch[];
  cwd: string;
  sessionId: string;
}) {
  const openKey = `kansh-files-open:${sessionId}`;
  const [open, setOpen] = useState(() => localStorage.getItem(openKey) === '1');
  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem(openKey, o ? '0' : '1');
      return !o;
    });
  };

  return (
    <div className="file-activity">
      <button className="file-activity-toggle" onClick={toggle}>
        {open ? '▴' : '▾'} 📝 {filesTouched.length} files
      </button>
      {open ? (
        <ul className="file-activity-list">
          {filesTouched.slice(0, MAX_ROWS).map((ft) => (
            <li key={ft.path} title={ft.path}>
              <span className="file-path">{displayPath(ft.path, cwd)}</span>
              <span className="file-counts">
                {ft.edits > 0 ? `✎ ${ft.edits}` : ''}
                {ft.edits > 0 && ft.reads > 0 ? ' · ' : ''}
                {ft.reads > 0 ? `👁 ${ft.reads}` : ''}
              </span>
            </li>
          ))}
          {filesTouched.length > MAX_ROWS ? (
            <li className="file-more">+{filesTouched.length - MAX_ROWS} nữa</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
});
