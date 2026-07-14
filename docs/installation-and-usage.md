# Installation & Usage

Complete guide to installing, running, and using **kansh** — a local, read-only dashboard that auto-detects every Claude Code session on your machine and visualizes them live.

- [Requirements](#requirements)
- [Install](#install)
- [Run](#run)
- [Development mode](#development-mode)
- [Configuration](#configuration)
- [Using the dashboard](#using-the-dashboard)
  - [Cards view](#cards-view)
  - [Timeline view](#timeline-view)
  - [Workflow map](#workflow-map)
  - [File activity & conflicts](#file-activity--conflicts)
  - [Jump to a session](#jump-to-a-session)
- [How it works](#how-it-works)
- [Privacy & security](#privacy--security)
- [Troubleshooting](#troubleshooting)

---

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.3 — kansh runs its server and tests on Bun.
- **[Claude Code](https://claude.com/claude-code)** — kansh reads the transcripts Claude Code writes under `~/.claude/projects/`. Nothing to configure on the Claude Code side; no hooks, no plugins.
- **macOS** — liveness detection uses `ps`/`lsof`, and the jump-to-session feature uses macOS app activation. The core dashboard works elsewhere, but those two features are macOS-tuned.
- A modern browser (Chrome, Safari, Firefox, Edge).

## Install

```bash
git clone https://github.com/phuc-nt/kansh
cd kansh
bun install
```

## Run

```bash
bun run build     # build the UI once
bun run start     # start the server + UI
```

Then open **http://127.0.0.1:4777**.

The server watches `~/.claude/projects/` and streams every active (and recently-ended) session to the dashboard. Leave it running in the background — new Claude Code sessions appear automatically.

> Re-run `bun run build` after pulling updates so the served UI matches the latest code.

## Development mode

For UI hot-reload while hacking on kansh:

```bash
# terminal 1 — the data server
bun run start

# terminal 2 — the Vite dev server (hot reload)
bun run dev
```

Open **http://localhost:5173** (the dev server proxies data from the running `start` server). Edits to `src/ui/**` reload instantly.

Other scripts:

| Command | What it does |
| --- | --- |
| `bun test` | Run the unit test suite (pure engines + server state store). |
| `bun run smoke` | Boot the server against fixture transcripts and assert the event pipeline. |

## Configuration

kansh is zero-config by default. The one knob:

| Env var | Default | Purpose |
| --- | --- | --- |
| `KANSH_PORT` | `4777` | Port the server binds on `127.0.0.1`. |

```bash
KANSH_PORT=5000 bun run start   # serve on http://127.0.0.1:5000
```

The observation window is fixed at **24 hours**: sessions whose transcript hasn't changed in that time drop off the dashboard.

## Using the dashboard

The header toggles between two views (**cards** and **timeline**), shows live counts (`N live · M recent · ⏸ K waiting for you`), a 24-hour digest strip (tokens + estimated cost per project), and filters (hide ended, filter by project).

### Cards view

One card per session, answering "what is this session doing?" at a glance:

- **🎯 Mission** — the session's current task (latest real user prompt).
- **▶ Progress** — the in-flight TodoWrite task with a progress bar.
- **Health badges** — `⚠ N errors` (consecutive tool failures), `🔁 loop` (a tool call repeating), `⛔ N blocked` (permission/hook denials).
- **⏸ Waiting** — the verbatim question the session is waiting on, and how long it has waited.
- **Header** — real session title, model badge, cumulative ▲in/▼out tokens, a context-fill gauge (~% of the model window), and a 60-minute activity sparkline.
- **Workflow map** and **file activity** (see below).
- **`▾ xem graph chi tiết`** expander — the full git-graph: user/assistant messages, tool calls colored by category, sub-agent branches keyed to their spawning `Task` call. Dense plumbing collapses into `⋮ n` rows; long silences show `⏱ idle Xm`. Click any node for the full transcript record in a side panel.

Ended sessions (≤24h) stay, dimmed and collapsed.

### Timeline view

Every session as a horizontal swimlane on one shared wall-clock axis — cross-project concurrency at a glance.

- **Presets** 1h / 3h / 6h; drag to pan (clamped at now); a live now-line.
- **Activity blocks** colored by tool category; **sub-agent branch spans** beneath each lane (nested depth indented).
- **Semantic markers** on each lane: ◆ your prompt, ● a pending question, ✕ a tool error, ▫ a blocked tool (hover for text).
- **Waiting stretches** — amber hatching where a session sat waiting for you (dimmer when inferred from silence).
- **Hover a block** → tooltip (time · events · tools · tokens · skill). **Click a block** → in-place popover listing the events inside it, with a "mở card" button.
- **Crosshair scrubber** reads a time slice across all lanes; the **attention ribbon** plots every prompt you sent (colored per session) with a `⇄ N switches` badge counting how often you switched focus.

### Workflow map

Each card shows the session's MK agentic workflow (from the skill attribution Claude Code records):

- Phases (**brainstorm → plan → cook → review → journal**) as colored pills, with `×N` when a phase was re-entered.
- Each phase lists the sub-agents it spawned (`⤷ code-reviewer ×5`).
- A summary badge `⚙ N phases · M agents · ↻ K loops` — the loop count reveals how many build/refine cycles the session ran.

The map is scanned from the **whole** transcript (not just the recent window), so even long sessions show their full phase history. Open by default; collapse per-session is remembered.

### File activity & conflicts

- **`📝 N files`** expander — which files the session read/edited and how often (`✎ edits · 👁 reads`), hottest first.
- **Conflict banner** — a red banner appears when **two live sessions edit the same file within 30 minutes**, on both cards, with a jump button to the other session (and a ⚠ on the timeline lane). This is the flagship signal for catching two Claude sessions stepping on each other.

### Jump to a session

The **`↗`** button on a card focuses that session's window:

- VSCode workspace → opens it via `code <cwd>`.
- CLI session → activates its terminal app.
- Ended session → copies `claude --resume <id>` to your clipboard.

The first terminal jump may trigger a macOS automation permission prompt (osascript) — allow it once.

## How it works

- **Tails** `~/.claude/projects/<project>/<session-id>.jsonl` (and `<session-id>/subagents/agent-*.jsonl`) incrementally by byte offset. Records are parsed defensively — unknown types are skipped, the parser never crashes.
- **Liveness** combines a `ps` poll (resumed session ids + fresh-process cwds via `lsof`) with transcript mtime to classify each session as running / waiting / ended.
- **Streaming** — normalized events are pushed over a WebSocket; the UI is a pure function of that event stream. In-memory state only; there is no database.
- For the full design, see [system-architecture.md](./system-architecture.md).

## Privacy & security

- **Read-only.** kansh never writes to `~/.claude`. It only reads transcript files Claude Code already wrote.
- **Local only.** The server binds `127.0.0.1` and rejects cross-origin / rebound requests (Origin + Host checks), so nothing is exposed to your network.
- **No telemetry.** Nothing leaves your machine.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Blank dashboard / "no sessions" | Confirm Claude Code has run recently (within 24h) and wrote transcripts under `~/.claude/projects/`. |
| Port already in use | Start with `KANSH_PORT=<free-port> bun run start`. |
| UI looks stale after an update | Re-run `bun run build`. |
| `waiting` looks wrong | It's a heuristic (process alive + no transcript appends for >15s); precise permission-prompt detection is a future refinement. |
| A Claude Code update broke parsing | The transcript JSONL is not a public API. The parser is tolerant, but a format change may need a small adjustment — please open an issue. |

---

Questions or bugs → [open an issue](https://github.com/phuc-nt/kansh/issues).
