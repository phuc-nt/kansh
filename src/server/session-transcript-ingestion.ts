// Coordinates discovery, tailing, and parsing into the state store.
// Watches the projects root for appends; a periodic rescan catches anything
// fs.watch misses (new project dirs, missed events) and evicts sessions that
// fell out of the history window so the daemon stays memory-bounded.

import { watch, type FSWatcher } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { ParsedEvent } from './transcript-record-parser';
import {
  CLAUDE_PROJECTS_ROOT,
  discoverRecentSessions,
  listSubagentTranscripts,
} from './session-discovery';
import { JsonlIncrementalTailer } from './jsonl-incremental-tailer';
import { extractSessionMeta, parseTranscriptRecord } from './transcript-record-parser';
import type { SessionStateStore } from './session-state-store';
import type { EventDetailReader } from './event-detail-reader';

/** Sessions whose transcript changed within this window are loaded. */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** On startup, replay at most this many trailing bytes of each transcript. */
const REPLAY_TAIL_BYTES = 512 * 1024;
/** Safety-net rescan interval (fs.watch is the primary signal). */
const RESCAN_INTERVAL_MS = 10_000;
/** meta.json may land shortly after the subagent jsonl — retry briefly. */
const META_RETRY_DELAYS_MS = [300, 700, 1500];
/** Per-session cap of remembered tool-end ids (for spawn/closure matching). */
const MAX_SEEN_TOOL_ENDS = 500;

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const SUBAGENT_FILE_RE = /^agent-([0-9a-f]+)\.jsonl$/;

interface SubagentMetaFile {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

interface OpenSpawn {
  sessionId: string;
  agentId: string;
}

export class SessionTranscriptIngestion {
  private tailer = new JsonlIncrementalTailer();
  private watcher: FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  /** toolUseId -> spawn info for subagents whose branch is still open */
  private openSubagentSpawns = new Map<string, OpenSpawn>();
  /** sessionId -> recently seen main-lane tool-end ids (toolUseId -> ts) */
  private seenToolEnds = new Map<string, Map<string, string>>();
  /** sessionId -> transcript paths, for releasing tailer state on eviction */
  private sessionPaths = new Map<string, Set<string>>();
  /** serialize per-file reads so concurrent watch events don't interleave offsets */
  private inFlight = new Map<string, Promise<void>>();
  /** per-file usage dedupe cells (message.id spans multiple records) */
  private usageDedupeByPath = new Map<string, { lastMessageId: string }>();

  constructor(
    private store: SessionStateStore,
    private root = CLAUDE_PROJECTS_ROOT,
    private detailReader?: EventDetailReader,
  ) {}

  async start(): Promise<void> {
    await this.rescan(true);
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename) void this.onWatchEvent(filename.toString());
      });
    } catch (error) {
      console.error('[ingestion] fs.watch failed, relying on rescan only:', error);
    }
    this.rescanTimer = setInterval(() => void this.rescan(false), RESCAN_INTERVAL_MS);
  }

  stop(): void {
    this.watcher?.close();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
  }

  /** Discover sessions, ingest new content, evict sessions past the window. */
  private async rescan(isStartup: boolean): Promise<void> {
    const sessions = await discoverRecentSessions(HISTORY_WINDOW_MS, this.root);
    for (const session of sessions) {
      const isNew = !this.store.has(session.sessionId);
      if (isNew) {
        this.store.addSession(session.sessionId, session.project, session.mtimeMs, isStartup);
      }
      const quiet = isStartup && isNew;
      // Subagent files FIRST: their spawn registrations must exist before the
      // main lane's tool-end records are consumed, or branches never close.
      for (const subPath of await listSubagentTranscripts(session.subagentsDir)) {
        await this.ingestFile(subPath, quiet);
      }
      await this.ingestFile(session.transcriptPath, quiet);
    }
    this.evictExpiredSessions();
  }

  /** Release all per-session state for sessions the store no longer holds. */
  private evictExpiredSessions(): void {
    const evicted = this.store.evictSessionsOlderThan(HISTORY_WINDOW_MS);
    for (const sessionId of evicted) {
      for (const path of this.sessionPaths.get(sessionId) ?? []) {
        this.tailer.untrack(path);
        this.inFlight.delete(path);
        this.usageDedupeByPath.delete(path);
      }
      this.sessionPaths.delete(sessionId);
      this.seenToolEnds.delete(sessionId);
      for (const [toolUseId, spawn] of this.openSubagentSpawns) {
        if (spawn.sessionId === sessionId) this.openSubagentSpawns.delete(toolUseId);
      }
    }
  }

  /** Route a raw fs.watch filename (relative to the root) to its transcript. */
  private async onWatchEvent(relativePath: string): Promise<void> {
    const name = basename(relativePath);
    if (!SESSION_FILE_RE.test(name) && !SUBAGENT_FILE_RE.test(name)) return;
    const fullPath = join(this.root, relativePath);
    // New session file may appear before any rescan registered it.
    const identity = this.identify(fullPath);
    if (identity && !this.store.has(identity.sessionId)) {
      this.store.addSession(identity.sessionId, identity.project, Date.now());
    }
    await this.ingestFile(fullPath, false);
  }

  /** Derive session/agent identity from a transcript path. */
  private identify(
    path: string,
  ): { sessionId: string; project: string; agentId: string | null } | null {
    const name = basename(path);
    if (!path.startsWith(this.root + sep)) return null;
    const relative = path.slice(this.root.length + 1);
    const project = relative.split(sep)[0];

    if (SESSION_FILE_RE.test(name)) {
      return { sessionId: name.replace(/\.jsonl$/, ''), project, agentId: null };
    }
    const subMatch = SUBAGENT_FILE_RE.exec(name);
    if (subMatch && dirname(path).endsWith('subagents')) {
      // .../<project>/<sessionId>/subagents/agent-<id>.jsonl
      const sessionId = basename(dirname(dirname(path)));
      return { sessionId, project, agentId: subMatch[1] };
    }
    return null;
  }

  /** Tail a transcript file and apply parsed events to the store (serialized per file). */
  private async ingestFile(path: string, quiet: boolean): Promise<void> {
    const previous = this.inFlight.get(path) ?? Promise.resolve();
    const task = previous.then(() => this.ingestFileSerialized(path, quiet)).catch(() => {});
    this.inFlight.set(path, task);
    await task;
    // release the map entry once settled (unless a newer read already queued)
    if (this.inFlight.get(path) === task) this.inFlight.delete(path);
  }

  private async ingestFileSerialized(path: string, quiet: boolean): Promise<void> {
    const identity = this.identify(path);
    if (!identity || !this.store.has(identity.sessionId)) return;

    if (!this.tailer.has(path)) {
      // First sight: replay only the tail of large files to bound startup cost.
      let fromByte = 0;
      try {
        const size = (await stat(path)).size;
        if (size > REPLAY_TAIL_BYTES) fromByte = size - REPLAY_TAIL_BYTES;
      } catch {
        return;
      }
      await this.tailer.track(path, fromByte);
      let paths = this.sessionPaths.get(identity.sessionId);
      if (!paths) this.sessionPaths.set(identity.sessionId, (paths = new Set()));
      paths.add(path);
      if (identity.agentId) {
        await this.emitSubagentSpawn(path, identity.sessionId, identity.agentId, quiet);
      }
    }

    const records = await this.tailer.readNew(path);
    if (records.length === 0) return;
    // Use the file's real mtime, not wall-clock: startup replay reads old
    // content and must not make historical sessions look freshly active.
    try {
      this.store.markAppend(identity.sessionId, (await stat(path)).mtimeMs);
    } catch {
      // file vanished mid-read; skip activity bump
    }

    let usageDedupe = this.usageDedupeByPath.get(path);
    if (!usageDedupe) this.usageDedupeByPath.set(path, (usageDedupe = { lastMessageId: '' }));

    const events: ParsedEvent[] = [];
    for (const { record, byteStart, byteEnd } of records) {
      this.store.applyMeta(identity.sessionId, extractSessionMeta(record));
      const parsed = parseTranscriptRecord(record, {
        sessionId: identity.sessionId,
        agentId: identity.agentId,
        usageDedupe,
      });
      // every event from this record resolves detail to the same byte range
      for (const event of parsed) {
        this.detailReader?.register(event.uuid, { path, byteStart, byteEnd });
      }
      events.push(...parsed);
    }

    // A tool-end matching an open subagent spawn closes that branch. Runs for
    // EVERY lane: a depth-2 agent's Task tool-end lives in its parent AGENT's
    // transcript, not main. Tool-ends are also remembered (bounded) so a spawn
    // that registers late — replay ordering or slow meta.json — still closes.
    const closures: ParsedEvent[] = [];
    for (const event of events) {
      if (event.kind !== 'tool-end' || !event.toolUseId) continue;
      this.rememberToolEnd(identity.sessionId, event.toolUseId, event.ts);
      const closure = this.closeSpawnIfOpen(identity.sessionId, event.toolUseId, event.ts, event.uuid);
      if (closure) closures.push(closure);
    }

    this.store.applyEvents(identity.sessionId, [...events, ...closures], quiet);
  }

  private rememberToolEnd(sessionId: string, toolUseId: string, ts: string): void {
    let seen = this.seenToolEnds.get(sessionId);
    if (!seen) this.seenToolEnds.set(sessionId, (seen = new Map()));
    seen.set(toolUseId, ts);
    if (seen.size > MAX_SEEN_TOOL_ENDS) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  private closeSpawnIfOpen(
    sessionId: string,
    toolUseId: string,
    ts: string,
    sourceUuid: string,
  ): ParsedEvent | null {
    const spawn = this.openSubagentSpawns.get(toolUseId);
    if (!spawn || spawn.sessionId !== sessionId) return null;
    this.openSubagentSpawns.delete(toolUseId);
    return {
      sessionId,
      agentId: spawn.agentId,
      ts,
      uuid: `${sourceUuid}:subagent-end`,
      kind: 'subagent-end',
      toolUseId,
    };
  }

  /** Read agent-<id>.meta.json (with brief retries) and emit the branch-out event. */
  private async emitSubagentSpawn(
    transcriptPath: string,
    sessionId: string,
    agentId: string,
    quiet: boolean,
  ): Promise<void> {
    const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');
    let meta: SubagentMetaFile = {};
    // meta.json can land moments after the jsonl; without toolUseId the branch
    // can never merge back, so a short retry is worth the wait (live only).
    const attempts = quiet ? 1 : META_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8')) as SubagentMetaFile;
        break;
      } catch {
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, META_RETRY_DELAYS_MS[attempt]));
        }
      }
    }

    let ts = new Date().toISOString();
    try {
      ts = new Date((await stat(transcriptPath)).birthtimeMs).toISOString();
    } catch {
      // keep fallback timestamp
    }

    const spawnEvent: ParsedEvent = {
      sessionId,
      agentId,
      ts,
      uuid: `spawn-${agentId}`,
      kind: 'subagent-spawn',
      toolUseId: meta.toolUseId,
      agentType: meta.agentType,
      spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : undefined,
      label: meta.description,
    };

    // Spawn events are synthetic (no transcript record) — give the detail
    // panel the meta plus the sub-agent's opening prompt.
    if (this.detailReader) {
      let firstPrompt: string | undefined;
      try {
        const head = Buffer.alloc(8192);
        const fh = await open(transcriptPath, 'r');
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        await fh.close();
        const firstLine = head.subarray(0, bytesRead).toString('utf8').split('\n')[0];
        const firstRecord = JSON.parse(firstLine) as { message?: { content?: unknown } };
        const content = firstRecord.message?.content;
        if (typeof content === 'string') firstPrompt = content;
        else if (Array.isArray(content)) {
          const textBlock = content.find(
            (b): b is { type: string; text: string } =>
              typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
          );
          firstPrompt = textBlock?.text;
        }
      } catch {
        // partial first line or unreadable — meta alone is still useful
      }
      this.detailReader.registerSynthetic(spawnEvent.uuid, {
        subagent: { agentId, ...meta },
        firstPrompt,
      });
    }

    // If the parent's tool-end was already consumed (replay ordering), close immediately.
    let closure: ParsedEvent | null = null;
    if (meta.toolUseId) {
      const endTs = this.seenToolEnds.get(sessionId)?.get(meta.toolUseId);
      if (endTs !== undefined) {
        closure = {
          sessionId,
          agentId,
          ts: endTs,
          uuid: `spawn-${agentId}:subagent-end`,
          kind: 'subagent-end',
          toolUseId: meta.toolUseId,
        };
      } else {
        this.openSubagentSpawns.set(meta.toolUseId, { sessionId, agentId });
      }
    }

    this.store.applyEvents(sessionId, closure ? [spawnEvent, closure] : [spawnEvent], quiet);
  }
}
