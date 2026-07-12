# kansh — Claude Code Session Monitor

Local, read-only dashboard that auto-detects every Claude Code session on this machine and visualizes them as live git-graph timelines: main agent per lane, sub-agents branching out and merging back, tool calls as colored nodes, pulsing when active.

![status] Zero config. No hooks. Never writes to `~/.claude`.

## Run

```bash
bun install
bun run build   # build the UI once
bun run start   # server + UI at http://127.0.0.1:4777
```

Dev mode (UI hot-reload): `bun run start` in one terminal, `bun run dev` in another → http://localhost:5173.

## What you see

- One card per session (live + ended ≤24h, ended dimmed/collapsed).
- Status per session: 🟢 running · ⏸ waiting — with the reason: "chờ permission?" vs "chờ bạn trả lời" (also counted in the page title) · ended.
- Git-graph: user/assistant messages, tool calls colored by category (file/shell/web/agent), sub-agent branches keyed to their spawning `Task` call. Runs of plumbing events condense into `⋮ n` rows (click to expand); long silences show `⏱ idle Xm` markers.
- Header per card: model badge, cumulative ▲in/▼out tokens (deduped per message), context gauge (~% of the model window, amber >70% / red >85%, auto-detects 1M windows), and a 60-minute activity sparkline.
- Running tools show a live `⏱ Ns…` elapsed counter; finished tools show duration on hover.
- Click any node → side panel with the full transcript record (truncated, lazily re-read from disk); spawn nodes show the sub-agent's meta + opening prompt.
- Filter bar: hide ended, filter by project.
- `↗` button: focus the session's window — VSCode workspace via `code <cwd>`, CLI via terminal-app activation, ended sessions copy `claude --resume <id>` to clipboard.
- **Timeline view** (`⇶` toggle, persisted): every session as a swimlane on one shared wall-clock axis — see cross-project concurrency at a glance. 1h/3h/6h presets, drag-pan (clamped at now), live edge with now-line, category-colored activity blocks, sub-agent branch spans (nested depth indented), click a lane to jump to its card.

## How it works

- Tails `~/.claude/projects/<project>/<session-id>.jsonl` (and `<session-id>/subagents/agent-*.jsonl`) incrementally with byte offsets; parses records defensively (unknown types skipped, never crashes).
- Liveness: `ps` poll (resumed session ids + fresh-process cwds via `lsof`) combined with transcript mtime.
- Pushes normalized events over WebSocket; UI is a pure function of the event stream.
- Server binds `127.0.0.1` only and rejects cross-origin/rebound requests (Origin + Host checks).

## Notes

- Transcript JSONL is not a public API — the parser is tolerant, but a Claude Code update may require adjustments.
- First jump-to-terminal may trigger a macOS automation permission prompt (osascript).
- `waiting` state is heuristic (process alive + no appends >15s); permission-prompt detection is a future refinement.
