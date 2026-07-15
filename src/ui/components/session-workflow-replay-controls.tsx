// Transport for the workflow replay: task selector (one per user prompt),
// play/pause, speed cycle, and a hand scrub bar. Presentational — all state
// lives in the workflow map; this just renders and reports intent.

import { memo } from 'react';
import type { WorkflowTask } from '../../shared/normalized-event-types';

export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const SessionWorkflowReplayControls = memo(function SessionWorkflowReplayControls({
  tasks,
  taskIndex,
  playing,
  speed,
  playheadMs,
  durationMs,
  onPickTask,
  onTogglePlay,
  onCycleSpeed,
  onScrub,
  onExit,
}: {
  tasks: WorkflowTask[];
  taskIndex: number;
  playing: boolean;
  speed: number;
  playheadMs: number;
  durationMs: number;
  onPickTask: (index: number) => void;
  onTogglePlay: () => void;
  onCycleSpeed: () => void;
  onScrub: (ms: number) => void;
  onExit: () => void;
}) {
  const task = tasks[taskIndex];
  return (
    <div className="workflow-replay">
      <div className="replay-task-row">
        <button
          className="replay-btn"
          disabled={taskIndex <= 0}
          onClick={() => onPickTask(taskIndex - 1)}
          aria-label="task trước"
        >
          ◂
        </button>
        <span className="replay-task-label" title={task?.label}>
          {taskIndex + 1}/{tasks.length} · {task?.label ?? ''}
        </span>
        <button
          className="replay-btn"
          disabled={taskIndex >= tasks.length - 1}
          onClick={() => onPickTask(taskIndex + 1)}
          aria-label="task sau"
        >
          ▸
        </button>
        <button className="replay-btn replay-exit" onClick={onExit} aria-label="đóng replay">
          ✕
        </button>
      </div>
      <div className="replay-transport">
        <button className="replay-btn replay-play" onClick={onTogglePlay}>
          {playing ? '⏸' : '⏵'}
        </button>
        <button className="replay-btn replay-speed" onClick={onCycleSpeed} title="tốc độ">
          {speed}×
        </button>
        <input
          className="replay-scrub"
          type="range"
          min={0}
          max={durationMs}
          value={Math.min(playheadMs, durationMs)}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <span className="replay-clock">
          {fmtClock(playheadMs)}/{fmtClock(durationMs)}
        </span>
      </div>
    </div>
  );
});
