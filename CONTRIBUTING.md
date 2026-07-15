# Contributing to kansh

Thanks for your interest! kansh is a small, local, read-only tool — contributions that keep it focused, safe, and offline are very welcome.

## Ground rules

- **Read-only & offline.** kansh must never write to `~/.claude` and must never send data off the machine. The server binds `127.0.0.1` only. Please preserve this — it's the core promise.
- **Defensive parsing.** The Claude Code transcript format is not a public API. Parsers must skip unknown records and never crash on unexpected shapes.
- **Keep it lean.** Runtime dependencies are just React. Avoid adding dependencies unless there's a strong reason.

## Getting started

```bash
git clone https://github.com/phuc-nt/kansh
cd kansh
bun install
bun run dev     # UI hot-reload at http://localhost:5173 (run `bun run start` too)
```

See [docs/installation-and-usage.md](docs/installation-and-usage.md) for full setup and [docs/system-architecture.md](docs/system-architecture.md) for how the pieces fit together.

## Before you open a PR

Run the gates from the repo root:

```bash
bunx tsc --noEmit    # type check
bun test             # unit tests (pure engines + server state)
bun run build        # production build
```

- Add or update tests for behavior changes. The layout/graph/replay engines are pure and fixture-tested — mirror that style.
- Match the existing code: kebab-case filenames, small modules, descriptive comments only where they state a real constraint.
- Keep commits focused; use conventional-commit style (`feat:`, `fix:`, `docs:`) without AI references.

## Reporting bugs

Open an [issue](https://github.com/phuc-nt/kansh/issues). If it's a parsing problem, note your Claude Code version — the transcript format can shift between releases.

## Scope

kansh targets macOS (liveness detection and jump-to-session use `ps`/`lsof`/app activation). The core dashboard may work elsewhere; platform-specific features are best-effort off macOS.
