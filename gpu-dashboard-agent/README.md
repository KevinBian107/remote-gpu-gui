# gpu-dashboard-agent

Monitor GPUs across multiple workstations from a single web page. No server required.

> Direct reimplementation of [@LeoMeow123/vibes/gpu-dashboard](https://github.com/LeoMeow123/vibes/tree/main/gpu-dashboard). All architectural credit to **Leo** — the push-based, server-less design is his, and as of this version the agent/dashboard layout mirrors his **exactly** (per-machine files, systemd installer, single-file HTML).

## How It Works

```
Workstation 1  ──push──►                              ◄──read── GitHub Pages
Workstation 2  ──push──►  GitHub Gist (JSON store)    ◄──       Dashboard
RunAI Pod      ──push──►
```

A lightweight Python agent runs on each machine, collects GPU/CPU/RAM stats every 30 seconds, and pushes them to a GitHub Gist. The dashboard (a static HTML page on GitHub Pages) reads the Gist and displays everything.

- **No server needed** — GitHub Gist is the data store, GitHub Pages hosts the dashboard
- **No inbound ports** — agents push outbound to GitHub API
- **Auto-pause** — stops polling when you switch browser tabs
- **Works anywhere** — Ubuntu workstations, RunAI, any machine with `nvidia-smi` and Python

## Multi-machine handling (the important bit)

Each agent writes its **own file** in the shared Gist, named after the machine's label:

```
metrics.json          ← old single-file design (removed)
gpu-status-salk-ws-1.json    ← agent A
gpu-status-salk-ws-2.json    ← agent B
gpu-status-vqmimic-0.json    ← RunAI pod
gpu-status-vqmimic-1.json    ← RunAI pod
```

Filename is derived from `machine_label` (alphanumerics + `-_` kept, everything else replaced with `-`). The dashboard reads every file matching `gpu-status-*.json` and renders one card per machine.

**Why per-file and not a single shared JSON?** With a single file, every agent has to GET → merge → PATCH, which races: two agents pushing at the same time will clobber each other. With per-machine files, each agent just PATCHes its own filename — GitHub merges files atomically — so concurrent pushes never collide.

**Sharing a config across multiple pods (e.g. RunAI):** set `GPU_DASH_LABEL` per pod so each gets its own filename. Anything else (`gist_id`, `github_token`) can be shared.

```bash
GPU_DASH_LABEL=vqmimic-0 gpu-agent       # → gpu-status-vqmimic-0.json
GPU_DASH_LABEL=vqmimic-1 gpu-agent       # → gpu-status-vqmimic-1.json
```

If `machine_label` is unset, it defaults to `platform.node()` (the container/host's hostname), so unique-hostname setups Just Work.

## What it shows

| Per Machine | Per GPU | Per Process |
|-------------|---------|-------------|
| CPU usage & core count | Utilization % (+ 30-min peak) | Command line |
| RAM usage | VRAM usage | GPU memory |
| Uptime | Temperature | User |
| Freshness (last report) | Power draw / limit | Runtime |

Top of the page: summary cards (machines, GPUs, avg util, VRAM, jobs, power, inference). Detail bar with GPU fleet inventory. Filter bar with type pills (workstation / RunAI), sort, and search. Per-card drag-and-drop reordering, rename, remove, collapse.

## Quick start (add your machine)

No clone needed. Run this on any machine with `nvidia-smi` and Python.

### Workstation (Ubuntu, with sudo)

```bash
# Install dependencies
pip install psutil requests

# Download and run the installer
curl -sL https://raw.githubusercontent.com/KevinBian107/vibes/master/gpu-dashboard-agent/agent/install.sh -o /tmp/gpu-install.sh && \
curl -sL https://raw.githubusercontent.com/KevinBian107/vibes/master/gpu-dashboard-agent/agent/gpu_agent.py -o /tmp/gpu_agent.py && \
SCRIPT_DIR=/tmp bash /tmp/gpu-install.sh
```

The installer sets up a **systemd user service** that auto-starts on boot.

### RunAI / no sudo / no systemd

```bash
# Install dependencies (use whichever works in your environment)
pip install psutil requests
# or: uv pip install psutil requests --system
# or: pip install --user psutil requests

# Download and run the installer
curl -sL https://raw.githubusercontent.com/KevinBian107/vibes/master/gpu-dashboard-agent/agent/install.sh -o /tmp/gpu-install.sh && \
curl -sL https://raw.githubusercontent.com/KevinBian107/vibes/master/gpu-dashboard-agent/agent/gpu_agent.py -o /tmp/gpu_agent.py && \
SCRIPT_DIR=/tmp bash /tmp/gpu-install.sh
```

RunAI doesn't have systemd, so the installer prints manual instructions. **Run the agent in tmux** so it survives terminal disconnects:

```bash
tmux new -d -s gpu-agent "python3 ~/.local/bin/gpu-agent"
tmux ls                      # should show gpu-agent session
tmux attach -t gpu-agent     # peek at output (Ctrl+B, D to detach)
```

> **Note:** RunAI workspace restarts wipe everything. After a restart, re-run the installer + tmux command.

### First-time setup (dashboard owner)

If you're setting up a NEW dashboard from scratch:

1. Create a **secret** [GitHub Gist](https://gist.github.com) with any content → copy the Gist ID from the URL
2. Create a [Personal Access Token](https://github.com/settings/tokens) → classic → check only `gist` → Generate
3. Run the installer on your first machine (it will prompt for the Gist ID and token)
4. Open the dashboard (see below) → click **Settings** → enter your Gist ID
5. Share the Gist ID with your team so they can add their machines

## Hosting the dashboard

### Option A — open the file locally

```bash
cd gpu-dashboard-agent && open index.html    # macOS
```

### Option B — local HTTP server

```bash
cd gpu-dashboard-agent
python -m http.server 8000   # http://localhost:8000
```

### Option C — GitHub Pages (recommended)

1. Push this repo to GitHub.
2. Settings → Pages → Deploy from a branch → `master` / `(root)`.
3. Dashboard URL: `https://<you>.github.io/vibes/gpu-dashboard-agent/`

Bookmark that URL. Paste the Gist ID once (it's saved to `localStorage`). Optionally paste a GitHub PAT to raise the read rate-limit from 60/hr to 5000/hr.

## Agent usage

```bash
python3 gpu_agent.py              # continuous (default 30s)
python3 gpu_agent.py --once       # single snapshot (good for cron)
python3 gpu_agent.py --interval 60
python3 gpu_agent.py --dry-run    # collect + print, don't push
```

## Configuration

The agent reads config from `~/.config/gpu-dashboard/config.json` or environment variables:

| Config key | Env variable | Description |
|---|---|---|
| `gist_id` | `GPU_DASH_GIST_ID` | GitHub Gist ID |
| `github_token` | `GPU_DASH_GITHUB_TOKEN` | GitHub PAT with `gist` scope |
| `machine_label` | `GPU_DASH_LABEL` | Display name on dashboard (also drives the Gist filename) |
| `machine_type` | `GPU_DASH_TYPE` | `workstation` or `runai` |
| `interval_seconds` | — | Polling interval (default 120) |
| `inference_log_dir` | `GPU_DASH_INFERENCE_LOG_DIR` | Path to JSONL inference logs (optional) |
| `inference_refresh_seconds` | — | Cache duration for inference parsing (default 3600) |

Example config:

```json
{
    "gist_id": "0123456789abcdef0123456789abcdef",
    "github_token": "ghp_xxxxxxxxxxxxxxxxxxxxxxxx",
    "machine_label": "salk-ws-1",
    "machine_type": "workstation",
    "interval_seconds": 30
}
```

`chmod 600 ~/.config/gpu-dashboard/config.json` after editing.

## Inference progress tracking (optional)

The dashboard can track long-running SLEAP-style inference jobs. When configured, each machine card shows per-camera progress bars, video counts, FPS, and ETA. A summary card in the top bar shows overall inference completion across all machines.

```
JSONL progress logs ──read──► gpu-agent ──push──► Gist ──read──► Dashboard
(written by inference)         (parses & summarizes)              (renders progress)
```

The inference script writes one JSONL line per completed video to `{camera}_progress.jsonl` files. The agent reads these logs, computes summary stats (videos done/total, avg FPS, ETA), and includes them in the snapshot.

### JSONL log format

```json
{
  "status": "completed",
  "camera": "cam_01",
  "gpu": 0,
  "session": "2024-12-07-00-01-04",
  "video": "cam_01.08.mp4",
  "fps": 119.6,
  "runtime_sec": 1503.2,
  "frames": 180000,
  "videos_done": 42,
  "videos_total": 15935,
  "sessions_done": 3,
  "sessions_total": 10900,
  "timestamp": "2026-02-27T00:44:52Z"
}
```

| Field | Required | Description |
|---|---|---|
| `status` | yes | `"completed"` or `"failed"` |
| `videos_done` | yes | Cumulative count of finished videos for this camera |
| `videos_total` | yes | Total videos to process for this camera |
| `fps` | no | Frames per second for this video (used for avg FPS) |
| `runtime_sec` | no | Wall-clock seconds for this video (used for ETA) |
| `camera` | no | Camera name (also derived from filename) |
| `gpu` | no | GPU index (shown in dashboard) |
| `timestamp` | no | ISO 8601 timestamp |
| `session` | no | Session identifier |
| `video` | no | Video filename |
| `sessions_done` / `sessions_total` | no | Session-level progress |
| `frames` | no | Frame count (informational) |

### Setup

Add two fields to `~/.config/gpu-dashboard/config.json`:

```json
{
    "...": "...",
    "inference_log_dir": "/path/to/inference_log",
    "inference_refresh_seconds": 3600
}
```

The agent caches inference stats between pushes to avoid re-parsing thousands of JSONL lines every cycle. Cache refreshes once per `inference_refresh_seconds` (default 1 hour).

### Backward compatibility

- `inference_log_dir` empty / missing → no inference data collected, existing behavior unchanged
- Old agents (without inference code) work with the new dashboard — inference section just doesn't appear
- New agents work with old dashboards — the extra `inference` key is ignored

## Components

```
gpu-dashboard-agent/
├── README.md
├── index.html              # static dashboard (single file, inline CSS + JS)
└── agent/
    ├── gpu_agent.py        # the agent (psutil + requests)
    ├── install.sh          # systemd / manual installer
    └── gpu-agent.service   # systemd unit (copied by install.sh)
```

## Security

- PAT only needs `gist` scope — cannot access repos or org settings
- Config file stored with `chmod 600` (owner-only read)
- Gist is **secret** (not listed, but readable by anyone with the URL)
- Dashboard stores Gist ID + PAT in browser `localStorage`

## Rate limits

| Action | Limit | Typical usage |
|---|---|---|
| Agent writes (with PAT) | 5,000 / hr | 3 machines × 2/min = 360/hr |
| Dashboard reads (no token) | 60 / hr | 1/min = 60/hr |
| Dashboard reads (with token) | 5,000 / hr | comfortable margin |

Paste your token in dashboard **Settings** for reliable 30s polling.

## Why this and not the other GPU vibe?

| | `gpu-dashboard-agent` (this) | `gpu-access-board` |
|---|---|---|
| needs a server | ❌ no | ✅ yes (FastAPI) |
| needs SSH credentials | ❌ no | ✅ yes (password / key + Duo) |
| can run terminals | ❌ no | ✅ yes |
| can launch Claude / files / processes | ❌ no | ✅ yes |
| works from a phone / random machine | ✅ yes | ⚠️ requires VPN + server |
| good for "glance at utilization from anywhere" | ✅ yes | overkill |
| good for "ssh in and train a model" | ❌ no | ✅ yes |

Use both. They complement each other.
