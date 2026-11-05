#!/bin/bash
# One command for LUT preparation and video-use rendering; no shell profile changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GRADE_PYTHON="${STUDIO_COLOR_GRADE_PYTHON:-$HOME/.studio-engine/color-grade/venv/bin/python}"

# The full FFmpeg build supplies zscale for HLG/PQ input. These Homebrew packages
# are keg-only, so prefer them for this process without changing the user's defaults.
for GRADE_PREFIX in /usr/local /opt/homebrew; do
  if [ -d "$GRADE_PREFIX/opt/ruby@3.4/bin" ]; then
    export PATH="$GRADE_PREFIX/opt/ruby@3.4/bin:$PATH"
  fi
  if [ -d "$GRADE_PREFIX/opt/ffmpeg-full/bin" ]; then
    export PATH="$GRADE_PREFIX/opt/ffmpeg-full/bin:$PATH"
  fi
done

if [ ! -x "$GRADE_PYTHON" ]; then
  echo "Color-grade Python environment is missing. Run: bash \"$SCRIPT_DIR/install.sh\"" >&2
  exit 1
fi

exec "$GRADE_PYTHON" "$SCRIPT_DIR/grade_batch.py" "$@"
