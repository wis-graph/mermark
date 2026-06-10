#!/usr/bin/env bash
set -euo pipefail

# Symlink the built mermark binary onto your PATH.
# Usage: ./scripts/install-cli.sh [dest]   (default dest: /usr/local/bin/mermark)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/mermark"
DEST="${1:-/usr/local/bin/mermark}"

if [ ! -x "$BIN" ]; then
  echo "build first: npm run tauri build" >&2
  exit 1
fi

ln -sf "$BIN" "$DEST"
echo "linked $DEST -> $BIN"
echo "now run: mermark <file.md>"
