// Tool -> visual category mapping, framework-free so both layout engines
// (git-graph and timeline) can use it without pulling in React.

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
