# SETTINGS SUBSYSTEM

## OVERVIEW

Settings stores, schemas, persistence, sinks, modal panels, theme editing, and update/version controls live here.

## WHERE TO LOOK

- `app.ts`: application settings and typed store definitions.
- `store.ts`, `registry.ts`: persistence and extension-facing setting registration.
- `sinks.ts`, `theme-schema.ts`: one-way DOM/CSS application and theme token validation.
- `panel/`: settings UI, controls, visual theme editor, and changelog/version panes.

## CONVENTIONS

- Treat each setting as an explicit source and bind it to one sink; avoid manual fan-out writers.
- Preserve localStorage keys, setting IDs, defaults, and read-only public views because tests and user data depend on them.
- Theme JSON is the effective token source; keep preset synchronization and DOM application in the existing paths.
- UI changes need jsdom contract tests and, for layout/paint, the relevant browser golden check.

## ANTI-PATTERNS

- Never add arbitrary theme keys outside the schema.
- Do not expose a setter through a read-only API view.
- Do not inline new design hex values; use the token system and `DESIGN.md` guidance.

## NOTES

Settings persistence and DOM sinks are tested independently; preserve both when changing a setting's lifecycle.
