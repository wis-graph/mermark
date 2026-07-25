import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The SQLite viewer (src/chrome/viewer/sqlite-viewer.ts) — jsdom shape cloned
// from tests/hwp-viewer.test.ts (mock @tauri-apps/api/core, mount through the
// shared openViewerShell, drain the open()'s async chain with `flush`).
//
// Fixture DB (path "/vault/sample.db"): three tabs, tables-then-views order —
// "users" (table, 250 rows: id INTEGER / name TEXT / amount REAL / photo
// BLOB — row 3's name is SQL NULL, row 5's photo is a BLOB placeholder, every
// other photo cell is an empty string so NULL-vs-empty is directly
// testable), "empty_table" (table, rowCount 0), "user_view" (view, 3 rows).
// "/vault/broken.db" makes sqlite_tables itself reject (a locked/corrupt DB).
const USERS_ROW_COUNT = 250;

function usersRow(i: number): (string | null)[] {
  return [String(i), i === 3 ? null : `User ${i}`, (i * 1.5).toFixed(2), i === 5 ? "BLOB (1234 bytes)" : ""];
}

const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
  const path = String(args?.path ?? "");
  const table = String(args?.table ?? "");

  if (cmd === "sqlite_tables") {
    if (path.endsWith("broken.db")) return Promise.reject(new Error("database is locked"));
    return Promise.resolve([
      { name: "users", kind: "table" },
      { name: "empty_table", kind: "table" },
      { name: "user_view", kind: "view" },
    ]);
  }

  if (cmd === "sqlite_table_info") {
    if (table === "users") {
      return Promise.resolve({
        columns: ["id", "name", "amount", "photo"],
        columnTypes: ["INTEGER", "TEXT", "REAL", "BLOB"],
        rowCount: USERS_ROW_COUNT,
      });
    }
    if (table === "empty_table") {
      return Promise.resolve({ columns: ["id"], columnTypes: ["INTEGER"], rowCount: 0 });
    }
    if (table === "user_view") {
      return Promise.resolve({ columns: ["id", "label"], columnTypes: ["INTEGER", "TEXT"], rowCount: 3 });
    }
    return Promise.reject(new Error(`no such table: ${table}`));
  }

  if (cmd === "sqlite_rows") {
    const limit = Number(args?.limit ?? 0);
    const offset = Number(args?.offset ?? 0);
    if (table === "users") {
      const end = Math.min(offset + limit, USERS_ROW_COUNT);
      const rows: (string | null)[][] = [];
      for (let i = offset; i < end; i++) rows.push(usersRow(i));
      return Promise.resolve(rows);
    }
    if (table === "user_view") {
      const all = [
        ["1", "A"],
        ["2", "B"],
        ["3", "C"],
      ];
      return Promise.resolve(all.slice(offset, offset + limit));
    }
    return Promise.resolve([]);
  }

  return Promise.resolve(undefined);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { registerSqliteViewer, isNumericColumnType } from "../src/chrome/viewer/sqlite-viewer";
import { viewerFor } from "../src/chrome/viewer/registry";

// Registered ONCE for the whole file (registerViewer throws on a duplicate
// id) — every test looks the already-registered viewer up via viewerFor,
// same convention tests/hwp-viewer.test.ts uses.
registerSqliteViewer();

let editorHost: HTMLElement;

beforeEach(() => {
  editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  document.body.append(editorHost);
  const docTitleSlot = document.createElement("div");
  docTitleSlot.className = "title-bar-doc-title";
  const viewerSlotFixture = document.createElement("div");
  viewerSlotFixture.className = "title-bar-viewer-slot";
  document.body.append(docTitleSlot, viewerSlotFixture);
  invokeMock.mockClear();
});
afterEach(() => {
  editorHost.remove();
  document.querySelectorAll(".title-bar-doc-title, .title-bar-viewer-slot").forEach((n) => n.remove());
});

/** Drain open()'s async chain: sqlite_tables → renderDatabase → the active
 *  tab's sqlite_table_info → sqlite_rows, each a separate microtask hop.
 *  Mirrors tests/hwp-viewer.test.ts's `flush`. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("registerSqliteViewer registry shape", () => {
  it("registers id sqlite for sqlite/db/sqlite3/db3 — lowercase, no leading dot", () => {
    const v = viewerFor("sqlite");
    expect(v?.id).toBe("sqlite");
    expect(v?.extensions).toEqual(["sqlite", "db", "sqlite3", "db3"]);
    expect(viewerFor("db")?.id).toBe("sqlite");
    expect(viewerFor("sqlite3")?.id).toBe("sqlite");
    expect(viewerFor("db3")?.id).toBe("sqlite");
  });
});

describe("openSqliteViewer: mount + tab strip (a, b)", () => {
  it("mounts without throwing and renders one tab per table/view", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const tabs = document.querySelectorAll(".sqlite-viewer-tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0].textContent).toContain("users");
    expect(tabs[1].textContent).toContain("empty_table");
    expect(tabs[2].textContent).toContain("user_view");

    handle.close();
  });

  it("a view's tab carries a VIEW badge, a table's tab does not", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const tabs = document.querySelectorAll(".sqlite-viewer-tab");
    expect(tabs[0].querySelector(".sqlite-viewer-badge")).toBeNull();
    expect(tabs[1].querySelector(".sqlite-viewer-badge")).toBeNull();
    expect(tabs[2].querySelector(".sqlite-viewer-badge")?.textContent).toBe("VIEW");

    handle.close();
  });

  it("caption reads '파일명 — 테이블명 — 전체 N행'", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    expect(document.querySelector(".viewer-panel-caption")?.textContent).toBe("sample.db — users — 전체 250행");
    handle.close();
  });
});

describe("openSqliteViewer: active-tab render (c)", () => {
  it("renders the active table's header + first page of rows on open", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const table = document.querySelector(".sqlite-viewer-table") as HTMLTableElement;
    expect(table).toBeTruthy();
    expect(Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual([
      "id",
      "name",
      "amount",
      "photo",
    ]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(100); // first page only

    handle.close();
  });

  it("switching tabs loads the newly selected table's header + rows", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const tabs = document.querySelectorAll<HTMLButtonElement>(".sqlite-viewer-tab");
    tabs[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const table = document.querySelector(".sqlite-viewer-table") as HTMLTableElement;
    expect(Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["id", "label"]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(tabs[2].classList.contains("is-active")).toBe(true);
    expect(tabs[0].classList.contains("is-active")).toBe(false);

    handle.close();
  });

  it("a table with rowCount 0 shows '행 없음' and never fetches rows", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const tabs = document.querySelectorAll<HTMLButtonElement>(".sqlite-viewer-tab");
    tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const status = document.querySelector(".sqlite-viewer-body .sqlite-viewer-status");
    expect(status?.textContent).toBe("행 없음");
    expect(invokeMock).not.toHaveBeenCalledWith("sqlite_rows", expect.objectContaining({ table: "empty_table" }));

    handle.close();
  });
});

describe("openSqliteViewer: lazy pagination (d)", () => {
  it("scrolling near the bottom of the sheet appends the next page, and stops once rowCount is reached", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const sheet = document.querySelector(".sqlite-viewer-sheet") as HTMLElement;
    expect(sheet.querySelectorAll("tbody tr")).toHaveLength(100);

    sheet.dispatchEvent(new Event("scroll"));
    await flush();
    expect(sheet.querySelectorAll("tbody tr")).toHaveLength(200);

    sheet.dispatchEvent(new Event("scroll"));
    await flush();
    expect(sheet.querySelectorAll("tbody tr")).toHaveLength(250); // capped at rowCount

    // No further sqlite_rows calls once every row has loaded.
    const rowsCallsBefore = invokeMock.mock.calls.filter((c) => c[0] === "sqlite_rows").length;
    sheet.dispatchEvent(new Event("scroll"));
    await flush();
    const rowsCallsAfter = invokeMock.mock.calls.filter((c) => c[0] === "sqlite_rows").length;
    expect(rowsCallsAfter).toBe(rowsCallsBefore);

    handle.close();
  });

  it("a concurrent scroll firing while a page is already in flight does not double-request", async () => {
    const original = invokeMock.getMockImplementation()!;
    let resolveRows: ((rows: (string | null)[][]) => void) | null = null;
    let rowsCallCount = 0;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "sqlite_rows" && String(args?.table) === "users" && Number(args?.offset) === 100) {
        rowsCallCount += 1;
        return new Promise((resolve) => {
          resolveRows = resolve;
        });
      }
      return original(cmd, args);
    });

    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const sheet = document.querySelector(".sqlite-viewer-sheet") as HTMLElement;
    sheet.dispatchEvent(new Event("scroll"));
    sheet.dispatchEvent(new Event("scroll"));
    sheet.dispatchEvent(new Event("scroll"));
    await flush();
    expect(rowsCallCount).toBe(1); // in-flight guard: only ONE offset=100 request went out

    resolveRows!(Array.from({ length: 100 }, (_, i) => usersRow(100 + i)));
    await flush();
    expect(sheet.querySelectorAll("tbody tr")).toHaveLength(200);

    invokeMock.mockImplementation(original);
    handle.close();
  });
});

describe("openSqliteViewer: cell rendering (e, f)", () => {
  it("NULL cells render distinctly from empty-string cells", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const rows = document.querySelectorAll(".sqlite-viewer-table tbody tr");
    const row3 = rows[3]; // usersRow(3) -> name is null
    const nameCell = row3.children[1] as HTMLElement;
    expect(nameCell.classList.contains("sqlite-viewer-null")).toBe(true);
    expect(nameCell.textContent).toBe("NULL");

    const row0 = rows[0]; // usersRow(0) -> photo is ""
    const photoCell0 = row0.children[3] as HTMLElement;
    expect(photoCell0.classList.contains("sqlite-viewer-null")).toBe(false);
    expect(photoCell0.textContent).toBe("");

    handle.close();
  });

  it("a BLOB placeholder cell gets the blob styling class and its own text intact", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const rows = document.querySelectorAll(".sqlite-viewer-table tbody tr");
    const photoCell5 = rows[5].children[3] as HTMLElement; // usersRow(5) -> BLOB placeholder
    expect(photoCell5.classList.contains("sqlite-viewer-blob")).toBe(true);
    expect(photoCell5.textContent).toBe("BLOB (1234 bytes)");

    handle.close();
  });

  it("INTEGER/REAL-typed columns get is-num right-align on header + body, TEXT/BLOB do not", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const headerCells = document.querySelectorAll(".sqlite-viewer-table thead th");
    expect((headerCells[0] as HTMLElement).classList.contains("is-num")).toBe(true); // id: INTEGER
    expect((headerCells[1] as HTMLElement).classList.contains("is-num")).toBe(false); // name: TEXT
    expect((headerCells[2] as HTMLElement).classList.contains("is-num")).toBe(true); // amount: REAL
    expect((headerCells[3] as HTMLElement).classList.contains("is-num")).toBe(false); // photo: BLOB

    const firstRow = document.querySelector(".sqlite-viewer-table tbody tr")!;
    expect((firstRow.children[0] as HTMLElement).classList.contains("is-num")).toBe(true);
    // NULL cells in a numeric column still carry is-num (column-wide alignment).
    const row3IdCell = document.querySelectorAll(".sqlite-viewer-table tbody tr")[3].children[0] as HTMLElement;
    expect(row3IdCell.classList.contains("is-num")).toBe(true);

    handle.close();
  });

  it("isNumericColumnType: INTEGER/REAL/NUMERIC family true, TEXT/BLOB/BOOLEAN/untyped false", () => {
    expect(isNumericColumnType("INTEGER")).toBe(true);
    expect(isNumericColumnType("REAL")).toBe(true);
    expect(isNumericColumnType("NUMERIC")).toBe(true);
    expect(isNumericColumnType("DECIMAL(10,2)")).toBe(true);
    expect(isNumericColumnType("DOUBLE")).toBe(true);
    expect(isNumericColumnType("FLOAT")).toBe(true);
    expect(isNumericColumnType("VARCHAR(255)")).toBe(false);
    expect(isNumericColumnType("TEXT")).toBe(false);
    expect(isNumericColumnType("BLOB")).toBe(false);
    expect(isNumericColumnType("")).toBe(false);
  });
});

describe("openSqliteViewer: error handling (g)", () => {
  it("sqlite_tables rejection shows a human-readable error status and never throws", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/broken.db");
    await flush();

    const status = document.querySelector(".sqlite-viewer-status");
    expect(status?.textContent).toContain("데이터베이스를 열 수 없습니다");
    expect(document.querySelector(".sqlite-viewer-table")).toBeNull();

    handle.close();
  });

  it("sqlite_table_info rejection for one table shows an error without throwing, and never closes the viewer", async () => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "sqlite_table_info" && String(args?.table) === "users") {
        return Promise.reject(new Error("database disk image is malformed"));
      }
      return original(cmd, args);
    });

    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();

    const status = document.querySelector(".sqlite-viewer-body .sqlite-viewer-status");
    expect(status?.textContent).toContain("테이블을 불러올 수 없습니다");
    expect(document.querySelector(".viewer-panel")).toBeTruthy(); // still open, not auto-closed

    invokeMock.mockImplementation(original);
    handle.close();
  });
});

describe("openSqliteViewer: tab-switch race guard (generation invalidation)", () => {
  it("a slow response for a table the user switched away from never overwrites the now-active tab", async () => {
    const original = invokeMock.getMockImplementation()!;
    let resolveSlow: ((info: unknown) => void) | null = null;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "sqlite_table_info" && String(args?.table) === "users") {
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      }
      return original(cmd, args);
    });

    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();
    // "users" sqlite_table_info is stuck pending — switch away before it resolves.
    const tabs = document.querySelectorAll<HTMLButtonElement>(".sqlite-viewer-tab");
    tabs[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    let table = document.querySelector(".sqlite-viewer-table") as HTMLTableElement;
    expect(Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["id", "label"]);

    // Now the stale "users" fetch resolves — must NOT clobber the user_view now on screen.
    resolveSlow!({ columns: ["id", "name", "amount", "photo"], columnTypes: ["INTEGER", "TEXT", "REAL", "BLOB"], rowCount: USERS_ROW_COUNT });
    await flush();

    table = document.querySelector(".sqlite-viewer-table") as HTMLTableElement;
    expect(Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["id", "label"]);

    invokeMock.mockImplementation(original);
    handle.close();
  });
});

describe("openSqliteViewer: close (idempotent, mirrors other viewers)", () => {
  it("close() removes the panel and is safe to call twice", async () => {
    const v = viewerFor("sqlite")!;
    const handle = v.open("/vault/sample.db");
    await flush();
    expect(document.querySelector(".viewer-panel")).toBeTruthy();

    handle.close();
    expect(document.querySelector(".viewer-panel")).toBeNull();
    expect(() => handle.close()).not.toThrow();
  });
});
