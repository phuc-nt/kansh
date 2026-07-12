// Provenance parsing: title records, toolUseResult file shapes, skill
// attribution, denial/hook friction. Fixtures mirror REAL record shapes
// captured from ~/.claude transcripts (format is not public — defensive).

import { describe, expect, test } from 'bun:test';
import { extractSessionMeta, parseTranscriptRecord } from './transcript-record-parser';

const CTX = { sessionId: 's1', agentId: null };

describe('title records', () => {
  test('ai-title and custom-title surface as session meta', () => {
    expect(extractSessionMeta({ type: 'ai-title', sessionId: 's1', aiTitle: 'Build monitor' })).toEqual({
      aiTitle: 'Build monitor',
    });
    expect(extractSessionMeta({ type: 'custom-title', sessionId: 's1', customTitle: 'kansh' })).toEqual({
      customTitle: 'kansh',
    });
  });

  test('malformed title records yield nothing', () => {
    expect(extractSessionMeta({ type: 'ai-title', aiTitle: 42 })).toEqual({});
    expect(extractSessionMeta({ type: 'custom-title' })).toEqual({});
  });
});

describe('file touches from toolUseResult', () => {
  const toolResultRecord = (toolUseResult: unknown) => ({
    type: 'user',
    uuid: 'r1',
    timestamp: '2026-07-12T10:00:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
    toolUseResult,
  });

  test('write shapes (create/update/oldString) classify as edit', () => {
    for (const tr of [
      { type: 'create', filePath: '/p/a.ts', content: '...' },
      { type: 'update', filePath: '/p/a.ts', content: '...' },
      { filePath: '/p/a.ts', oldString: 'x', newString: 'y', structuredPatch: [] },
    ]) {
      const [end] = parseTranscriptRecord(toolResultRecord(tr), CTX);
      expect(end.fileTouch).toEqual({ path: '/p/a.ts', action: 'edit' });
    }
  });

  test('Read shape (file.filePath) classifies as read', () => {
    const [end] = parseTranscriptRecord(
      toolResultRecord({ type: 'text', file: { filePath: '/p/b.ts', numLines: 3 } }),
      CTX,
    );
    expect(end.fileTouch).toEqual({ path: '/p/b.ts', action: 'read' });
  });

  test('unknown shapes are skipped (bash output, plan results, strings)', () => {
    for (const tr of [
      { stdout: 'ok', stderr: '' },
      { filePath: '/p/plan.md', plan: '...', planWasEdited: false }, // ExitPlanMode-ish
      'Error: something',
      undefined,
    ]) {
      const [end] = parseTranscriptRecord(toolResultRecord(tr), CTX);
      expect(end.fileTouch).toBeUndefined();
    }
  });
});

describe('friction', () => {
  test('toolDenialKind attaches blocked to the tool-end with reason', () => {
    const [end] = parseTranscriptRecord(
      {
        type: 'user',
        uuid: 'r2',
        timestamp: '2026-07-12T10:00:47.226Z',
        toolDenialKind: 'permission-rule',
        toolUseResult: 'Error: PreToolUse:Bash hook error: BLOCKED: Access denied',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true }] },
      },
      CTX,
    );
    expect(end.kind).toBe('tool-end');
    expect(end.blocked?.kind).toBe('permission-rule');
    expect(end.blocked?.reason).toContain('BLOCKED');
  });

  test('system record with preventedContinuation emits a blocked event', () => {
    const events = parseTranscriptRecord(
      {
        type: 'system',
        subtype: 'stop_hook_summary',
        uuid: 'r3',
        timestamp: '2026-07-12T09:30:59.575Z',
        hookErrors: [],
        preventedContinuation: true,
        stopReason: 'tests failed',
      },
      CTX,
    );
    expect(events).toHaveLength(1);
    expect(events[0].blocked).toEqual({ kind: 'hook-block', reason: 'tests failed' });
    expect(events[0].label).toContain('tests failed');
  });

  test('benign system records (hooks ran fine) yield nothing', () => {
    expect(
      parseTranscriptRecord(
        {
          type: 'system',
          subtype: 'stop_hook_summary',
          uuid: 'r4',
          timestamp: '2026-07-12T09:30:59.575Z',
          hookErrors: [],
          preventedContinuation: false,
          stopReason: '',
        },
        CTX,
      ),
    ).toHaveLength(0);
  });
});

describe('skill attribution', () => {
  test('attributionSkill rides tool-start events', () => {
    const events = parseTranscriptRecord(
      {
        type: 'assistant',
        uuid: 'r5',
        timestamp: '2026-07-12T10:01:00.000Z',
        attributionSkill: 'cook',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu3', name: 'Edit', input: { file_path: '/p/a.ts' } }],
        },
      },
      CTX,
    );
    expect(events[0].kind).toBe('tool-start');
    expect(events[0].skill).toBe('cook');
  });
});
