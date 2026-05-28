# gpu-access-board — Mac app

A native macOS `.app` that wraps the FastAPI backend + the static frontend in a
single double-clickable bundle. No `uvicorn` to launch, no browser tab to
manage — the dashboard opens in its own window.

Same Python code as the browser version; just packaged. You still need to be
on the Salk VPN.

## Build it

One-time (installs `pywebview` + `pyinstaller` into the shared `.venv`):

```bash
uv sync --extra macapp
```

Then from the repo root:

```bash
uv run python gpu-access-board/macapp/build_macapp.py
```

Output: `gpu-access-board/dist/GPU Access Board.app`. Drag it to `/Applications`
(or run it from `dist/`).

## First launch

The bundle isn't code-signed or notarized, so Gatekeeper will quarantine it.
Strip the quarantine bit once:

```bash
xattr -dr com.apple.quarantine '/Applications/GPU Access Board.app'
```

Or right-click → Open → Open the first time.

## How it works

```
double-click .app
      │
      ▼
app_entry.py  ──spawns──►  uvicorn (127.0.0.1:<random port>)
      │                          │
      │                          ▼
      └──opens──►  WKWebView  ◄──  /api/* + /ws/*  + static/index.html
```

- `app_entry.py` picks an ephemeral port, starts `app:app` in a child process,
  polls `/api/health` until it answers, then opens a 1400×900 WebView at
  `http://127.0.0.1:<port>/`.
- All API + WebSocket traffic stays on localhost. The SSH password never
  leaves your machine (same as the browser version).
- When you close the window, the child uvicorn process is terminated.

## Configuration

By default the app loads `config.yaml` from inside the bundle (the one that
was current when you built the `.app`). To edit clusters or VPN settings
without rebuilding, drop an override at:

```
~/Library/Application Support/gpu-access-board/config.yaml
```

`config.py` checks that path first; fall-through is the bundled copy. You can
also point `$GPU_ACCESS_BOARD_CONFIG` at any file.

Cluster definitions edited via the in-app Settings dialog persist to the
WebView's `localStorage`, so the simplest workflow is: ship with empty
clusters, add them through the UI.

## Updating cluster IPs after install

Three options, from least friction to most:

1. **In-app Settings → Clusters** — persists to WebView `localStorage`.
2. **Edit** `~/Library/Application Support/gpu-access-board/config.yaml` — affects every launch.
3. **Rebuild** the `.app` with an updated bundled `config.yaml`.

## Files

```
gpu-access-board/macapp/
├── README.md
├── app_entry.py       # PyWebView entry — spawns uvicorn, opens window
├── build_macapp.py    # PyInstaller invocation (icon + bundle)
└── build_icon.sh      # sips + iconutil → build/GPUAccessBoard.icns
```

## Troubleshooting

- **`backend failed to start on 127.0.0.1:<port>`** — usually a missing
  hidden import in PyInstaller. Run the `.app` from a terminal
  (`./dist/GPU\ Access\ Board.app/Contents/MacOS/GPU\ Access\ Board`) to see
  the Python traceback, then add the missing module to `HIDDEN_IMPORTS` or
  `COLLECT_ALL` in `build_macapp.py`.
- **Blank window** — frontend `static/` wasn't bundled. Confirm the
  `--add-data` line in `build_macapp.py` ran and `static/index.html` was
  present at build time.
- **`paramiko` / SSH errors** — make sure `cryptography` is still in
  `COLLECT_ALL`; PyInstaller often misses its compiled `.so` files.
- **First launch hangs forever** — port collision or VPN check. Open Activity
  Monitor → kill `GPU Access Board` → re-launch.
