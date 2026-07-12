// Header control switching between the card grid and the global timeline.

export type ViewMode = 'cards' | 'timeline';

export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="view-mode-toggle" role="tablist" aria-label="view mode">
      <button
        role="tab"
        aria-selected={mode === 'cards'}
        className={mode === 'cards' ? 'active' : ''}
        onClick={() => onChange('cards')}
      >
        ▦ cards
      </button>
      <button
        role="tab"
        aria-selected={mode === 'timeline'}
        className={mode === 'timeline' ? 'active' : ''}
        onClick={() => onChange('timeline')}
      >
        ⇶ timeline
      </button>
    </div>
  );
}
