// The card's primary content: what the session is doing (mission), how far
// along (todo progress), whether it's healthy (error/loop badges), and what it
// needs from the user (pending question + how long it's been waiting).
// Presentational only — all fields come from SessionSummary.

import { memo, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';

function waitingMinutes(lastActivityAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(lastActivityAt)) / 60000));
}

export const SessionSemanticSummary = memo(function SessionSemanticSummary({
  session,
  nowMinuteMs,
}: {
  session: SessionSnapshot;
  /** minute-granular timestamp from the card's ticker (memo-busts per minute) */
  nowMinuteMs: number;
}) {
  const [todosOpen, setTodosOpen] = useState(false);

  const todos = session.todos ?? [];
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  const isWaiting = session.status === 'waiting';
  const waitedMin = isWaiting ? waitingMinutes(session.lastActivityAt, nowMinuteMs) : 0;

  return (
    <div className="semantic-summary">
      {session.mission ? (
        <div className="semantic-mission" title={session.mission}>
          🎯 {session.mission}
        </div>
      ) : null}

      {todos.length > 0 ? (
        <div
          className="semantic-progress"
          onClick={() => setTodosOpen((open) => !open)}
          title="click để xem danh sách task"
        >
          <span className="semantic-current">
            ▶ {current?.activeForm ?? current?.content ?? (done === todos.length ? 'hoàn tất' : '—')}
          </span>
          <span className="todo-bar">
            <span className="todo-bar-fill" style={{ width: `${(done / todos.length) * 100}%` }} />
          </span>
          <span className="todo-count">
            {done}/{todos.length}
          </span>
        </div>
      ) : null}
      {todosOpen && todos.length > 0 ? (
        <ul className="todo-list">
          {todos.map((t, i) => (
            <li key={i} className={`todo-${t.status}`}>
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'} {t.content}
            </li>
          ))}
        </ul>
      ) : null}

      {session.errorStreak >= 2 || session.loopSuspect ? (
        <div className="semantic-health">
          {session.errorStreak >= 2 ? (
            <span className="health-badge" title="số tool_result lỗi liên tiếp gần nhất (heuristic)">
              ⚠ {session.errorStreak} lỗi liên tiếp
            </span>
          ) : null}
          {session.loopSuspect ? (
            <span className="health-badge" title="cùng một tool+tham số lặp lại nhiều lần gần đây (gợi ý, có thể bình thường)">
              🔁 lặp: {session.loopSuspect}
            </span>
          ) : null}
        </div>
      ) : null}

      {isWaiting ? (
        <div className="semantic-waiting">
          ⏸{' '}
          {session.pendingQuestion ? (
            <span className="waiting-question" title={session.pendingQuestion}>
              đang hỏi: “{session.pendingQuestion}”
            </span>
          ) : (
            <span>{session.waitingReason === 'permission' ? 'chờ permission?' : 'chờ bạn trả lời'}</span>
          )}
          {waitedMin >= 1 ? <span className="waiting-duration"> · chờ {waitedMin}m</span> : null}
        </div>
      ) : null}
    </div>
  );
});
