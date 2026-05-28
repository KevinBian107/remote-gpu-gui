"""Build the gpu-access-board macOS .app bundle via PyInstaller.

Prereqs (one-time):
  uv sync --extra macapp

Build:
  uv run python gpu-access-board/macapp/build_macapp.py

Output:
  gpu-access-board/dist/GPU Access Board.app

First-launch (unsigned bundle):
  xattr -dr com.apple.quarantine 'gpu-access-board/dist/GPU Access Board.app'
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

MACAPP_DIR = Path(__file__).resolve().parent
VIBE_ROOT = MACAPP_DIR.parent           # gpu-access-board/
DIST_DIR = VIBE_ROOT / "dist"
BUILD_DIR = VIBE_ROOT / "build"

APP_NAME = "GPU Access Board"
ENTRY = MACAPP_DIR / "app_entry.py"
ICON = BUILD_DIR / "GPUAccessBoard.icns"

# Imports PyInstaller's static analysis tends to miss for uvicorn's
# auto-selected loop / protocol / lifespan implementations.
HIDDEN_IMPORTS = [
    "uvicorn.loops.auto",
    "uvicorn.loops.uvloop",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]

# `--collect-all` is conservative: pulls every submodule, data file, and
# compiled .so for the listed package. Slightly larger bundle, far fewer
# "ModuleNotFoundError" surprises at runtime.
COLLECT_ALL = [
    "uvicorn",
    "fastapi",
    "websockets",
    "paramiko",
    "cryptography",
]


def _check_prereqs() -> None:
    missing = []
    for mod in ("PyInstaller", "webview"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        sys.exit(
            "[build_macapp] missing build deps: "
            + ", ".join(missing)
            + "\n  fix: uv sync --extra macapp"
        )
    if not (VIBE_ROOT / "static" / "index.html").is_file():
        sys.exit(f"[build_macapp] missing static frontend: {VIBE_ROOT / 'static'}")


def _build_icon() -> None:
    script = MACAPP_DIR / "build_icon.sh"
    if script.is_file():
        subprocess.run(["bash", str(script)], check=True)


def _clean() -> None:
    for path in (
        DIST_DIR / f"{APP_NAME}.app",
        DIST_DIR / APP_NAME,
        BUILD_DIR / APP_NAME,
    ):
        if path.is_dir():
            shutil.rmtree(path)
        elif path.is_file():
            path.unlink()


def _pyinstaller_cmd() -> list[str]:
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--windowed",
        "--name", APP_NAME,
        "--add-data", f"{VIBE_ROOT / 'static'}:static",
        "--add-data", f"{VIBE_ROOT / 'config.yaml'}:.",
        "--distpath", str(DIST_DIR),
        "--workpath", str(BUILD_DIR),
        "--specpath", str(BUILD_DIR),
    ]
    if ICON.is_file():
        cmd += ["--icon", str(ICON)]
    for mod in HIDDEN_IMPORTS:
        cmd += ["--hidden-import", mod]
    for mod in COLLECT_ALL:
        cmd += ["--collect-all", mod]
    cmd.append(str(ENTRY))
    return cmd


def main() -> None:
    _check_prereqs()
    _build_icon()
    _clean()
    cmd = _pyinstaller_cmd()
    print("[build_macapp] $ " + " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=VIBE_ROOT)
    out = DIST_DIR / f"{APP_NAME}.app"
    print()
    print(f"[build_macapp] wrote {out}")
    print(
        "[build_macapp] first-launch tip: "
        f"xattr -dr com.apple.quarantine '{out}'"
    )


if __name__ == "__main__":
    main()
