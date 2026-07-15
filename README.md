# kansh

[![version](https://img.shields.io/github/package-json/v/phuc-nt/kansh)](https://github.com/phuc-nt/kansh/releases)
[![license](https://img.shields.io/github/license/phuc-nt/kansh)](LICENSE)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black)](https://bun.sh)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](#quick-start)

**A local, read-only dashboard for your Claude Code sessions.**

Run many Claude Code sessions at once? kansh auto-detects every one on your machine and shows them on a single screen — live — so you stop switching windows to check what each agent is doing.

- 🗂 **One card per session** — mission, progress, health, and the exact question it's waiting on.
- 🧭 **Timeline view** — every session as a swimlane on one shared clock; see cross-project concurrency at a glance.
- 🔀 **Workflow map** — the MK agentic flow (brainstorm → plan → cook → review → journal) with loop counts and the sub-agents each phase spawned.
- ⏵ **Workflow replay** — pick any task (one per prompt) and replay it at high speed: phases light up and sub-agents fade in as they happened, with play/pause, speed, and a scrub bar.
- ⚠️ **Conflict alerts** — a red banner when two live sessions edit the same file, so agents don't step on each other.
- 🔒 **Read-only & local** — never writes to `~/.claude`, binds to `127.0.0.1` only, no telemetry.

![kansh cards view](docs/images/dashboard.png)

<sub>Cards view — mission, workflow map (phases + sub-agents), health badges, and file activity per session.</sub>

## Quick start

```bash
git clone https://github.com/phuc-nt/kansh
cd kansh
bun install
bun run build
bun run start          # → http://127.0.0.1:4777
```

Requires [Bun](https://bun.sh) ≥ 1.3 and [Claude Code](https://claude.com/claude-code) (macOS). Zero config — no hooks, no plugins.

![kansh timeline view](docs/images/timeline.png)

<sub>Timeline view — every session as a swimlane on one shared clock, with prompt/error/blocked markers, waiting stretches, and an attention ribbon.</sub>

![kansh workflow replay](docs/images/replay.png)

<sub>Workflow replay — pick a task and watch its phases reveal over time; the current phase pulses while later ones stay dimmed until reached.</sub>

## Documentation

- 📖 **[Installation & Usage](docs/installation-and-usage.md)** — full setup, every feature, configuration, troubleshooting.
- 🏗 **[System Architecture](docs/system-architecture.md)** — how the tailer, parser, liveness, and views fit together.
- 📝 **[Changelog](CHANGELOG.md)** — what changed in each release.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The core promise is that kansh stays **local, read-only, and offline**; please keep it that way.

## License

[MIT](LICENSE) © phuc-nt
