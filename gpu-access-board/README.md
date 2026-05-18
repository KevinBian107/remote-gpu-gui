# gpu-access-board

A browser-based dashboard for monitoring and operating Salk's RunAI GPU clusters over SSH. View live GPU/CPU/RAM metrics, browse processes, run terminal commands, and launch Claude Code sessions from a single browser window.

## Features

- **Single-mode login** — One SSH password unlocks every configured Salk cluster
- **Overview** — All connected clusters at a glance with GPU utilization, memory, CPU load, RAM, and disk usage
- **GPU Detail** — Per-GPU stats from `nvidia-smi`: utilization, memory, temperature, power, and running compute processes
- **Process Viewer** — Sortable, filterable process table (`ps aux`) per cluster
- **Interactive Terminal** — Tabbed terminal emulator (xterm.js) with one tab per connected cluster, auto-cd to the project directory and `screen -d -r` to attach the configured session
- **Claude Code** — Dedicated tab that launches Claude Code in a dedicated `claude-remote-access` screen session (separate from your other screens) with a file explorer sidebar and markdown viewer
- **File Explorer** — Browse remote project files; markdown and image preview
- **Dark / Light Mode** — Refined indigo/violet palette, saved across sessions
- **GitHub Pages friendly** — The static frontend can live anywhere and point at a backend running locally on your laptop (since the backend is the one that needs Salk VPN access)

## Architecture

```
browser  ──► FastAPI (local)  ──► Salk RunAI cluster (over VPN)
              (paramiko + ws)        (SSH password auth)
```

- **Backend**: Python FastAPI + paramiko. Holds the SSH password in memory only.
- **Frontend**: Vanilla HTML/CSS/JS + xterm.js + marked.js loaded from CDN. No build step.
- **Auth**: cluster SSH password, entered at the login screen.

## Setup

```bash
conda env create -f environment.yml      # first time only, from the repo root
conda activate vibes
```

## Two ways to run

**You always need to be on the Salk VPN** — the backend needs network access to the cluster hosts.

### A) All-in-one (simplest)

Serve the dashboard and the API from the same uvicorn process:

```bash
cd gpu-access-board
uvicorn app:app --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000>. The static frontend is served from the same origin as the API — no extra setup.

### B) Frontend on GitHub Pages, backend on your laptop

The static frontend can be hosted from GitHub Pages and pointed at a backend running locally on your machine. The browser permits HTTPS pages to call `http://localhost`, so this just works.

1. Push this repo to GitHub and enable Pages on the default branch (`/` root).
2. Open `https://<you>.github.io/vibes/gpu-access-board/`.
3. Click the ⚙ button (top-right of the login screen) and confirm the backend URL is `http://localhost:8000`. The page auto-detects this for `github.io` hosts.
4. On your laptop, with the Salk VPN connected, run:
   ```bash
   uvicorn app:app --host 127.0.0.1 --port 8000
   ```
5. Back in the browser, type your SSH password and click **Connect**.

You can also pass the backend URL in the URL itself for a one-click bookmark:

```
https://<you>.github.io/vibes/gpu-access-board/?backend=http://localhost:8000
```

The page stores it in `localStorage` so you only need that link once.

> **Why this works:** Per the W3C "secure contexts" spec, `http://localhost` is considered potentially trustworthy, so HTTPS origins (like GitHub Pages) are allowed to call it via `fetch()` and `WebSocket`. The backend additionally enables CORS for any origin listed under `server.cors_origins` in `config.yaml`.

## Configuration

All settings live in `config.yaml`:

```yaml
server:
  host: 0.0.0.0
  port: 8000
  cors_origins:                # who's allowed to call this backend cross-origin
    - http://localhost:8000
    - https://kevinbian107.github.io

project:
  directory: /home/jovyan/vast/kaiwen/track-mjx   # file explorer root, terminal auto-cd
  screen_session: train-vqvae                      # auto-attach in Terminal tab
  claude_screen_session: claude-remote-access      # screen name for Claude tab (kept separate from other screens)
  claude_user: devuser                             # su to this user before launching claude

clusters:
  topovnl-salk:
    host: 10.7.30.216
    port: 30988
    username: root
  # …more clusters here
```

| Key | Meaning |
|---|---|
| `project.directory` | File explorer root, terminal auto-cd, Claude working directory |
| `project.screen_session` | Auto-attached via `screen -d -r` in the Terminal tab |
| `project.claude_screen_session` | The screen name used by the Claude tab — `claude-remote-access` keeps it distinct from any other `claude` screens you might have running manually |
| `project.claude_user` | User to `su` into before launching Claude |
| `clusters.*` | SSH targets (host / port / username), all unlocked with the same password |
| `server.cors_origins` | Origins permitted to call the backend (only needed if you serve the frontend from somewhere other than the backend itself) |

## Claude tab behavior

When you click **Launch** in the Claude tab, the dashboard:

1. Opens a SSH session to the selected cluster
2. `su` into `claude_user`
3. `cd` into `project.directory`
4. Either reattaches the existing `claude-remote-access` screen, or starts a fresh one running `claude --dangerously-skip-permissions`

The screen name (`claude-remote-access` by default) is intentionally distinct from any other `claude` screens you might run manually — closing this terminal tab won't disturb other sessions, and reopening it reattaches the same long-lived Claude session.

## Project structure

```
gpu-access-board/
├── README.md
├── config.yaml        # all configuration
├── config.py          # loads config.yaml
├── app.py             # FastAPI app — REST + WebSocket endpoints
├── ssh_manager.py     # SSH connection pool (password auth)
└── static/
    ├── index.html     # single-page dashboard UI
    ├── style.css      # refreshed indigo/violet palette, dark + light
    └── app.js         # frontend: login, metrics, terminals, file explorer, backend-URL switching
```

## Security notes

- The SSH password is held only in the backend's memory and never written to disk.
- If you host the frontend on GitHub Pages, the backend is still on your laptop — your password never leaves your machine.
- The backend listens on whatever interface you start it on. Use `--host 127.0.0.1` if you want it strictly loopback-only.
- CORS is restricted to the origins in `config.yaml`. Add or remove origins there.
