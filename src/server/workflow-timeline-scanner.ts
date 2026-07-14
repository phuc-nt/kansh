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
import type { WorkflowTimeline } from '../shared/normalized-event-types';

/** Cap the phase sequence so a pathological session can't grow it unbounded. */
const MAX_PHASES = 500;
/** Cap subagent spawns tracked for the tie-in. */
const MAX_SPAWNS = 1000;

interface RawRecord {
  type?: string;
  isSidechain?: boolean;
  attributionSkill?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

/**
 * Scan a main transcript for the main-lane phase transition sequence.
 * Consecutive identical skills are collapsed here already (the sequence only
 * records changes), keeping the payload small.
 */
async function scanPhases(transcriptPath: string): Promise<WorkflowTimeline['phases']> {
  const phases: WorkflowTimeline['phases'] = [];
  let last: string | undefined;
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // prefilter: only assistant records carry attributionSkill
      if (line.indexOf('attributionSkill') === -1) continue;
      let rec: RawRecord;
      try {
        rec = JSON.parse(line) as RawRecord;
      } catch {
        continue;
      }
      if (rec.type !== 'assistant' || rec.isSidechain === true) continue;
      const skill = rec.attributionSkill;
      if (typeof skill !== 'string' || !skill) continue;
      if (skill === last) continue; // collapse consecutive repeats
      phases.push({ skill, ts: typeof rec.timestamp === 'string' ? rec.timestamp : '' });
      last = skill;
      if (phases.length >= MAX_PHASES) break;
    }
  } finally {
    rl.close();
    stream.close();
  }
  return phases;
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

/** Build a compact whole-session workflow timeline (phases + spawns). */
export async function scanWorkflowTimeline(
  transcriptPath: string,
  subagentsDir: string,
): Promise<WorkflowTimeline | undefined> {
  const [phases, spawns] = await Promise.all([
    scanPhases(transcriptPath),
    scanSpawns(subagentsDir),
  ]);
  if (phases.length === 0 && spawns.length === 0) return undefined;
  return { phases, spawns };
}
