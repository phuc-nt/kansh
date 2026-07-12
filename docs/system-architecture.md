# Kansh System Architecture

Updated: 2026-07-12 (v0.4.0 — "Semantic Layer" complete)

## v0.4 additions (mirror → analyzer)

- **Semantic extraction** (parser+store): `mission` (latest real user prompt), `todos` (latest main-lane TodoWrite input), `pendingQuestion` (AskUserQuestion in flight — cleared by its tool-end OR any subsequent user message; interrupts don't always produce a tool_result), `errorStreak` (consecutive `tool_result.is_error`), `loopSuspect` (same toolName+label ≥3 in ring of 15 — clear decision counts the SUSPECT's signature, not the incoming event's). Broadcast change-only via `session-semantics` (NUL-separated fingerprint).
- **Semantic-first cards**: mission/progress-bar/health-badges/pending-question là thân card; git-graph behind per-session expander (localStorage). Badges là heuristic — màu nhẹ, tooltip.
- **Digest**: client-side rollup per project (tokens in/out/cacheRead, active-time với cache theo events identity, cost ước tính từ `src/shared/model-pricing.ts` — unknown model → không hiện $; chưa gồm cache-write premium).

## v0.3 additions

- **Timeline view**: second view mode (toggle, localStorage-persisted). `src/ui/timeline-layout-engine.ts` — pure `(sessions, window, nowMs) → lanes` with activity-block merging (<60s gaps), branch spans, window clamping. Open-span rule: a branch with unseen end stays open only if ITS OWN agent had activity within 10min of the session tip (session-wide lastMs falsely collapses long-running subagents); live (running/waiting) sessions always keep a lane. Pan clamps at real now; pointercancel handled; drag suppresses lane-click jump.
- **Sub-sub-agent depth**: `spawnDepth` threaded meta.json → spawn event → both views (nested indent). Ingestion closure matching runs on ALL lanes — a depth-2 agent's Task tool-end lives in its parent agent's transcript, not main (bug found by fixture-first approach).

## v0.2 additions

- **Contract**: events optionally carry `usage {in,out,cacheRead,cacheCreation}` + `model` (attached once per `message.id` — transcripts write one record per content block, naive per-record summing inflates ~2x); sessions carry `model`, `totalTokensIn/Out`, `contextTokens`, `waitingReason`.
- **Layout engine**: condensed segments (runs ≥3 minor events → `⋮ n`, expandable) + idle gap markers (>2min). Hard rule: branch anchors, merge targets, spawn/end, and lane-last nodes are never compressed.
- **Auto-follow invariants** (hard-won): scroll via `useLayoutEffect` synchronously (rAF never fires in backgrounded/occluded tabs — a monitor's default state); card DOM order is stable (sessionId) with CSS `order` for visual rank (moving DOM nodes resets viewport scrollTop); unfollow covers wheel (deltaY<0), touch, and scrollbar/keyboard (upward scroll not made programmatically).
- **Liveness**: `waitingReason` heuristic — tip event is pending tool-start → 'permission', else 'user-turn'.
- **Per-card 1s ticker** only while a tool is pending; layout memoized separately so ticks re-render JSX, not re-layout.

## Overview

Single Bun process + browser SPA. Passive, read-only observer of Claude Code's own transcript files. No DB; state is in-memory and rebuilt from transcript tails on startup.

```
~/.claude/projects/**/*.jsonl  (written by Claude Code, append-only)
        │ fs.watch (recursive) + 10s rescan safety net
        ▼
┌─ Bun server (src/server) ──────────────────────────────────────┐
│ session-discovery          scan project dirs, 24h mtime window │
│ jsonl-incremental-tailer   per-file byte offset, Buffer-safe   │
│                            partial-line carry, byte ranges     │
│ transcript-record-parser   raw record -> NormalizedEvent[]     │
│                            (defensive; noise/isMeta filtered)  │
│ session-transcript-ingestion  orchestrates above; subagent     │
│                            spawn/closure matching; eviction    │
│ session-liveness-poller    ps (resume ids) + lsof (fresh cwds) │
│ session-state-store        Map<sessionId, state>; seq assign;  │
│                            running|waiting|ended; 24h eviction │
│ event-detail-reader        uuid -> byte range; lazy re-read,   │
│                            2KB string truncation, FIFO cap     │
│ session-window-launcher    jump: code/open/osascript (argv)    │
│ websocket-hub              127.0.0.1 only; Origin+Host guard;  │
│                            WS snapshot+push; /api/*; dist/ UI  │
└────────────────────────────────────────────────────────────────┘
        │ WebSocket: snapshot on connect, then event/status push
        ▼
┌─ React SPA (src/ui) ───────────────────────────────────────────┐
│ session-graph-store        external store, uuid dedupe, caps   │
│ websocket-live-connection  reconnect w/ backoff, socket-scoped │
│ graph-layout-engine        pure: events -> nodes/edges/columns │
│ components/                dashboard grid, lane cards, SVG     │
│                            graph, detail panel, filter bar     │
└────────────────────────────────────────────────────────────────┘
```

## Key contracts

- `src/shared/normalized-event-types.ts` — the only coupling between server and UI. Events carry `(ts, seq)`; renderers sort by ts with seq as tiebreaker (apply order ≠ chronological during replay).
- Sub-agent branch identity: `meta.json.toolUseId` links `subagent-spawn` to the parent `Task` `tool_use`; the matching `tool-end` closes the branch (merge point).

## Liveness classification

- `running`: transcript appended <15s ago.
- `waiting`: claude process tied to session (via `--resume`/`-r` id, or fresh-process cwd match — one session per cwd, most recent wins) but idle.
- `ended`: neither; evicted after 24h idle.

## Security posture

Transcripts are private data. Server binds `127.0.0.1`; all requests pass an Origin allowlist (self + vite dev) and Host check (DNS-rebinding). All child processes are fixed argv arrays (no shell). `/api/jump` validates sessionId against the store. Detail payloads truncate strings server-side.

## Bounded memory (always-on daemon)

Per-session event ring (2000), client cap (600), detail index FIFO (20k), seen-tool-end cap (500/session), 24h session eviction cascading to tailer offsets, spawn maps, and in-flight read chains.
