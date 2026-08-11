#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname "$script_dir")
artifact=${1:-"$repo_dir/.omo/evidence/code-review-remediation/task-2-native-smoke.log"}
mkdir -p "$(dirname "$artifact")"

{
  echo "NATIVE_WATCHER_CHARACTERIZATION"
  echo "invocation: (cd src-tauri && cargo test watcher::characterization -- --nocapture --test-threads=1)"
  (
    cd "$repo_dir/src-tauri"
    cargo test watcher::characterization -- --nocapture --test-threads=1
  )
  echo "FRONTEND_BOUNDARY_CHARACTERIZATION"
  echo "invocation: npm test -- --run tests/file-watch.test.ts"
  (
    cd "$repo_dir"
    npm test -- --run tests/file-watch.test.ts
  )
} >"$artifact" 2>&1

echo "watcher characterization evidence: $artifact"
