# Third-party notices

## Material Icon Theme

mermark vendors a file-only subset of icon SVGs from
[material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme)
for the file explorer / file finder sidebar glyphs (folder icons are
mermark's own Lucide-derived set and are NOT from this package).

- License: MIT — full text at
  `src/sidebar/explorer/material-icons/LICENSE`.
- Copyright (c) Material Extensions.
- The vendored assets are generated (not hand-copied) by
  `scripts/generate-material-icons.mjs` from the `material-icon-theme`
  devDependency; see that script and
  `src/sidebar/explorer/material-icons.generated.ts` for the exact mapping
  and regeneration instructions.
