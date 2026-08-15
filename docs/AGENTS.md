# DOCUMENTATION DOMAIN

## OVERVIEW

`docs/` contains the product feature inventory, architecture/design references, review records, and dated specifications/plans.

## WHERE TO LOOK

- `FEATURES.md`: single inventory of user-observable functionality and architecture layers.
- `design/`: plugin-system and visual/design rationale.
- `reviews/`: intent and architecture review records.
- `superpowers/specs/`, `superpowers/plans/`: dated implementation contracts and plans.
- Root `DESIGN.md`: active visual token and typography source of truth.

## CONVENTIONS

- Prefer recording durable rationale and contracts over generic implementation prose.
- Update `FEATURES.md` in the same change set as user-visible feature changes.
- Preserve dated review/spec records; append or supersede explicitly rather than rewriting history casually.

## ANTI-PATTERNS

- Do not treat a stale plan or review as executable source when current code/config disagrees; verify the implementation files.
- Do not duplicate the full design system in feature docs; link to `DESIGN.md` and record only local constraints.

## NOTES

The root `CLAUDE.md` describes the development orchestration; these documents preserve product and architectural context.
