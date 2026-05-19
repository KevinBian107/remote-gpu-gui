<p align="center">
  <img src="assets/logo.svg" alt="vibes" width="260">
</p>

## What this is

`vibes` is a monorepo of lightweight, self-contained tools I reach for while doing research — dashboards, viewers, visualizers, small utilities. Each one lives in its own top-level directory and is independent; they just share a single Python env (managed by [uv](https://docs.astral.sh/uv/)) so nothing is ever more than `source .venv/bin/activate` away.

Inspired by [@LeoMeow123/vibes](https://github.com/LeoMeow123/vibes) — the idea being that research code accumulates a lot of *little* things, and they deserve a home together rather than scattered across a dozen orphan repos.

## Layout

```
vibes/
├── README.md              # this file
├── pyproject.toml         # shared Python env for every vibe (uv)
├── assets/                # logos, shared static assets
├── shared/                # reusable helpers (grows as vibes overlap)
├── vibes.py               # discover / list the available vibes
│
├── gpu-access-board/      # live SSH dashboard: metrics, terminals, file explorer
│   └── README.md
├── gpu-dashboard-agent/   # Gist-backed monitor, no server, no SSH
│   └── README.md
│
└── <your next vibe>/
    └── README.md
```

Every vibe is a directory with its own `README.md` describing what it is and how to run it. The top-level `vibes.py` script discovers them.

## Setup (once)

Install [uv](https://docs.astral.sh/uv/) if you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then from the repo root:

```bash
uv sync                   # creates .venv/ and installs everything
source .venv/bin/activate # optional — or prefix commands with `uv run`
```

That's it. First sync takes ~10 seconds; subsequent ones are instant when nothing changes.

The `pyproject.toml` lists the union of dependencies across all vibes. Add what your vibe needs there when you add a new one, then re-run `uv sync`.

## Using a vibe

List what's here:

```bash
uv run vibes.py
```

Read a specific vibe's instructions:

```bash
uv run vibes.py gpu-access-board
```

(`uv run` automatically picks up `.venv/`, so you don't need to activate it.) Then run it per its README.

## Current vibes

| vibe | what it does |
|---|---|
| [`gpu-access-board`](gpu-access-board/) | live SSH dashboard — metrics, terminals, file explorer, Claude Code launcher for remote GPU clusters |
| [`gpu-dashboard-agent`](gpu-dashboard-agent/) | server-less GPU monitor — workstation agents push to a GitHub Gist, static dashboard reads it |

## Adding a new vibe

1. Create a new top-level directory: `mkdir my-vibe`
2. Drop in a `README.md` that explains what it does and how to run it
3. Add any new dependencies to the root `pyproject.toml` and run `uv sync`
4. (Optional) If it imports from a previous vibe, consider promoting the shared code to `shared/`

Keep vibes small and self-contained. A vibe shouldn't need a framework — it just needs to work.

