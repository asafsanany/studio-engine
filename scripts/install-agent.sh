#!/bin/bash
#
# Installs Studio Engine as a launchd agent. The server starts at login, restarts if it dies, and
# serves the app on http://localhost:4310 without a terminal.
#
#   pnpm agent:install
#
# Builds the app (pnpm build), resolves absolute paths for node, pnpm, claude and ffmpeg, writes
# ~/Library/LaunchAgents/com.studio-engine.server.plist and loads it with `launchctl bootstrap`.
# Running it again replaces the agent. Run it again after changing Node, and after the Claude
# desktop app updates, because its CLI lives in a folder named after the version.
#
# Environment, for tests and dry runs:
#   STUDIO_AGENT_DIR=<dir>      where the plist is written (default ~/Library/LaunchAgents)
#   STUDIO_AGENT_DRY_RUN=1      write the plist and print the launchctl commands; run no launchctl
#   STUDIO_AGENT_SKIP_BUILD=1   do not run pnpm build; apps/server/dist/index.js must already exist

set -euo pipefail

LABEL="com.studio-engine.server"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${STUDIO_AGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$HOME/.studio-engine/logs"
SERVER_ENTRY="$REPO_DIR/apps/server/dist/index.js"
DOMAIN="gui/$(id -u)"
DRY_RUN="${STUDIO_AGENT_DRY_RUN:-}"

fail() {
  echo "install-agent: $*" >&2
  exit 1
}

# Escapes the XML special characters so any path can sit inside a plist <string>.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

# The absolute path of a command on PATH, or nothing.
on_path() {
  local found
  found="$(command -v "$1" 2>/dev/null || true)"
  case "$found" in
    /*) printf '%s\n' "$found" ;;
  esac
}

# Same order as resolveClaudeBin in scripts/doctor.ts: PATH, then ~/.local/bin, then the newest
# Claude desktop app bundle (<version>/<hash>/claude.app/Contents/MacOS/claude).
find_claude() {
  local bin
  bin="$(on_path claude)"
  if [ -n "$bin" ]; then
    printf '%s\n' "$bin"
    return 0
  fi
  if [ -x "$HOME/.local/bin/claude" ]; then
    printf '%s\n' "$HOME/.local/bin/claude"
    return 0
  fi
  bin="$(ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -n 1 || true)"
  printf '%s\n' "$bin"
}

NODE_BIN="$(on_path node)"
[ -n "$NODE_BIN" ] || fail "node is not on PATH. Install Node 22 (nvm install 22), then run this again."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "found node $NODE_MAJOR at $NODE_BIN; Studio Engine needs Node 22 (nvm use 22)."

PNPM_BIN="$(on_path pnpm)"
CLAUDE_BIN="$(find_claude)"
FFMPEG_BIN="$(on_path ffmpeg)"

if [ -z "${STUDIO_AGENT_SKIP_BUILD:-}" ]; then
  [ -n "$PNPM_BIN" ] || fail "pnpm is not on PATH. Enable it with corepack enable, then run this again."
  echo "Building Studio Engine (pnpm build)..."
  (cd "$REPO_DIR" && "$PNPM_BIN" build)
fi
[ -f "$SERVER_ENTRY" ] || fail "$SERVER_ENTRY is missing. Run pnpm build first."

[ -n "$CLAUDE_BIN" ] || echo "warning: the Claude CLI was not found; edits will fail until it is installed. Run pnpm run doctor." >&2
[ -n "$FFMPEG_BIN" ] || echo "warning: ffmpeg was not found; edits will fail until it is installed. Run pnpm run doctor." >&2

# The PATH the server gets. A launchd job starts with almost none of the shell's PATH, so the
# directories of the tools it needs are listed here, found at install time.
PATH_DIRS=""
add_dir() {
  [ -n "$1" ] || return 0
  case ":$PATH_DIRS:" in
    *":$1:"*) return 0 ;;
  esac
  if [ -z "$PATH_DIRS" ]; then
    PATH_DIRS="$1"
  else
    PATH_DIRS="$PATH_DIRS:$1"
  fi
}
add_dir "$(dirname "$NODE_BIN")"
if [ -n "$PNPM_BIN" ]; then add_dir "$(dirname "$PNPM_BIN")"; fi
if [ -n "$CLAUDE_BIN" ]; then add_dir "$(dirname "$CLAUDE_BIN")"; fi
if [ -n "$FFMPEG_BIN" ]; then add_dir "$(dirname "$FFMPEG_BIN")"; fi
add_dir /opt/homebrew/bin
add_dir "$HOME/.local/bin"
add_dir /usr/bin
add_dir /bin
add_dir /usr/sbin
add_dir /sbin

write_plist() {
  local label node entry workdir path_value home_value out_log err_log
  label="$(xml_escape "$LABEL")"
  node="$(xml_escape "$NODE_BIN")"
  entry="$(xml_escape "$SERVER_ENTRY")"
  workdir="$(xml_escape "$REPO_DIR")"
  path_value="$(xml_escape "$PATH_DIRS")"
  home_value="$(xml_escape "$HOME")"
  out_log="$(xml_escape "$LOG_DIR/server.log")"
  err_log="$(xml_escape "$LOG_DIR/server.err.log")"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$entry</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>HOME</key>
    <string>$home_value</string>
    <key>PATH</key>
    <string>$path_value</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$out_log</string>
  <key>StandardErrorPath</key>
  <string>$err_log</string>
</dict>
</plist>
PLIST
}

mkdir -p "$AGENT_DIR"
TMP_PLIST="$PLIST.tmp"
write_plist > "$TMP_PLIST"
mv "$TMP_PLIST" "$PLIST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$PLIST" >/dev/null || fail "the generated plist is invalid: $PLIST"
fi

if [ -n "$DRY_RUN" ]; then
  echo "Dry run: wrote $PLIST. launchctl was not run and $LOG_DIR was not created."
  echo "  launchctl bootout $DOMAIN/$LABEL   (only if the agent is already loaded)"
  echo "  launchctl bootstrap $DOMAIN $PLIST"
  exit 0
fi

mkdir -p "$LOG_DIR"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Replacing the running agent..."
  launchctl bootout "$DOMAIN/$LABEL"
  # bootout finishes asynchronously; wait so that bootstrap does not race it.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
fi

if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  fail "launchctl bootstrap failed. Check the plist with: plutil -lint \"$PLIST\""
fi

echo "Studio Engine is installed and starts at every login."
echo "Open http://localhost:4310 (or the port set in ~/.studio-engine/config.json)."
echo "Logs: $LOG_DIR"
