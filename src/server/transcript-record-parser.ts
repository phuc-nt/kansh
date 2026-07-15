// Maps raw transcript JSONL records to NormalizedEvents.
// Defensive by design: anything unrecognized yields no events instead of throwing.
// One record can yield several events (e.g. an assistant turn with multiple tool_use blocks).

import type { NormalizedEvent, TodoItem } from '../shared/normalized-event-types';

/** Parser output: `seq` is assigned later by the state store in apply order. */
export type ParsedEvent = Omit<NormalizedEvent, 'seq'>;

const LABEL_MAX = 120;

/** Synthetic slash-command plumbing that would pollute the graph as fake user turns. */
const NOISE_TEXT_RE =
  /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|user-prompt-submit-hook)|\[Request interrupted)/;

export interface ParseContext {
  sessionId: string;
  /** null when parsing the main transcript; agent id when parsing a subagent file */
  agentId: string | null;
  /**
   * Per-file dedupe cell owned by the caller: Claude Code writes one record
   * per content block, all repeating the same message.id and identical usage.
   * Usage is attached only when message.id changes, or totals inflate ~2x.
   */
  usageDedupe?: { lastMessageId: string };
}

/** Session metadata scraped from any record that carries it. */
export interface SessionMetaFields {
  cwd?: string;
  slug?: string;
  entrypoint?: string;
  version?: string;
  /** Claude Code's generated session title (latest wins) */
  aiTitle?: string;
  /** user-set session title (latest wins, beats aiTitle) */
  customTitle?: string;
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > LABEL_MAX ? oneLine.slice(0, LABEL_MAX) + '…' : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** TodoWrite input.todos → validated TodoItem[] (cap 20). Bad shape → undefined. */
function parseTodosInput(input: unknown): TodoItem[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const todos: TodoItem[] = [];
  for (const raw of input.todos.slice(0, 20)) {
    if (!isRecord(raw) || typeof raw.content !== 'string') continue;
    const status = raw.status === 'in_progress' || raw.status === 'completed' ? raw.status : 'pending';
    todos.push({
      content: truncate(raw.content),
      status,
      activeForm: typeof raw.activeForm === 'string' ? truncate(raw.activeForm) : undefined,
    });
  }
  return todos.length > 0 ? todos : undefined;
}

/** AskUserQuestion input → first question text. */
function parseQuestionInput(input: unknown): string | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions)) return undefined;
  const first = input.questions[0];
  return isRecord(first) && typeof first.question === 'string' ? truncate(first.question) : undefined;
}

/** Short label for a tool call from its input (file path, command, prompt...). */
function toolInputLabel(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const candidate =
    input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? input.prompt;
  return typeof candidate === 'string' ? truncate(candidate) : undefined;
}

export function extractSessionMeta(record: unknown): SessionMetaFields {
  if (!isRecord(record)) return {};
  const meta: SessionMetaFields = {};
  if (typeof record.cwd === 'string') meta.cwd = record.cwd;
  if (typeof record.slug === 'string') meta.slug = record.slug;
  if (typeof record.entrypoint === 'string') meta.entrypoint = record.entrypoint;
  if (typeof record.version === 'string') meta.version = record.version;
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string') meta.aiTitle = record.aiTitle;
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
    meta.customTitle = record.customTitle;
  }
  return meta;
}

/**
 * Classify the record-level toolUseResult into a file touch.
 * Two shapes observed in real transcripts (format is not public — skip unknowns):
 *   write tools: `{filePath, type: 'create'|'update'}` or `{filePath, oldString, ...}` (Edit)
 *   Read:        `{file: {filePath, ...}}`
 */
function parseFileTouch(result: unknown): { path: string; action: 'edit' | 'read' } | undefined {
  if (!isRecord(result)) return undefined;
  if (
    typeof result.filePath === 'string' &&
    (result.type === 'create' || result.type === 'update' || 'oldString' in result)
  ) {
    return { path: result.filePath, action: 'edit' };
  }
  if (isRecord(result.file) && typeof result.file.filePath === 'string') {
    return { path: result.file.filePath, action: 'read' };
  }
  return undefined;
}

export function parseTranscriptRecord(record: unknown, ctx: ParseContext): ParsedEvent[] {
  if (!isRecord(record)) return [];
  // Meta records (slash-command plumbing, injected context) are not real turns.
  if (record.isMeta === true) return [];
  const ts = typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString();
  const uuid = typeof record.uuid === 'string' ? record.uuid : crypto.randomUUID();
  const base = { sessionId: ctx.sessionId, agentId: ctx.agentId, ts };

  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;

  if (record.type === 'user') {
    // User records carry real user input and/or tool_result blocks
    // (tool results round-trip through a synthetic user turn).
    if (Array.isArray(content)) {
      const events: ParsedEvent[] = [];
      let userText = '';
      // record-level enrichments apply to this record's tool_result (one per record)
      const fileTouch = parseFileTouch(record.toolUseResult);
      const blocked =
        typeof record.toolDenialKind === 'string'
          ? {
              kind: record.toolDenialKind,
              reason:
                typeof record.toolUseResult === 'string'
                  ? truncate(record.toolUseResult)
                  : undefined,
            }
          : undefined;
      let firstToolEnd = true;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          events.push({
            ...base,
            uuid: `${uuid}:${block.tool_use_id}`,
            kind: 'tool-end',
            toolUseId: block.tool_use_id,
            isError: block.is_error === true || undefined,
            fileTouch: firstToolEnd ? fileTouch : undefined,
            blocked: firstToolEnd ? blocked : undefined,
          });
          firstToolEnd = false;
        } else if (block.type === 'text' && typeof block.text === 'string') {
          userText += block.text;
        }
      }
      if (userText.trim() && !NOISE_TEXT_RE.test(userText)) {
        events.push({ ...base, uuid, kind: 'user-message', label: truncate(userText) });
      }
      return events;
    }
    if (typeof content === 'string' && content.trim() && !NOISE_TEXT_RE.test(content)) {
      return [{ ...base, uuid, kind: 'user-message', label: truncate(content) }];
    }
    return [];
  }

  if (record.type === 'assistant' && Array.isArray(content)) {
    const events: ParsedEvent[] = [];
    // token usage + model attach once per message.id (see ParseContext note):
    // multiple records share one message, so per-record attach double-counts
    const usageRaw = isRecord(message?.usage) ? message.usage : undefined;
    const messageId = typeof message?.id === 'string' ? message.id : undefined;
    const isNewMessage =
      !ctx.usageDedupe || messageId === undefined || ctx.usageDedupe.lastMessageId !== messageId;
    const turnInfo: Pick<ParsedEvent, 'usage' | 'model'> = {};
    if (usageRaw && isNewMessage) {
      turnInfo.usage = {
        in: typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : 0,
        out: typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : 0,
        cacheRead: typeof usageRaw.cache_read_input_tokens === 'number' ? usageRaw.cache_read_input_tokens : 0,
        cacheCreation:
          typeof usageRaw.cache_creation_input_tokens === 'number' ? usageRaw.cache_creation_input_tokens : 0,
      };
    }
    if (typeof message?.model === 'string') turnInfo.model = message.model;
    const skill = typeof record.attributionSkill === 'string' ? record.attributionSkill : undefined;
    let assistantText = '';
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const toolName = typeof block.name === 'string' ? block.name : 'unknown';
        events.push({
          ...base,
          uuid: `${uuid}:${block.id}`,
          kind: 'tool-start',
          toolName,
          toolUseId: block.id,
          skill,
          label: toolInputLabel(block.input),
          // semantic payloads: task list / pending question ride the event
          todos: toolName === 'TodoWrite' ? parseTodosInput(block.input) : undefined,
          question: toolName === 'AskUserQuestion' ? parseQuestionInput(block.input) : undefined,
        });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        assistantText += block.text;
      }
    }
    // Represent the text part as one event, before tool calls of the same turn.
    if (assistantText.trim()) {
      events.unshift({ ...base, uuid, kind: 'assistant-message', label: truncate(assistantText) });
    }
    // attach turn usage/model to the first event only; mark the message id
    // consumed ONLY when something was actually attached, so usage carried by
    // an event-less record (e.g. thinking-only) survives to the next record
    // of the same message that does yield events
    if (events.length > 0 && (turnInfo.usage || turnInfo.model)) {
      events[0] = { ...events[0], ...turnInfo };
      if (turnInfo.usage && ctx.usageDedupe && messageId !== undefined) {
        ctx.usageDedupe.lastMessageId = messageId;
      }
    }
    return events;
  }

  // system records: hooks that actually blocked continuation surface as friction
  if (record.type === 'system') {
    const hookErrors = Array.isArray(record.hookErrors) ? record.hookErrors : [];
    if (record.preventedContinuation === true || hookErrors.length > 0) {
      const reason =
        typeof record.stopReason === 'string' && record.stopReason
          ? record.stopReason
          : typeof hookErrors[0] === 'string'
            ? hookErrors[0]
            : undefined;
      return [
        {
          ...base,
          uuid,
          kind: 'assistant-message',
          label: truncate(`⛔ hook chặn${reason ? `: ${reason}` : ''}`),
          blocked: { kind: 'hook-block', reason: reason ? truncate(reason) : undefined },
        },
      ];
    }
    return [];
  }

  // queue-operation, attachment, summary, hooks, unknown future types: ignored.
  return [];
}
