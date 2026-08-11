# Full-text search product contract (decision gate)

**Decision date:** 2026-08-11
**Scope:** product contract only; no search implementation
**Source finding:** `CODE_REVIEW.md` F-05
**Status:** deferred pending explicit approval

> **not approved for implementation**

This record separates the existing file finder from a possible future document
content search. It is a decision artifact, not an implementation specification
that authorizes code changes. Until a later approval names this contract (or a
superseding one), the existing filename/path finder remains the only search
behavior.

## 1. Current filename/path finder contract

The current `⌘⇧F` action is named **파일 찾기** (file finder), not document
content search.

- `src/sidebar/search/search-panel.ts` owns the UI and never reads file bodies.
- On panel open, the injected `scan(root)` calls the native
  `list_files_recursive` command once. The root is the current explorer root,
  or the existing base-directory fallback when no explorer root is selected.
- The native result is `ScanResult { files, truncated }`; each `FileHit` has
  `name`, normalized absolute `path`, and forward-slash `rel_path`.
- The Rust walk is read-only, does not follow directory symlinks, excludes
  generated/heavy directories and mermark artifacts, and currently bounds the
  walk at depth 12 and 10,000 files. `truncated: true` is shown as a partial
  scan banner. A missing/unreadable root is an error, not an empty result.
- The frontend caches the result for the lifetime of one panel opening. Each
  keystroke runs only client-side fuzzy subsequence ranking over `rel_path`,
  with the existing `MAX_RESULTS = 50` cap. Closing and reopening starts a fresh
  scan; stale asynchronous responses are ignored by root/generation guards.
- Arrow Up/Down moves one highlighted row and scrolls it into view. Enter opens
  an openable row in the current window; Cmd/Ctrl+Enter uses the injected new
  window callback when available; Escape closes the panel. IME composition
  Enter is not treated as activation. Non-openable rows are inert. Opening a
  file reuses the existing read/commit/open path; this contract introduces no
  second open or IPC path.

This contract is intentionally unchanged by this decision. In particular,
`search.files`, its shortcut, its labels, its result shape, and its bounded
filename/path behavior are compatibility requirements.

## 2. Decision options

| Option | Behavior | Benefits | Costs and risks |
| --- | --- | --- | --- |
| A. Retain the finder only | Keep filename and relative-path fuzzy search as the complete search surface. | Zero privacy/index cost; predictable latency; no body decoding or stale index. | Users cannot find a note from body text or tags. F-05 remains a documented product gap. |
| B. Add an on-demand content search | Keep Option A and add a separately named action that scans eligible files only after a query. No persistent index. | Smallest architecture; results reflect disk at scan time; easy to discard on cancel. | Repeated scans cost I/O/CPU; large vaults need hard budgets; body searches must handle encoding and file races. |
| C. Add a persistent per-vault index | Keep Option A and maintain a local index of eligible body/title/tag tokens. | Fast repeated queries and incremental updates after the first index. | Index lifecycle, deletion/privacy, corruption recovery, watcher coupling, and migration become durable product obligations. |
| D. Metadata-first hybrid | Search filename/path plus parsed Markdown title/frontmatter/inline tags on demand, then offer body search separately. | Addresses common “find my note” intent with less content exposure and lower cost than full indexing. | Tag syntax and frontmatter precedence need a product definition; users may still expect arbitrary body matches. |

### Default recommendation

Adopt **Option A now** and preserve the current finder unchanged. If a later
product decision approves content search, start with **Option B** as a bounded,
user-triggered experiment. Do not introduce a persistent index (Option C) until
measured on-demand search fails the performance budget and a separate privacy
and lifecycle decision approves local indexing. Option D may be evaluated as a
follow-up, but it must not silently change what the current “파일 찾기” action
means.

## 3. Proposed content-search contract (only if separately approved)

The following is the minimum contract to approve before implementation. Values
marked “proposed” are defaults for a future approval, not current behavior.

### Scope and inputs

- The new action must have a distinct user-visible name and command/shortcut;
  it must not repurpose `search.files` or alter the finder’s labels.
- The default scope is the selected explorer root. Scope changes are explicit;
  no scan may silently expand to the home directory or sibling folders.
- Candidate enumeration inherits the current safety rules: no directory
  symlink traversal, no generated/heavy directories, and a visible partial
  result when a bound is reached.
- A query is literal text by default. Case sensitivity, regular expressions,
  and whole-word matching are separate, explicit controls if they are added;
  they are not inferred from punctuation.

### UTF-8, binary, and large-file policy

- Decode files as UTF-8 only. A file with invalid UTF-8 or a binary/NUL-byte
  signature is skipped as **binary/unsearchable**, with a count in the result
  status; it is never replaced, rewritten, or treated as an empty document.
- Search only regular files whose size is at or below the proposed **2 MiB
  per-file limit**. The proposed aggregate read budget is **256 MiB per
  request**. A request that reaches either limit returns a visible partial
  status and the files already searched; it must not claim exhaustive results.
- Markdown extensions are the first eligible set. Other extensions require an
  explicit format decision and tests; “text-like” MIME guessing alone is not a
  sufficient inclusion rule.
- A file read race (deleted, unreadable, or changed during the scan) produces a
  skipped/error count and diagnostic detail safe for the local UI. It does not
  discard already returned matches or overwrite an editor buffer.

### Title and tag semantics

If metadata search is approved, the contract must define these independently
from arbitrary body matches:

- title: the first Markdown ATX heading, with a documented tie-break if more
  than one heading exists;
- frontmatter tags: only a supported YAML/TOML frontmatter shape, with a
  malformed block reported as metadata-unavailable rather than guessed;
- inline tags: only a documented `#tag` grammar, excluding code fences and
  escaped hashes.

No implementation may claim “tag search” until these parsing rules and fixture
cases (including non-ASCII tags) are approved.

### Result shape and navigation

Each content match must carry a normalized absolute path, relative display path,
1-based line number, 1-based column, and a bounded snippet with the match
highlighted. Results are grouped by file but retain deterministic line order.

- Arrow Up/Down, Home/End, Enter, Cmd/Ctrl+Enter, and Escape must have a
  documented behavior and preserve the existing IME rule.
- Enter opens the file through the existing read/commit/open flow, then places
  the caret at the reported line/column when the file still matches the read
  version. Cmd/Ctrl+Enter uses the existing new-window route.
- If the file changed, disappeared, or became unreadable before activation,
  navigation must re-read and either rebase to a verified match or show a
  recoverable stale-result error. It must never silently jump to an unrelated
  line or overwrite disk content.
- A partial/cancelled result set is labeled as such. “No matches” is reserved
  for a completed search with zero matches.

### Indexing and privacy limits

- The default proposed mode is on-demand and local-only: no upload, telemetry,
  crash-log body text, or network request may contain query, snippet, or note
  content.
- No persistent index is allowed under this contract. If Option C is later
  selected, it needs a new decision covering opt-in, exact on-disk location,
  permissions, deletion on vault removal, corruption/rebuild behavior,
  sensitive-content exclusions, and whether the index itself is encrypted.
- Search must honor the selected-root boundary and existing hidden/artifact
  policy. It must not follow symlinks outside the root or index files the user
  did not select.

### Cancellation and concurrency

- Every request receives a cancellation token/`AbortSignal` and checks it
  between files and bounded chunks. Cancellation is a normal outcome, not an
  error toast.
- Cancellation leaves the previous completed result visible (or a clearly
  labeled partial result if none existed); it never mutates a persistent index
  under the proposed mode.
- A newer query or scope supersedes an older one. Late responses must be
  ignored by a request-generation guard, including after repeated cancellation
  and resume attempts. There must be no unbounded promise, worker, or IPC
  queue after cancellation.

### Performance budget

The future implementation must report measurements on a representative
macOS/Tauri runtime and fixture vault before the budget is changed. Proposed
initial budgets are:

- query debounce: **150 ms**;
- first visible result after the debounce: **500 ms p95** for 1,000 eligible
  files / 50 MiB total;
- bounded completion: **2 s p95** for 10,000 eligible files / 256 MiB total;
- cancellation acknowledgement: **100 ms p95** at a file/chunk boundary;
- UI main-thread blocking: **no task over 16 ms** attributable to scanning or
  result rendering;
- if a persistent index is ever approved: warm query **100 ms p95**, with
  indexing performed off the UI thread and progress/cancel visible.

Exceeding a budget is a product/architecture decision point. It does not
authorize raising limits, hiding partial results, or adding a background index
without approval.

## 4. Risks and mitigations

- **Privacy leakage:** local-only I/O and no body text in logs/telemetry; index
  requires a separate opt-in decision.
- **False “no matches”:** strict completion/partial/cancel labels and visible
  skipped-file counts.
- **Stale navigation:** path + line/column version check before activation;
  recoverable re-read on mismatch.
- **Resource exhaustion:** per-file, aggregate, file-count, depth, debounce,
  and cancellation bounds; no unbounded recursive walk or worker queue.
- **Encoding ambiguity:** UTF-8-only policy with explicit binary/unsearchable
  state; no lossy replacement presented as authoritative text.
- **Scope creep:** preserve `search.files`; require a named follow-up approval
  for metadata semantics, persistent indexing, new formats, or new IPC.

## 5. Future implementation acceptance criteria

Implementation may start only after an explicit approval references this file
and selects the option, limits, and shortcut. A later implementation is not
accepted unless all of the following have evidence:

1. Existing filename/path finder tests still pass unchanged, including scan
   bounds, truncation/error states, IME-safe keyboard navigation, and current
   window/new-window activation.
2. The new action has a typed frontend/native boundary; no body-search logic is
   added to `search.files` or hidden inside the existing file-open callback.
3. UTF-8, binary, invalid-encoding, size-limit, aggregate-limit, hidden-file,
   symlink, malformed-metadata, and read-race fixtures cover the stated policy.
4. Results prove path/line/column/snippet accuracy and safe navigation after a
   file edit, deletion, or unreadable transition.
5. Cancellation, superseded-query, repeated-interruption, and late-response
   tests prove no stale result, unbounded task, index mutation, or data loss.
6. Privacy tests/log inspection prove query, body, tags, and snippets do not
   leave the local UI boundary through telemetry, network, or diagnostics.
7. The performance harness captures the stated p95 budgets on the agreed
   fixture and records partial-result behavior at each bound.
8. Browser/native manual QA captures the visible named action, loading,
   partial, cancelled, empty, error, and result-navigation states.
9. Evidence and documentation are updated in the same approved change; no
   implementation is inferred from this contract alone.

## 6. Gate and adversarial disposition

The gate for this artifact is literal: **not approved for implementation**.
This task changes no production source, import, IPC registration, shortcut,
search behavior, or persisted data.

Malformed query, cancellation, resume, hung scan, flaky filesystem, and
repeated-interruption scenarios are **N/A for this decision-only task** because
no search executor or new request lifecycle was added. They are mandatory
future acceptance scenarios (see section 5), not waived implementation work.
