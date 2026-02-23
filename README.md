# Remote GPU Cluster Dashboard

A browser-based dashboard for monitoring remote GPU clusters over SSH. View GPU/CPU/RAM metrics, running processes, and run terminal commands — all from a single browser window instead of juggling multiple SSH sessions.

## Features

- **Overview** — All clusters at a glance with GPU utilization, memory, CPU load, RAM, and disk usage
- **GPU Detail** — Per-GPU stats from `nvidia-smi`: utilization, memory, temperature, power, and running processes
- **Process Viewer** — Sortable, filterable process table (`ps aux`)
- **Interactive Terminal** — Tabbed terminal emulator (xterm.js) with one tab per cluster, running real commands via SSH

## Architecture

```
browser <--WebSocket--> FastAPI <--SSH/paramiko--> clusters
browser <---REST API--> FastAPI <--SSH/paramiko--> clusters
```

- **Backend**: Python FastAPI with paramiko for SSH
- **Frontend**: Vanilla HTML/CSS/JS with xterm.js loaded from CDN (no npm, no build step)
- **Auth**: SSH password entered once in the browser, held in server memory only (never written to disk)

## Setup

```bash
conda env create -f environment.yml
conda activate gpu-dashboard
```

## Usage

```bash
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000, enter your SSH password, and the dashboard connects to all configured clusters.

## Cluster Configuration

Edit `config.py` to add or change clusters:

```python
CLUSTERS = {
    "my-cluster": {
        "host": "my-cluster.example.com",
        "port": 22,
        "username": "myuser",
    },
}
```

## Project Structure

```
app.py              # FastAPI app — REST routes, WebSocket terminal, metric parsing
ssh_manager.py      # SSH connection pool & command execution via paramiko
config.py           # Cluster definitions (hosts, ports, users)
environment.yml     # Conda environment
static/
  index.html        # Single-page dashboard UI
  style.css         # Dark theme styles
  app.js            # Frontend: metrics polling, process table, xterm.js terminals
```
