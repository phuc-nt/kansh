# Changelog

All notable changes to **kansh** are documented here. Versions follow [Semantic Versioning](https://semver.org/); dates are YYYY-MM-DD.

## [0.8.0] — 2026-07-15 · Workflow Replay

- **Workflow replay**: pick any task (one per user prompt) and replay it at high speed on the workflow map — phases light up as they happened, the current phase pulses, sub-agent chips fade in when spawned.
- Controls: task selector (prev/next), play/pause, speed (1×/2×/4×/8×), hand scrub bar.
- Playback advances on an interval so it keeps moving in a backgrounded tab.

## [0.7.0] — 2026-07-14 · Workflow Map

- **Per-card workflow map** of the MK agentic flow: typed phase pills (brainstorm → plan → cook → review → journal), edges weighted by loop count, and each phase's spawned sub-agents.
- Scanned from the whole transcript (not just the recent window), so long sessions show their full phase history.

## [0.6.0] — 2026-07-12 · Provenance & Conflict

- Real session titles (Claude Code's own titles) replace folder names.
- File-activity expander (which files a session reads/edits, how often).
- **Cross-session conflict alerts**: a red banner when two live sessions edit the same file within 30 minutes.
- Skill-attribution badge (which workflow phase a session is in) and blocked-tool markers (permission/hook denials).

## [0.5.0] — 2026-07-12 · Timeline Semantics

- Semantic markers on each timeline lane (prompt, error, pending question).
- Waiting stretches (amber hatching where a session sat waiting for you).
- Block hover tooltip + click-to-inspect popover.
- Crosshair scrubber and an attention ribbon plotting every prompt with a switch count.

## [0.4.0] — 2026-07-12 · Semantic Layer

- Semantic-first cards: mission, TodoWrite progress bar, health badges (errors, loop suspicion), and the verbatim pending question.
- Daily digest strip with per-project token totals and estimated cost.

## [0.3.0] — 2026-07-12 · New Perspectives

- Global timeline view: every session as a swimlane on one shared wall-clock axis.
- Sub-sub-agent depth (nested spawn indentation).

## [0.2.0] — 2026-07-12 · Denser & Richer

- Graph compression (condensed runs, idle-gap markers), token/context gauges, durations, and activity sparklines.

## [0.1.0] — 2026-07-12 · Initial release

- Local, read-only dashboard that auto-detects running Claude Code sessions and visualizes each as a live git-graph timeline (main agent per lane, sub-agents branching and merging, tool calls as colored nodes). WebSocket live push; jump-to-session.

[0.8.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.8.0
[0.7.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.7.0
[0.6.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.6.0
[0.5.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.5.0
[0.4.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.4.0
[0.3.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.3.0
[0.2.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.2.0
[0.1.0]: https://github.com/phuc-nt/kansh/releases/tag/v0.1.0
