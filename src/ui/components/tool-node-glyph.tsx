// Node color/category mapping. One place to tune the visual language.

import type { NormalizedEvent } from '../../shared/normalized-event-types';

export type ToolCategory = 'file' | 'shell' | 'web' | 'agent' | 'other';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillBash']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const AGENT_TOOLS = new Set(['Task', 'Agent', 'Skill', 'Workflow']);

export function toolCategory(toolName: string | undefined): ToolCategory {
  if (!toolName) return 'other';
  if (FILE_TOOLS.has(toolName)) return 'file';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (WEB_TOOLS.has(toolName)) return 'web';
  if (AGENT_TOOLS.has(toolName)) return 'agent';
  return 'other';
}

export const CATEGORY_COLORS: Record<ToolCategory, string> = {
  file: '#4da3ff',
  shell: '#f5a623',
  web: '#b06ef7',
  agent: '#ff6b9d',
  other: '#8a93a6',
};

/** Fill color for any event node. */
export function eventColor(event: NormalizedEvent): string {
  switch (event.kind) {
    case 'user-message':
      return '#3ddc84';
    case 'assistant-message':
      return '#c9d1e0';
    case 'subagent-spawn':
    case 'subagent-end':
      return CATEGORY_COLORS.agent;
    case 'tool-start':
    case 'tool-end':
      return CATEGORY_COLORS[toolCategory(event.toolName)];
    default:
      return CATEGORY_COLORS.other;
  }
}

/** Short text shown next to a node. */
export function eventLabel(event: NormalizedEvent): string {
  switch (event.kind) {
    case 'tool-start':
      return event.toolName ?? 'tool';
    case 'tool-end':
      return '';
    case 'subagent-spawn':
      return event.agentType ? `⤷ ${event.agentType}` : '⤷ agent';
    case 'subagent-end':
      return '⤶ done';
    case 'user-message':
      return event.label ?? 'user';
    case 'assistant-message':
      return event.label ?? '';
    default:
      return event.kind;
  }
}
