#!/bin/bash
# Helper to install a codex-tg-bridge instance from the plist templates.
# Substitutes USER / NAME / PORT / STATE_DIR placeholders and bootstraps
# both LaunchAgents.
#
# Usage:
#   ./install.sh <NAME> <APPSERVER_PORT> [STATE_DIR]
# Example:
#   ./install.sh scout 17651
#   ./install.sh research 17652 ~/.codex-tg-bridge/state/research

set -e

NAME="${1:?missing NAME (e.g. 'scout')}"
PORT="${2:?missing APPSERVER_PORT (e.g. 17651)}"
STATE_DIR="${3:-$HOME/.codex-tg-bridge/state/$NAME}"
USERNAME="$(whoami)"

TEMPLATE_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_DIR" "$STATE_DIR" "$HOME/.codex-tg-bridge/logs"

substitute() {
  sed -e "s|@@USER@@|$USERNAME|g" \
      -e "s|@@NAME@@|$NAME|g" \
      -e "s|@@PORT@@|$PORT|g" \
      -e "s|@@STATE_DIR@@|$STATE_DIR|g" "$1"
}

APPSERVER_PLIST="$LAUNCH_DIR/com.btai.codex-appserver.$NAME.plist"
BRIDGE_PLIST="$LAUNCH_DIR/com.btai.codex-tg-bridge.$NAME.plist"

substitute "$TEMPLATE_DIR/com.btai.codex-appserver.scout.plist.template" > "$APPSERVER_PLIST"
substitute "$TEMPLATE_DIR/com.btai.codex-tg-bridge.scout.plist.template" > "$BRIDGE_PLIST"

echo "wrote: $APPSERVER_PLIST"
echo "wrote: $BRIDGE_PLIST"
echo "state_dir: $STATE_DIR"

if [ ! -f "$STATE_DIR/.env" ]; then
  echo
  echo "WARN: $STATE_DIR/.env does not exist yet. Create it:"
  echo "  echo 'TELEGRAM_BOT_TOKEN=...' > $STATE_DIR/.env"
  echo "  chmod 600 $STATE_DIR/.env"
fi

if [ ! -f "$STATE_DIR/access.json" ]; then
  echo
  echo "WARN: $STATE_DIR/access.json does not exist yet. Create it (sample):"
  echo "  cat > $STATE_DIR/access.json <<EOF"
  echo "  {"
  echo "    \"dmPolicy\": \"approved-only\","
  echo "    \"ackReaction\": \"👀\","
  echo "    \"approved\": [{ \"user_id\": \"YOUR_TG_USER_ID\" }]"
  echo "  }"
  echo "  EOF"
fi

echo
echo "Bootstrap (order matters — appserver before bridge):"
echo "  launchctl bootstrap gui/\$(id -u) $APPSERVER_PLIST"
echo "  launchctl bootstrap gui/\$(id -u) $BRIDGE_PLIST"
