# Vendored font licenses

mermark ships these font files inside the application bundle. All four are under the
**SIL Open Font License 1.1**, which permits bundling with software ("The Font Software
may be … bundled, redistributed and/or sold with any software") but requires that each
copy carry its copyright notice and license.

That notice lives in two places, deliberately:

1. **Inside each `.woff2`** — the `name` table's copyright (ID 0) and license (ID 13)
   records travel with the binary even if this file is lost. Any subsetting step MUST
   preserve them (`--name-IDs=*` in fontTools; the default drops ID 13, which is how a
   license notice silently disappears).
2. **This file** — human-readable, and the record of what we did to each font.

The full OFL 1.1 text is at <https://openfontlicense.org/documents/OFL.txt> and is
reproduced verbatim in every upstream font's own distribution.

| File | Family | Copyright | Upstream |
|------|--------|-----------|----------|
| `inter-latin-{400,500,700}-normal.woff2` | Inter | © 2016 The Inter Project Authors | [rsms/inter](https://github.com/rsms/inter) via @fontsource |
| `cormorant-garamond-latin-300-normal.woff2` | Cormorant Garamond | © 2015 The Cormorant Project Authors | [CatharsisFonts/Cormorant](https://github.com/CatharsisFonts/Cormorant) via @fontsource |
| `pretendard-variable.woff2` | Pretendard Variable | © 2023 길형진 | [orioncactus/pretendard](https://github.com/orioncactus/pretendard) (official prebuilt, verbatim) |
| `paperlogy-{600,700}-normal.woff2` | Paperlogy | © 2024 PT& | [Freesentation/paperlogy](https://github.com/Freesentation/paperlogy) v1.001 (official TTF, subset here — see below) |

## Paperlogy — provenance note

Paperlogy is distributed by its authors as **TTF only** (`Paperlogy-1.001.zip`), so a
`.woff2` had to be produced. It was produced **from the publisher's own TTF**, not taken
from a third-party mirror.

This matters. The widely-linked `fonts-archive/Paperlogy` mirror serves a woff2 whose
glyph outlines do **not** match the publisher's TTF — it is a reprocessed derivative
(2,465 glyphs removed, hinting stripped, and its TTF is half the size of the official
one). It is very likely benign, but "very likely benign" is not a standard for a binary
that gets code-signed into a shipping desktop app. We control the conversion instead:

```
fonttools subset Paperlogy-6SemiBold.ttf \
  --unicodes=U+0020-007E,U+00A0-00FF,U+2018-201D,U+2026,U+2013-2014,U+00B7,\
U+AC00-D7A3,U+1100-11FF,U+3130-318F,U+3000-303F,U+FF01-FF60 \
  --layout-features='*' --no-hinting --desubroutinize \
  --name-IDs='*' --name-legacy \
  --flavor=woff2 --output-file=paperlogy-600-normal.woff2
```

Kept: **all 11,172 Hangul syllables**, jamo, Latin + Latin-1, CJK/full-width punctuation.
Dropped: hanja, kana, and unmapped alternates — glyphs a markdown *heading* will not
meet, and which fall through the font stack to system-ui if it ever does.

Result: 137 KB per weight (vs 437 KB unsubset, vs 165 KB for the mirror's derivative).
Two weights are shipped because headings render at 600 and `**bold**` inside a heading
at 700 — synthetic bold on a display face is ugly.

`fsType` is 8 (editable embedding), i.e. embedding is permitted; OFL governs regardless.
