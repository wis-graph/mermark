//! SQLite DB viewer backend: three read-only commands (`sqlite_tables`,
//! `sqlite_table_info`, `sqlite_rows`) built on `rusqlite`. Unlike sql.js
//! (which loads an entire database into memory as a WASM heap), rusqlite
//! lets SQLite read pages straight off disk, so opening a multi-gigabyte
//! database costs no more than the pages actually touched — the reason this
//! viewer exists as a native command instead of a browser-side library.
//!
//! Every command is stateless: each call opens its own read-only connection
//! (`open_readonly`) and lets it drop on return. There is no managed session
//! like `hwp::HwpState` because there is nothing worth keeping alive between
//! calls — the frontend re-opens per query, and SQLite's own page cache /
//! the OS file cache make repeated opens of the same file cheap.
use rusqlite::{Connection, OpenFlags};
use std::time::{Duration, Instant};

/// Wall-clock budget for any single query run on a connection from
/// `open_readonly` (a `COUNT(*)`, a `PRAGMA`, a `SELECT ... LIMIT ...`). This
/// is a pathological-input safety guard, not a UI-facing SLA — a normal
/// `COUNT(*)` over even a very large, honest table finishes in well under a
/// second, so 15s is never felt by a legitimate query. What it exists to
/// catch: this viewer opens arbitrary, untrusted `.db` files, and nothing
/// stops one from defining `CREATE VIEW evil AS WITH RECURSIVE r(x) AS
/// (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT x FROM r` — counting or
/// selecting from that view spins SQLite's VM forever with no I/O to time
/// out on. This is the same shape of guard as hwp.rs's
/// `PARSE_TIMEOUT`/`RENDER_TIMEOUT` (a wall-clock ceiling around untrusted
/// input), applied in-connection via `progress_handler` instead of
/// `tokio::time::timeout`, because it's SQLite's own execution loop that
/// needs interrupting, not an async task.
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// How many SQLite VM instructions elapse between progress-handler checks
/// (`sqlite3_progress_handler`'s `num_ops`). Small enough that a runaway
/// query is caught promptly once `QUERY_TIMEOUT` has elapsed; large enough
/// that checking the wall clock this often is not measurable against a
/// normal query's own work.
const PROGRESS_STEP: std::ffi::c_int = 10_000;

/// Percent-encode a filesystem path into SQLite's URI-filename form
/// (https://www.sqlite.org/uri.html), leaving `/` untouched. SQLite's URI
/// parser treats a bare `?`, `#`, or `%` in the path as a query/fragment
/// delimiter or escape introducer, so a path containing one (rare, but a
/// user's directory tree can contain anything) would otherwise truncate or
/// misparse the connection string; encoding each `/`-delimited segment on
/// its own keeps the path shape intact while making every other character
/// wire-safe.
fn path_to_sqlite_uri(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Open `path` read-only and immutable, with `QUERY_TIMEOUT` as the interrupt
/// deadline — the one function every command in this module goes through to
/// touch a database file. See `open_readonly_with_timeout` for what each of
/// the two safety properties (immutable/read-only, and the progress-handler
/// deadline) means and why.
fn open_readonly(path: &str) -> rusqlite::Result<Connection> {
    open_readonly_with_timeout(path, QUERY_TIMEOUT)
}

/// `open_readonly`'s testable core: same read-only/immutable open, plus a
/// caller-chosen interrupt deadline instead of the hardcoded `QUERY_TIMEOUT`,
/// so a test can prove the pathological-input guard actually fires (and does
/// so quickly, e.g. 300ms) without waiting out the real 15s budget. Only
/// tests call this directly — every command in this module goes through
/// `open_readonly`.
///
/// Two independent safety properties, both established here:
/// - **Read-only + immutable**: `immutable=1` tells SQLite the file will
///   never change while open — no `-wal`/`-shm` sidecars are consulted and no
///   lock is taken. That is an intentional trade-off (a
///   committed-but-not-yet-checkpointed WAL write is invisible to this
///   viewer) accepted because a viewer's job is to show what is safely on
///   disk, not to race a live writer for its latest row — and in exchange
///   this connection can never contend with (or corrupt) whatever else has
///   the same file open. `SQLITE_OPEN_URI` is required for `immutable=1` to
///   be recognized at all (it is a URI query parameter, not an `OpenFlags`
///   bit), which is why the path is run through `path_to_sqlite_uri` first
///   rather than passed as a plain filename.
/// - **Progress-handler deadline**: every query later run on this connection
///   is interrupted with `SQLITE_INTERRUPT` once wall-clock time crosses
///   `deadline` (see `QUERY_TIMEOUT` for the "why" — an adversarial
///   recursive view, not a slow honest query). The deadline is captured once
///   at open time and moved into the closure, and since every command opens
///   a fresh connection, the budget never carries over between unrelated
///   calls. An interrupted query surfaces as an ordinary `rusqlite::Error`,
///   which the existing `.map_err(...)?` call sites already turn into a
///   human-readable `CONFLICT`-free `String` error — no new error path
///   needed.
fn open_readonly_with_timeout(path: &str, timeout: Duration) -> rusqlite::Result<Connection> {
    let uri = format!("file:{}?immutable=1", path_to_sqlite_uri(path));
    let conn = Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?;
    let deadline = Instant::now() + timeout;
    conn.progress_handler(PROGRESS_STEP, Some(move || Instant::now() >= deadline))?;
    Ok(conn)
}

/// Quote a SQLite identifier (a table name) for safe interpolation into a
/// query string: wrap it in double quotes and double any embedded quote
/// (SQL's own escape convention for a quoted identifier). This viewer never
/// accepts user-authored SQL — `table` always originates from
/// `sqlite_tables`'s `sqlite_master` scan — but it still arrives back over
/// IPC and gets re-embedded into `SELECT * FROM "<table>"` and
/// `PRAGMA table_info("<table>")`, so every place that does that embedding
/// goes through this one function instead of trusting the string verbatim.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// One entry in `sqlite_tables`'s listing: a table or view name plus which
/// one it is. `kind` is `"table"` or `"view"` — a plain string rather than an
/// enum so the wire shape needs no serde tagging, mirroring `LinkTarget`'s
/// `kind` field in `commands.rs`.
#[derive(serde::Serialize)]
pub struct SqliteObject {
    pub name: String,
    pub kind: String,
}

/// List every table and view in the database: tables first, then views,
/// each group alphabetical. `sqlite_%` names are SQLite's own internal
/// bookkeeping tables (autoindex, sequence, stat) and are never a viewer
/// target, so they are excluded at the query level rather than filtered out
/// afterward.
#[tauri::command]
pub fn sqlite_tables(path: String) -> Result<Vec<SqliteObject>, String> {
    let conn = open_readonly(&path).map_err(|e| format!("open {path}: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY type = 'view', name",
        )
        .map_err(|e| format!("prepare sqlite_tables: {e}"))?;
    let rows = stmt
        .query_map([], |row| Ok(SqliteObject { name: row.get(0)?, kind: row.get(1)? }))
        .map_err(|e| format!("query sqlite_tables: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read sqlite_tables: {e}"))
}

/// `sqlite_table_info`'s success shape: a table's column names, their
/// declared SQL types (as stored in the schema, e.g. `"INTEGER"`/`"TEXT"`),
/// and its total row count. Serialized camelCase (`columnTypes`/`rowCount`)
/// per the fixed frontend IPC contract — `sqlite-viewer.ts` reads these
/// exact field names.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteTableInfo {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub row_count: i64,
}

/// Column names/types plus the row count for `table`. `PRAGMA table_info`
/// supplies the schema in the same column order `SELECT *` produces, which
/// `sqlite_rows` relies on to line each cell up with its column; the
/// `COUNT(*)` that follows is a full table scan and, on a very large table,
/// the slowest part of opening a tab. Accepted for v1 since it runs once per
/// tab-open rather than once per row page.
#[tauri::command]
pub fn sqlite_table_info(path: String, table: String) -> Result<SqliteTableInfo, String> {
    let conn = open_readonly(&path).map_err(|e| format!("open {path}: {e}"))?;
    let quoted = quote_ident(&table);

    let mut pragma = conn
        .prepare(&format!("PRAGMA table_info({quoted})"))
        .map_err(|e| format!("prepare table_info {table}: {e}"))?;
    let mut columns = Vec::new();
    let mut column_types = Vec::new();
    let mut col_rows =
        pragma.query([]).map_err(|e| format!("query table_info {table}: {e}"))?;
    while let Some(row) =
        col_rows.next().map_err(|e| format!("read table_info {table}: {e}"))?
    {
        // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk.
        let name: String = row.get(1).map_err(|e| format!("table_info {table} name: {e}"))?;
        let ty: String = row.get(2).map_err(|e| format!("table_info {table} type: {e}"))?;
        columns.push(name);
        column_types.push(ty);
    }
    // A table with zero columns can't exist in SQLite, so an empty result
    // here means `table` never matched a real table/view — PRAGMA table_info
    // silently returns no rows for an unknown name instead of erroring.
    if columns.is_empty() {
        return Err(format!("table not found: {table}"));
    }

    let row_count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| row.get(0))
        .map_err(|e| format!("count {table}: {e}"))?;

    Ok(SqliteTableInfo { columns, column_types, row_count })
}

/// Convert one result-set cell to the wire shape `sqlite_rows` returns:
/// `None` for SQL `NULL`, otherwise a display string chosen by the value's
/// *runtime* type (SQLite is dynamically typed per cell, so this dispatches
/// on what is actually stored, not the column's declared type — the same
/// column can hold an `Integer` in one row and a `Text` in another).
/// Integers and reals are rendered as text rather than round-tripped through
/// `serde_json::Number`, which would either clip an `i64` outside the
/// f64-safe range or reformat a float; a blob never surfaces its raw bytes,
/// only a byte count, because this is a browser table, not a hex dump. Named
/// so this rule lives in one place instead of being inlined into
/// `sqlite_rows`'s row-mapping closure.
fn cell_to_string(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Option<String>> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(idx)? {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(format!("BLOB ({} bytes)", b.len())),
    })
}

/// Fetch one page (`LIMIT`/`OFFSET`) of rows from `table`, each row as a
/// `Vec<Option<String>>` in the same column order `sqlite_table_info`
/// reports (see `cell_to_string` for the per-cell conversion rule). `table`
/// is re-embedded via `quote_ident`, the module's one identifier-quoting
/// choke point — there is no user-authored SQL anywhere in this module for
/// an unquoted identifier to leak into.
#[tauri::command]
pub fn sqlite_rows(
    path: String,
    table: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let conn = open_readonly(&path).map_err(|e| format!("open {path}: {e}"))?;
    let quoted = quote_ident(&table);
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2"))
        .map_err(|e| format!("prepare rows {table}: {e}"))?;
    let column_count = stmt.column_count();
    let rows = stmt
        .query_map(rusqlite::params![limit, offset], |row| {
            (0..column_count).map(|i| cell_to_string(row, i)).collect()
        })
        .map_err(|e| format!("query rows {table}: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read rows {table}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_db_path(tag: &str) -> String {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!("mermark_sqlite_test_{}_{}_{tag}.db", std::process::id(), n))
            .to_string_lossy()
            .into_owned()
    }

    /// Build a fresh on-disk database at `path` via a normal (writable)
    /// connection, run `setup` to create/populate it, then let the
    /// connection drop — so every command under test opens its own
    /// read-only handle exactly the way the real IPC path does, never
    /// racing a still-open writer.
    fn seed_db(path: &str, setup: impl FnOnce(&Connection)) {
        let conn = Connection::open(path).unwrap();
        setup(&conn);
    }

    // --- quote_ident ---

    #[test]
    fn quote_ident_escapes_embedded_quotes() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn quote_ident_wraps_plain_name() {
        assert_eq!(quote_ident("users"), "\"users\"");
    }

    // --- path_to_sqlite_uri ---

    #[test]
    fn path_to_sqlite_uri_encodes_special_chars_but_keeps_slashes() {
        assert_eq!(
            path_to_sqlite_uri("/a b/c?d#e%f.db"),
            "/a%20b/c%3Fd%23e%25f.db"
        );
    }

    // --- open_readonly ---

    #[test]
    fn open_readonly_rejects_writes() {
        let p = temp_db_path("readonly_write");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
        });
        let ro = open_readonly(&p).unwrap();
        let err = ro.execute("INSERT INTO t VALUES (1)", []).unwrap_err();
        assert!(
            format!("{err}").to_lowercase().contains("read"),
            "expected a read-only rejection, got: {err}"
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn open_readonly_opens_paths_with_spaces_and_unicode() {
        let p = temp_db_path("특수 경로 space");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
        });
        assert!(open_readonly(&p).is_ok());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn open_readonly_opens_paths_with_uri_special_characters() {
        // `?`, `#`, `%` are all valid bytes in a Unix file name but have
        // special meaning in a SQLite URI filename — this is the case
        // path_to_sqlite_uri exists to close.
        let p = temp_db_path("weird?#%chars");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
        });
        assert!(
            open_readonly(&p).is_ok(),
            "a path containing ?, #, % must still open"
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn open_readonly_missing_file_is_err_not_panic() {
        let p = temp_db_path("missing_never_created");
        assert!(open_readonly(&p).is_err());
    }

    // --- progress-handler deadline (HIGH audit fix: pathological recursive
    // views must not hang a command thread forever) ---

    #[test]
    fn progress_handler_interrupts_pathological_recursive_view() {
        // A view over an infinite `WITH RECURSIVE` CTE (no base case that
        // terminates) spins SQLite's VM forever with no I/O to time out on —
        // exactly the malicious-.db shape QUERY_TIMEOUT/PROGRESS_STEP guard
        // against. Uses a short 300ms deadline (not the real 15s
        // QUERY_TIMEOUT) so this test proves the mechanism without being slow.
        let p = temp_db_path("recursive_view");
        seed_db(&p, |conn| {
            conn.execute_batch(
                "CREATE VIEW evil AS \
                 WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) \
                 SELECT x FROM r;",
            )
            .unwrap();
        });
        let conn = open_readonly_with_timeout(&p, Duration::from_millis(300)).unwrap();
        let start = Instant::now();
        let result: rusqlite::Result<i64> =
            conn.query_row("SELECT COUNT(*) FROM evil", [], |row| row.get(0));
        let elapsed = start.elapsed();
        assert!(
            result.is_err(),
            "an infinite recursive view's COUNT(*) must be interrupted, not hang"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "must be interrupted near the 300ms deadline, not run away; took {elapsed:?}"
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn progress_handler_does_not_interrupt_normal_queries() {
        // Regression guard: even a short 300ms deadline must be ample for a
        // normal, small, honest query — the handler only fires on runaway
        // execution, never on ordinary work.
        let p = temp_db_path("normal_short_deadline");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
            for i in 1..=50 {
                conn.execute("INSERT INTO t VALUES (?1)", [i]).unwrap();
            }
        });
        let conn = open_readonly_with_timeout(&p, Duration::from_millis(300)).unwrap();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 50);
        std::fs::remove_file(&p).ok();
    }

    // --- sqlite_tables ---

    #[test]
    fn tables_lists_tables_then_views_alphabetically() {
        let p = temp_db_path("tables");
        seed_db(&p, |conn| {
            conn.execute_batch(
                "CREATE TABLE zebra (x INTEGER);
                 CREATE TABLE apple (x INTEGER);
                 CREATE VIEW zzz_view AS SELECT * FROM apple;
                 CREATE VIEW aaa_view AS SELECT * FROM apple;",
            )
            .unwrap();
        });
        let got = sqlite_tables(p.clone()).unwrap();
        let order: Vec<(&str, &str)> =
            got.iter().map(|o| (o.name.as_str(), o.kind.as_str())).collect();
        assert_eq!(
            order,
            vec![
                ("apple", "table"),
                ("zebra", "table"),
                ("aaa_view", "view"),
                ("zzz_view", "view"),
            ]
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn tables_excludes_sqlite_internal_tables() {
        let p = temp_db_path("sqlite_internal");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER PRIMARY KEY AUTOINCREMENT);")
                .unwrap();
        });
        let got = sqlite_tables(p.clone()).unwrap();
        assert!(
            got.iter().all(|o| !o.name.starts_with("sqlite_")),
            "got {:?}",
            got.iter().map(|o| &o.name).collect::<Vec<_>>()
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn sqlite_tables_missing_file_is_graceful_err() {
        let p = temp_db_path("tables_missing");
        assert!(sqlite_tables(p).is_err());
    }

    #[test]
    fn sqlite_tables_of_corrupted_file_is_err_not_panic() {
        let p = temp_db_path("corrupt");
        std::fs::write(&p, b"this is not a sqlite database").unwrap();
        assert!(
            sqlite_tables(p.clone()).is_err(),
            "a corrupted file must be Err, not a panic"
        );
        std::fs::remove_file(&p).ok();
    }

    // --- sqlite_table_info ---

    #[test]
    fn table_info_reports_columns_types_and_row_count() {
        let p = temp_db_path("table_info");
        seed_db(&p, |conn| {
            conn.execute_batch(
                "CREATE TABLE users (id INTEGER, name TEXT, score REAL);
                 INSERT INTO users VALUES (1, 'a', 1.5);
                 INSERT INTO users VALUES (2, 'b', 2.5);",
            )
            .unwrap();
        });
        let info = sqlite_table_info(p.clone(), "users".into()).unwrap();
        assert_eq!(info.columns, vec!["id", "name", "score"]);
        assert_eq!(info.column_types, vec!["INTEGER", "TEXT", "REAL"]);
        assert_eq!(info.row_count, 2);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn table_info_missing_table_is_err() {
        let p = temp_db_path("table_info_missing_table");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
        });
        assert!(sqlite_table_info(p.clone(), "nope".into()).is_err());
        std::fs::remove_file(&p).ok();
    }

    // --- sqlite_rows ---

    #[test]
    fn rows_paginate_with_limit_and_offset() {
        let p = temp_db_path("rows_page");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
            for i in 1..=5 {
                conn.execute("INSERT INTO t VALUES (?1)", [i]).unwrap();
            }
        });
        let page1 = sqlite_rows(p.clone(), "t".into(), 2, 0).unwrap();
        let page2 = sqlite_rows(p.clone(), "t".into(), 2, 2).unwrap();
        assert_eq!(page1, vec![vec![Some("1".to_string())], vec![Some("2".to_string())]]);
        assert_eq!(page2, vec![vec![Some("3".to_string())], vec![Some("4".to_string())]]);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rows_offset_past_end_is_empty() {
        let p = temp_db_path("rows_past_end");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);")
                .unwrap();
        });
        let got = sqlite_rows(p.clone(), "t".into(), 10, 100).unwrap();
        assert!(got.is_empty());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rows_convert_null_integer_and_blob() {
        let p = temp_db_path("rows_types");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (a INTEGER, b BLOB, c TEXT)").unwrap();
            conn.execute(
                "INSERT INTO t VALUES (?1, ?2, ?3)",
                rusqlite::params![42, vec![1u8, 2, 3, 4], Option::<String>::None],
            )
            .unwrap();
        });
        let got = sqlite_rows(p.clone(), "t".into(), 10, 0).unwrap();
        assert_eq!(
            got,
            vec![vec![Some("42".to_string()), Some("BLOB (4 bytes)".to_string()), None]]
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn sqlite_rows_missing_table_is_err() {
        let p = temp_db_path("rows_missing_table");
        seed_db(&p, |conn| {
            conn.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
        });
        assert!(sqlite_rows(p.clone(), "nope".into(), 10, 0).is_err());
        std::fs::remove_file(&p).ok();
    }
}
