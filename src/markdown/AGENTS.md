# MARKDOWN SUBSYSTEM

## OVERVIEW

Parser, inline/block rendering, CodeMirror live-preview features, widgets, links, footnotes, lists, tables, Mermaid, and embeds live here.

## WHERE TO LOOK

- `parser.ts`, `inline-render.ts`: syntax parsing and safe inline DOM construction.
- `live-preview/`: feature registry, block/inline extensions, and CodeMirror compartments.
- `mermaid-widget.ts`, `table-widget.ts`, `code-widget.ts`: heavyweight rendering boundaries.
- `find.ts`, `wikilink*.ts`, `footnote*.ts`, `image*.ts`: navigation and document-reference behavior.

## CONVENTIONS

- Block decorations come from stateful CodeMirror fields; preserve cursor, selection, undo, fold, and Vim state when reloading features.
- Prefer `createElement`/`textContent` over HTML injection for document content.
- Feature conflicts are first-claim-wins; registry IDs and behavior are persisted/tested contracts.
- Geometry-sensitive behavior needs browser/golden validation in addition to jsdom tests.

## ANTI-PATTERNS

- Never let raw untrusted Markdown become `innerHTML` or inline SVG.
- Do not add a second writer for theme, zoom, or font settings; route changes through the existing sink.
- Do not treat jsdom geometry as proof of rendered layout.

## NOTES

The broad regression surface is `tests/render-smoke.test.ts`; visual widget changes also need the matching golden harness.
