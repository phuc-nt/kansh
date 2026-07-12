// Node color/label mapping for the git-graph. Category logic lives in the
// framework-free tool-category-mapping module (shared with the timeline).

import type { NormalizedEvent } from '../../shared/normalized-event-types';
import { CATEGORY_COLORS, toolCategory } from '../tool-category-mapping';

export { CATEGORY_COLORS, toolCategory };
export type { ToolCategory } from '../tool-category-mapping';

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
