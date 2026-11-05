#!/bin/bash
#
# Stops the Studio Engine launchd agent and removes its plist. The logs and data in
# ~/.studio-engine are kept.
#
#   pnpm agent:uninstall
#
# Environment, for tests and dry runs: STUDIO_AGENT_DIR and STUDIO_AGENT_DRY_RUN, as in
# install-agent.sh.

set -euo pipefail

LABEL="com.studio-engine.server"
AGENT_DIR="${STUDIO_AGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENT_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"
DRY_RUN="${STUDIO_AGENT_DRY_RUN:-}"

if [ -n "$DRY_RUN" ]; then
  echo "Dry run: launchctl was not run and nothing was removed."
  echo "  launchctl bootout $DOMAIN/$LABEL   (only if the agent is loaded)"
  echo "  rm $PLIST   (if it exists)"
  exit 0
fi

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "Stopped $LABEL."
else
  echo "$LABEL is not loaded."
fi

if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "Removed $PLIST."
fi
echo "The logs and data in ~/.studio-engine were kept."
