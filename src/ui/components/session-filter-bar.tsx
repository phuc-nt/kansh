// Filter controls: hide-ended toggle + project selector.

export interface SessionFilters {
  hideEnded: boolean;
  project: string; // '' = all
}

export function SessionFilterBar({
  filters,
  projects,
  onChange,
}: {
  filters: SessionFilters;
  projects: string[];
  onChange: (next: SessionFilters) => void;
}) {
  return (
    <div className="filter-bar">
      <label>
        <input
          type="checkbox"
          checked={filters.hideEnded}
          onChange={(e) => onChange({ ...filters, hideEnded: e.target.checked })}
        />
        hide ended
      </label>
      <select value={filters.project} onChange={(e) => onChange({ ...filters, project: e.target.value })}>
        <option value="">all projects</option>
        {projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </div>
  );
}
