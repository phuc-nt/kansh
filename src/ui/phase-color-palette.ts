// Fixed colors for the workflow phase buckets — a named map (not index-based)
// because the phase set is small and stable, so each phase keeps one identity
// across every card. Kept close to the skill's felt "mood".

import type { PhaseKey } from './workflow-graph-engine';

export const PHASE_COLOR: Record<PhaseKey, string> = {
  brainstorm: '#b48cff', // ideation — violet
  'mk-plan': '#4da3ff', // planning — blue
  cook: '#3ddc84', // building — green
  review: '#f5a623', // scrutiny — amber
  research: '#4dd0e1', // gathering — cyan
  journal: '#8e99a8', // wrap-up — slate
  other: '#5a6472', // misc — grey
};
