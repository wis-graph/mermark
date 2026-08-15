# TOOLING DOMAIN

## OVERVIEW

Scripts contain release orchestration, updater-manifest generation, CLI installation, fixture tooling, and Playwright/CDP golden checks.

## WHERE TO LOOK

- `release.sh`: macOS-first release gates, signing, GitHub release, optional Windows dispatch.
- `write-updater-json.mjs`, `lib/build-updater-manifest.mjs`: published updater metadata.
- `*-golden.mjs`: browser-mode visual/runtime checks; require the app and CDP setup described in `README.md`.
- `install-cli.sh`: macOS/Linux wrapper installation.

## CONVENTIONS

- Treat release scripts as stateful operations: use `--dry-run` for inspection and verify the clean branch/version/signing prerequisites.
- Golden scripts are outside `npm test`; they validate real browser behavior beyond jsdom.
- Preserve platform-specific artifact names and updater signature checks.

## ANTI-PATTERNS

- Do not run release/upload/commit/push actions while intending only to inspect behavior.
- Do not copy golden-script shortcuts such as `eval` into application code.
- Do not regenerate `updater.json` before the selected platform assets and signatures are verified.

## NOTES

Golden scripts normally target browser mode on port 1430 with Chromium CDP available on port 9222.
