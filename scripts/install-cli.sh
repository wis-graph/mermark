#!/usr/bin/env bash
set -euo pipefail

# Install a tiny exec-wrapper script for mermark onto your PATH.
# NOT a symlink: tauri caches current_exe() before main() and, on macOS,
# refuses a path containing a symlink (StartingBinary guard) — so an app
# instance launched through a symlinked CLI can never check/install updates
# ("StartingBinary found current_exe() that contains a symlink…"). A wrapper
# execs the real binary, so current_exe() is the true path and the in-app
# updater works from CLI launches too.
# Usage: ./scripts/install-cli.sh [dest]   (default dest: /usr/local/bin/mermark)

APP_BIN="/Applications/mermark.app/Contents/MacOS/mermark"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_BIN="$ROOT/src-tauri/target/release/mermark"
DEST="${1:-/usr/local/bin/mermark}"

# Prefer the installed app (the binary the auto-updater keeps current);
# fall back to the repo's release build for dev machines without an install.
if [ -x "$APP_BIN" ]; then
  BIN="$APP_BIN"
elif [ -x "$DEV_BIN" ]; then
  BIN="$DEV_BIN"
else
  echo "no mermark binary found — install mermark.app or build first: npm run tauri build" >&2
  exit 1
fi

rm -f "$DEST"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$BIN" > "$DEST"
chmod +x "$DEST"
echo "installed wrapper $DEST -> $BIN"
echo "now run: mermark <file.md>"
