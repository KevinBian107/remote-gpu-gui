"""Load configuration for gpu-access-board.

Lookup order:
  1. $GPU_ACCESS_BOARD_CONFIG (explicit override)
  2. ~/Library/Application Support/gpu-access-board/config.yaml (Mac app users)
  3. config.yaml next to this file (dev / source checkout / PyInstaller bundle)

Lets the same code run as a uvicorn script (loads ./config.yaml) or as a
PyInstaller-bundled .app (Application Support takes priority so users can
edit clusters without re-signing the bundle).
"""
import os
from pathlib import Path

import yaml


def _candidate_paths() -> list[Path]:
    paths: list[Path] = []
    env = os.environ.get("GPU_ACCESS_BOARD_CONFIG")
    if env:
        paths.append(Path(env).expanduser())
    paths.append(
        Path.home()
        / "Library"
        / "Application Support"
        / "gpu-access-board"
        / "config.yaml"
    )
    paths.append(Path(__file__).parent / "config.yaml")
    return paths


def _load() -> dict:
    for p in _candidate_paths():
        if p.is_file():
            with open(p) as f:
                return yaml.safe_load(f) or {}
    return {}


_cfg = _load()

SERVER = _cfg.get("server", {})
PROJECT = _cfg.get("project", {})
CLUSTERS = _cfg.get("clusters", {})
