// Shared per-lane color identity: attention-ribbon diamonds and the lane
// label chips must agree, so both read from this palette by lane index.

export const LANE_PALETTE = [
  '#4da3ff',
  '#f5a623',
  '#3ddc84',
  '#ff6b9d',
  '#b48cff',
  '#4dd0e1',
  '#ffd54f',
  '#e05555',
];

export function laneColor(laneIndex: number): string {
  return LANE_PALETTE[laneIndex % LANE_PALETTE.length];
}
