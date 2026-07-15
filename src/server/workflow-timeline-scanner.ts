// Whole-session workflow scan: the 512KB replay tail of a large session holds
// no main-lane skill records, so the workflow map needs a separate light pass
// over the FULL main transcript. We extract only the compact phase transition
// sequence (skill, ts) plus subagent spawn refs — never whole events — so the
// memory cost is bounded regardless of transcript size.
//
// Cheap by construction: a substring prefilter skips the vast majority of lines
// (tool results, thinking, attachments) before any JSON.parse.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { WorkflowTask, WorkflowTimeline } from '../shared/normalized-event-types';

/** Cap the phase sequence so a pathological session can't grow it unbounded. */
const MAX_PHASES = 500;
/** Cap subagent spawns tracked for the tie-in. */
const MAX_SPAWNS = 1000;
/** Cap replay tasks; keep the newest when a session has more. */
const MAX_TASKS = 200;
const LABEL_MAX = 90;

/** Slash-command plumbing / interrupt markers that aren't real user prompts. */
const NOISE_TEXT_RE =
  /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)|\[Request interrupted)/;

interface RawRecord {
  type?: string;
  isSidechain?: boolean;
  attributionSkill?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > LABEL_MAX ? oneLine.slice(0, LABEL_MAX) + '…' : oneLine;
}

/** Extract a real user text prompt from a user record's content, or undefined. */
function userPromptText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const t = content.trim();
    return t && !NOISE_TEXT_RE.test(t) ? t : undefined;
  }
  if (Array.isArray(content)) {
    let text = '';
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const bt = (block as { text?: unknown }).text;
        if (typeof bt === 'string') text += bt;
      }
    }
    const t = text.trim();
    return t && !NOISE_TEXT_RE.test(t) ? t : undefined;
  }
  return undefined;
}

/**
 * One streaming pass over the main transcript: the phase transition sequence
 * (assistant records carrying attributionSkill, consecutive repeats collapsed)
 * AND the task boundaries (real main-lane user prompts). Both are cheap because
 * a substring prefilter skips lines that carry neither marker before JSON.parse.
 */
async function scanPhasesAndTasks(
  transcriptPath: string,
): Promise<{ phases: WorkflowTimeline['phases']; tasks: WorkflowTask[] }> {
  const phases: WorkflowTimeline['phases'] = [];
  const promptStarts: { ts: string; label: string }[] = [];
  let last: string | undefined;
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const hasSkill = line.indexOf('attributionSkill') !== -1;
      const maybeUser = line.indexOf('"user"') !== -1;
      if (!hasSkill && !maybeUser) continue;
      let rec: RawRecord;
      try {
        rec = JSON.parse(line) as RawRecord;
      } catch {
        continue;
      }
      if (rec.isSidechain === true) continue;

      if (rec.type === 'assistant' && hasSkill) {
        const skill = rec.attributionSkill;
        if (typeof skill === 'string' && skill && skill !== last) {
          phases.push({ skill, ts: typeof rec.timestamp === 'string' ? rec.timestamp : '' });
          last = skill;
        }
      } else if (rec.type === 'user' && promptStarts.length < MAX_TASKS * 4) {
        const prompt = userPromptText(rec.message?.content);
        if (prompt && typeof rec.timestamp === 'string') {
          promptStarts.push({ ts: rec.timestamp, label: truncate(prompt) });
        }
      }
      if (phases.length >= MAX_PHASES && promptStarts.length >= MAX_TASKS) break;
    }
  } finally {
    rl.close();
    stream.close();
  }

  // chain each prompt to the next as its task window; last task closes at the
  // latest ts we observed (a phase or the prompt itself)
  const tipTs =
    phases.length > 0 && phases[phases.length - 1].ts > (promptStarts.at(-1)?.ts ?? '')
      ? phases[phases.length - 1].ts
      : (promptStarts.at(-1)?.ts ?? '');
  const trimmed = promptStarts.slice(-MAX_TASKS);
  const tasks: WorkflowTask[] = trimmed.map((p, i) => ({
    startTs: p.ts,
    endTs: i + 1 < trimmed.length ? trimmed[i + 1].ts : tipTs > p.ts ? tipTs : p.ts,
    label: p.label,
  }));
  return { phases, tasks };
}

/**
 * Collect subagent spawns from the session's subagents dir: each agent-*.jsonl
 * has a sibling .meta.json (agentType, spawnDepth); the jsonl's birthtime is
 * the spawn time. Bounded, read-only, tolerant of missing/partial files.
 */
async function scanSpawns(subagentsDir: string): Promise<WorkflowTimeline['spawns']> {
  const spawns: WorkflowTimeline['spawns'] = [];
  let entries: string[];
  try {
    entries = await readdir(subagentsDir);
  } catch {
    return spawns; // no subagents dir → no spawns
  }
  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue;
    const metaPath = join(subagentsDir, name);
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
        agentType?: string;
        spawnDepth?: number;
      };
      // spawn time = birth of the agent transcript (falls back to meta mtime)
      const jsonlPath = join(subagentsDir, basename(name).replace(/\.meta\.json$/, '.jsonl'));
      let ts = '';
      try {
        ts = new Date((await stat(jsonlPath)).birthtimeMs).toISOString();
      } catch {
        try {
          ts = new Date((await stat(metaPath)).mtimeMs).toISOString();
        } catch {
          // leave ts empty — engine ties it to the latest phase
        }
      }
      spawns.push({
        agentType: typeof meta.agentType === 'string' ? meta.agentType : 'agent',
        ts,
        depth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : 1,
      });
      if (spawns.length >= MAX_SPAWNS) break;
    } catch {
      // unreadable/partial meta — skip
    }
  }
  // spawns are read in directory order; sort by time so phase-tie is correct
  spawns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return spawns;
}

/** Build a compact whole-session workflow timeline (phases + spawns + tasks). */
export async function scanWorkflowTimeline(
  transcriptPath: string,
  subagentsDir: string,
): Promise<WorkflowTimeline | undefined> {
  const [{ phases, tasks }, spawns] = await Promise.all([
    scanPhasesAndTasks(transcriptPath),
    scanSpawns(subagentsDir),
  ]);
  if (phases.length === 0 && spawns.length === 0) return undefined;
  return { phases, spawns, tasks: tasks.length > 0 ? tasks : undefined };
}
