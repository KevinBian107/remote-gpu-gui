#!/usr/bin/env bash
# Build a macOS .icns from vibes' shared logo using built-in `sips` + `iconutil`.
# Output: gpu-access-board/build/GPUAccessBoard.icns
# Invoked automatically by macapp/build_macapp.py.
set -euo pipefail

MACAPP_DIR="$(cd "$(dirname "$0")" && pwd)"
VIBE_ROOT="$(cd "$MACAPP_DIR/.." && pwd)"
REPO_ROOT="$(cd "$VIBE_ROOT/.." && pwd)"
SRC_SVG="$REPO_ROOT/assets/logo-square.svg"
OUT_DIR="$VIBE_ROOT/build"
ICONSET="$OUT_DIR/GPUAccessBoard.iconset"
ICNS="$OUT_DIR/GPUAccessBoard.icns"

if [[ ! -f "$SRC_SVG" ]]; then
  echo "[build_icon] missing source SVG: $SRC_SVG" >&2
  exit 1
fi

mkdir -p "$ICONSET"

# macOS .icns spec requires icons at these exact filenames + pixel sizes
# (see `man iconutil`).
render() {
  local size="$1" name="$2"
  sips -s format png -z "$size" "$size" "$SRC_SVG" --out "$ICONSET/$name" >/dev/null
}

render 16   icon_16x16.png
render 32   icon_16x16@2x.png
render 32   icon_32x32.png
render 64   icon_32x32@2x.png
render 128  icon_128x128.png
render 256  icon_128x128@2x.png
render 256  icon_256x256.png
render 512  icon_256x256@2x.png
render 512  icon_512x512.png
render 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"

echo "[build_icon] wrote $ICNS"
