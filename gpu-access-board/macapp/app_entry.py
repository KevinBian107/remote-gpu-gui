"""PyWebView entry point for the gpu-access-board Mac app.

PyInstaller bundles this script. At runtime it:
  1. Starts the FastAPI backend in a child process on an ephemeral 127.0.0.1 port.
  2. Polls /api/health until it answers (or aborts after 15s).
  3. Opens a native WebView window pointed at the local server.
  4. Tears the child down when the window closes.

Dev usage (no bundling):
  uv run --extra macapp python gpu-access-board/macapp/app_entry.py
"""
from __future__ import annotations

import multiprocessing
import os
import socket
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIBE_ROOT = HERE.parent
# Make app.py / config.py / ssh_manager.py importable when running from source.
# Inside a PyInstaller bundle they're already top-level modules, so this is a no-op.
if str(VIBE_ROOT) not in sys.path:
    sys.path.insert(0, str(VIBE_ROOT))


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _run_server(port: int) -> None:
    # macOS multiprocessing uses "spawn"; the child doesn't inherit sys.path
    # tweaks from the parent, so redo the path insertion here.
    if str(VIBE_ROOT) not in sys.path:
        sys.path.insert(0, str(VIBE_ROOT))
    os.environ["GPU_ACCESS_BOARD_APP_MODE"] = "packaged"

    import uvicorn
    from app import app as fastapi_app

    uvicorn.run(
        fastapi_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )


def _wait_for_health(port: int, timeout: float = 15.0) -> bool:
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.2)
    return False


def main() -> None:
    multiprocessing.freeze_support()
    os.environ.setdefault("GPU_ACCESS_BOARD_APP_MODE", "packaged")

    port = _find_free_port()
    proc = multiprocessing.Process(target=_run_server, args=(port,), daemon=True)
    proc.start()

    if not _wait_for_health(port):
        proc.terminate()
        sys.stderr.write(
            f"gpu-access-board backend failed to start on 127.0.0.1:{port}\n"
        )
        sys.exit(1)

    import webview

    webview.create_window(
        "GPU Access Board",
        f"http://127.0.0.1:{port}/",
        width=1400,
        height=900,
        min_size=(900, 600),
    )
    try:
        webview.start()
    finally:
        proc.terminate()
        proc.join(timeout=3)


if __name__ == "__main__":
    main()
