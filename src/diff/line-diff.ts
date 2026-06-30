// Lightweight line-level diff for the conflict modal. No heavy dependency — a
// single-document markdown file is small enough that a line-granularity LCS DP
// is cheap, and it only runs once when a conflict actually opens the modal.
//
// Pure (CQS query): given the local buffer's lines and the external (disk)
// lines, return an ordered list of rows describing how to turn local → external.

export type DiffRowKind = "same" | "removed" | "added";

/** One visual row of the diff. `removed` = present in local, gone on disk;
 *  `added` = new on disk, absent locally; `same` = unchanged line. */
export interface DiffRow {
  kind: DiffRowKind;
  /** The local line (for `same`/`removed`). */
  local?: string;
  /** The external/disk line (for `same`/`added`). */
  external?: string;
}

/** Diff two line arrays with an LCS backtrack. Lines common to both (in order)
 *  are `same`; lines only in `local` are `removed`; lines only in `external`
 *  are `added`. Pure — no side effects, deterministic. */
export function diffLines(local: string[], external: string[]): DiffRow[] {
  const n = local.length;
  const m = external.length;
  // lcs[i][j] = length of the longest common subsequence of local[i..] and
  // external[j..]. (n+1)×(m+1) table, filled bottom-up.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        local[i] === external[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (local[i] === external[j]) {
      rows.push({ kind: "same", local: local[i], external: external[j] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: "removed", local: local[i] });
      i++;
    } else {
      rows.push({ kind: "added", external: external[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "removed", local: local[i++] });
  while (j < m) rows.push({ kind: "added", external: external[j++] });
  return rows;
}

/** Split text into lines for diffing. Kept here so the modal and the diff share
 *  one definition (a trailing newline doesn't spawn a phantom empty row). */
export function toDiffLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}
