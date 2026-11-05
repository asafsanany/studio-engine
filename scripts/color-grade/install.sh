#!/bin/bash
# Install the requested skill and an isolated Python environment. Does not update
# an existing skill, edit video-use, or change system Ruby/FFmpeg alternatives.
set -euo pipefail

GRADE_ROOT="${STUDIO_COLOR_GRADE_ROOT:-$HOME/.studio-engine/color-grade}"
GRADE_SKILL="${STUDIO_COLOR_GRADE_DIR:-$HOME/.claude/skills/color-grade-ai}"
VIDEO_USE_ROOT="${VIDEO_USE_DIR:-$HOME/Developer/video-use}"
GRADE_BASE_PYTHON="${STUDIO_COLOR_GRADE_BASE_PYTHON:-$VIDEO_USE_ROOT/.venv/bin/python}"
GRADE_REF="a6eef94e0d773b1a9475cd9bac8bc15bc3944f46"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -e "$GRADE_SKILL" ]; then
  mkdir -p "$(dirname "$GRADE_SKILL")"
  git clone --no-checkout https://github.com/isaacrowntree/color-grade-ai.git "$GRADE_SKILL"
  git -C "$GRADE_SKILL" checkout --detach "$GRADE_REF"
fi
for GRADE_FILE in SKILL.md footage_type.py auto_grade.py match_grade.py generate_lut.rb; do
  if [ ! -f "$GRADE_SKILL/$GRADE_FILE" ]; then
    echo "Incomplete color-grade-ai skill: missing $GRADE_SKILL/$GRADE_FILE" >&2
    exit 1
  fi
done
if [ ! -x "$GRADE_BASE_PYTHON" ]; then
  echo "Set STUDIO_COLOR_GRADE_BASE_PYTHON to Python 3.12+ or install video-use's Python environment first." >&2
  exit 1
fi
"$GRADE_BASE_PYTHON" -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required for the pinned dependencies"'
mkdir -p "$GRADE_ROOT"
if [ ! -x "$GRADE_ROOT/venv/bin/python" ]; then
  "$GRADE_BASE_PYTHON" -m venv "$GRADE_ROOT/venv"
fi
"$GRADE_ROOT/venv/bin/python" -m pip install -r "$SCRIPT_DIR/requirements.txt"
echo "Skill: $GRADE_SKILL"
echo "Python: $GRADE_ROOT/venv/bin/python"
echo 'Fitted LUTs also require Ruby 2.7+. HLG/PQ requires FFmpeg with zscale, tonemap, and lut3d.'
echo 'On macOS: brew install ruby@3.4 ffmpeg-full (run.sh uses these without changing defaults).'
echo "Claude Code picks the skill up on its next run."
