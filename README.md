# Remote GPU Cluster Dashboard

A browser-based dashboard for monitoring remote GPU clusters over SSH. Supports two cluster types — RunAI (Salk, password auth) and DSMLP (UCSD, SSH key + Duo 2FA) — connectable independently or simultaneously. View GPU/CPU/RAM metrics, running processes, run terminal commands, and launch Claude Code sessions from a single browser window.

## Features

- **Dual-mode login** — Dropdown selector to connect RunAI, DSMLP, or both; only connected clusters appear in the dashboard
- **Overview** — All connected clusters at a glance with GPU utilization, memory, CPU load, RAM, and disk usage
- **GPU Detail** — Per-GPU stats from `nvidia-smi`: utilization, memory, temperature, power, and running processes
- **Process Viewer** — Sortable, filterable process table (`ps aux`) per cluster
- **Interactive Terminal** — Tabbed terminal emulator (xterm.js) with one tab per connected cluster, auto-cd to project directory and `screen -d -r` to attach sessions
- **Claude Code** — Dedicated tab to launch Claude Code on any connected cluster with a file explorer sidebar and markdown viewer
- **File Explorer** — Browse remote project files with rendered markdown previews
- **Dark / Light Mode** — VS Code-inspired themes, saved across sessions

## Architecture

```
RunAI:  browser → FastAPI → SSH (password) → cluster
DSMLP:  browser → FastAPI → SSH (key + Duo) → jump box → kubectl exec → pod
                                               jump box → kubesh → pod (terminal)
```

- **Backend**: Python FastAPI with paramiko for SSH
- **Frontend**: Vanilla HTML/CSS/JS with xterm.js and marked.js loaded from CDN (no npm, no build step)
- **Auth**: RunAI uses SSH password (held in memory only); DSMLP uses SSH key + Duo 2FA to a jump box

## Setup

```bash
conda env create -f environment.yml
conda activate gpu-dashboard
```

## Usage

```bash
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000. Use the dropdown to select RunAI, DSMLP, or Both, then click Connect. For DSMLP, approve the Duo push on your phone. The dashboard shows only the clusters you connected to.

## Configuration

All settings live in `config.yaml`:

### RunAI (Salk)

```yaml
project:
  directory: /home/jovyan/vast/kaiwen/track-mjx   # file explorer root, terminal auto-cd
  screen_session: train-vqvae                      # auto-attach in Terminal tab (screen -d -r)
  claude_screen_session: claude                    # screen session for Claude tab
  claude_user: devuser                             # su to this user for Claude

clusters:
  my-cluster:
    host: 10.0.0.1
    port: 22
    username: root
```

- `project.directory` — file explorer root, terminal auto-cd, and Claude tab working directory
- `project.screen_session` — auto-attached via `screen -d -r` in Terminal tab if running
- `clusters` — SSH targets (host, port, username), connected via password entered at login

### DSMLP (UCSD)

DSMLP uses SSH key + Duo 2FA to a jump box (`dsmlp-login.ucsd.edu`), then manages Kubernetes pods for GPU access.

```yaml
dsmlp:
  host: dsmlp-login.ucsd.edu
  port: 22
  username: kbian
  key_path: ~/.ssh/id_ed25519                      # SSH key for jump box
  launch_command: "launch-scipy-ml.sh -W DSC180A_FA25_A00 -g 4 -p low -c 8 -m 64 -n 31 -b"
  project:
    directory: private/MOSAIC                      # relative to home, or absolute path
    screen_session: train-vqvae
    claude_screen_session: claude
    claude_user: devuser
  auth_guide: "https://github.com/KevinBian107/DSC180-Toolbox"
```

- `key_path` — path to SSH private key (Ed25519)
- `launch_command` — command to launch a new pod if none is running
- `dsmlp.project` — same fields as RunAI `project`, but for the DSMLP pod environment
- `directory` — can be relative (e.g. `private/MOSAIC`) or absolute

**SSH key setup**: See the [DSC180 Toolbox guide](https://github.com/KevinBian107/DSC180-Toolbox) for generating and registering your SSH key with DSMLP.

**Pod lifecycle**:

1. **Connect** — SSH key auth + Duo 2FA (auto-sends push) to the jump box
2. **Auto-detect** — Checks `kubectl get pods` for an existing Running pod
3. **Launch** — If no pod exists, shows "Launch Pod" button; runs the configured `launch_command` and polls until Running
4. **Access** — Commands run via `kubectl exec`, terminals via `kubesh`

## Project Structure

```
config.yaml         # All configuration (clusters, project, server, dsmlp)
config.py           # Loads config.yaml into Python (exports SERVER, PROJECT, CLUSTERS, DSMLP)
app.py              # FastAPI app — REST + WebSocket endpoints for both RunAI and DSMLP
ssh_manager.py      # SSH connection pool: RunAI (password) + DSMLP (key/Duo/kubectl)
environment.yml     # Conda environment (fastapi, uvicorn, paramiko, pyyaml)
static/
  index.html        # Single-page dashboard UI with dropdown login
  style.css         # VS Code-inspired dark/light theme styles
  app.js            # Frontend: dual-mode login, metrics, terminals, file explorer
docs/
  vqvae.md          # VQVAE training quick reference
```
