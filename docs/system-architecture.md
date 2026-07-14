# Kansh System Architecture

Updated: 2026-07-14 (v0.7.0 — "Workflow Map" complete)

## v0.7 additions (agentic workflow map)

- **Whole-session workflow scan** (`src/server/workflow-timeline-scanner.ts`): the 512KB replay tail of a large session (18MB) holds ZERO main-lane `attributionSkill` records — they sit before the tail window — so the map needs a SEPARATE light full-file pass. Streams the transcript, substring-prefilters lines (`attributionSkill`) before JSON-parse, and extracts only the compact `(skill, ts)` main-lane transition sequence (consecutive repeats collapsed) + subagent spawn refs (`agentType`, `ts` from the agent jsonl birthtime, `depth` from meta.json). Capped (500 phases / 1000 spawns), read-only, never breaks ingestion. Re-scanned only when the transcript mtime changes (gated in `refreshWorkflow`). Result rides `session.workflow` (contract: optional `WorkflowTimeline`).
- **Pure graph engine** (`src/ui/workflow-graph-engine.ts`, fixture-first): `WorkflowTimeline → WorkflowGraph`. Collapses raw skills into a fixed typed set (brainstorm / mk-plan / cook / review [chrome-devtools, react-best-practices, *review*, fix] / research / journal / other); nodes carry visits + active flag; directed edges weighted by transition count (thick = many build loops); `loopCount` = revisits. Subagents tie to the phase active at spawn time (best-effort — meta.toolUseId does NOT map to the parent Task tool_use id, verified; timestamp is the only tie), grouped by agentType (cap 8 + overflow).
- **Per-card map** (`src/ui/components/session-workflow-map.tsx`): collapsed to a `⚙ N phases · M agents · ↻ K loops` summary by default (card is already tall), expander localStorage-persisted. Expanded = small SVG: phase pills (fixed `phase-color-palette.ts`, active pill pulses), curved arrowed edges thickened by weight with `×N` labels, cook's subagent chips beneath its node. Non-MK / empty session renders nothing. Hover tooltips (visits, duration, tokens, full agentType).

## v0.6 additions (provenance & conflict)

## v0.6 additions (provenance & conflict)

- **Real session titles**: `type: ai-title`/`custom-title` records → `session.title` (custom > ai, latest wins; folder-name fallback). Title records carry no events, so `applyMeta` broadcasts the change itself. Used by card headers (folder demoted to subtitle via `src/ui/session-label.ts`) and timeline lane labels.
- **File activity**: record-level `toolUseResult` classified defensively — edit = `filePath` + (`type` create/update or `oldString` key), read = `file.filePath`; unknown shapes skipped (format is not public; both shapes verified against real transcripts). Per-session `filesTouched` capped at 50, hottest-first; card expander lists top 10 cwd-relative.
- **Cross-session edit conflicts** (the multi-session monitor's unique value): store keeps a global path→(sessionId→lastEditMs) index; ≥2 LIVE sessions editing the same file within 30min → `conflicts` on both, red banner on cards + ⚠ on lanes. Recomputed on each edit and each liveness sample (window is time-relative); write-tools only to avoid read noise.
- **Skill attribution**: `attributionSkill` → event.skill on tool-starts; `currentSkill` = latest attributed main-lane tool, expiring after 10 unattributed tools. Card badge `⚙ <skill>`; popover shows the block's dominant skill.
- **Friction**: `toolDenialKind` attaches `blocked {kind, reason}` to the tool-end; `type: system` records with `preventedContinuation`/`hookErrors` become synthetic blocked events. `blockedCount` badge on cards; 4th timeline marker kind `blocked` (hollow red square, beats plain error for the same event).

## v0.5 additions (timeline: mirror → analyzer)

- **Engine** (`src/ui/timeline-layout-engine.ts`, pure + fixture-tested): lanes carry `markers` (prompt/error/question, cap 80 newest per lane) and `waitingStretches` (live waiting stretch + inferred stretches from >2min silence before a user prompt); `ActivityBlock` enriched with `dominantTools`/`tokensIn`/`tokensOut`. `computeAttention(sessions, window)` is a SEPARATE export (layoutTimeline signature stays stable) → user-prompt points + cross-session switch count.
- **Overlays** (state local to `GlobalTimelineView`, one tooltip + one popover max): hover block → rich HTML tooltip; click block → in-place popover (events filtered by block time range from `session.events`, cap 15, "mở card" closes popover then jumps). Closes on Escape / outside mousedown / pan. Pointer-capture footgun: capturing on pointerdown retargets clicks away from block rects — capture is deferred until the ≥3px pan threshold.
- **Scrubber + ribbon**: crosshair on plain hover (line + HH:MM + per-lane chip: dominant tool or idle), suppressed while popover open, cleared on pan/leave. Per-pixel mousemove stays cheap because `msToX`/`pointerHandlers`/`selectLane` are memoized so memo'd lane rows don't re-render. Attention ribbon row renders `computeAttention` points as diamonds colored via `src/ui/lane-color-palette.ts` (shared with lane label chips) + `⇄ N switches` badge.

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
