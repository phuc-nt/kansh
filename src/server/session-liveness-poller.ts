// Polls `ps` to learn which claude processes are alive. Sessions are tied to
// processes two ways: explicitly via `--resume <session-id>` / `-r <id>` on the
// command line, or — for fresh sessions — by matching the process working
// directory (via lsof) against the session's cwd.

export interface LivenessSample {
  /** session ids explicitly resumed by a running claude process */
  resumedSessionIds: Set<string>;
  /** working directories of claude processes NOT tied to a session id */
  freshProcessCwds: Set<string>;
  /** total running claude processes (resumed or not) */
  claudeProcessCount: number;
}

const RESUME_RE = /(?:--resume|-r)\s+([0-9a-f-]{36})/;

async function spawnText(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' });
  return await new Response(proc.stdout).text();
}

/** Working directories for the given pids, via `lsof -d cwd`. Best-effort. */
async function lookupProcessCwds(pids: number[]): Promise<Set<string>> {
  const cwds = new Set<string>();
  if (pids.length === 0) return cwds;
  try {
    const output = await spawnText(['lsof', '-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']);
    for (const line of output.split('\n')) {
      if (line.startsWith('n')) cwds.add(line.slice(1));
    }
  } catch {
    // lsof unavailable/failed — fresh sessions fall back to mtime-only classification
  }
  return cwds;
}

export async function sampleClaudeProcesses(): Promise<LivenessSample> {
  const resumedSessionIds = new Set<string>();
  const freshPids: number[] = [];
  let claudeProcessCount = 0;

  try {
    const output = await spawnText(['ps', '-axo', 'pid=,command=']);
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pidText, command] = match;
      // match the claude CLI binary, not this monitor or unrelated commands
      if (!/(^|\/)claude(\s|$)/.test(command)) continue;
      claudeProcessCount++;
      const resume = RESUME_RE.exec(command);
      if (resume) {
        resumedSessionIds.add(resume[1]);
      } else {
        freshPids.push(Number(pidText));
      }
    }
  } catch {
    // ps failure: return empty sample; mtime heuristic still classifies sessions
  }

  const freshProcessCwds = await lookupProcessCwds(freshPids);
  return { resumedSessionIds, freshProcessCwds, claudeProcessCount };
}

/** Repeatedly sample and hand results to a callback. Returns a stop function. */
export function startLivenessPolling(
  intervalMs: number,
  onSample: (sample: LivenessSample) => void,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    onSample(await sampleClaudeProcesses());
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
