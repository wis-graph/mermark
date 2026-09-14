import { describe, it, expect } from "vitest";
import { hostFieldProblem } from "../src/document/remote-host-field";
import { invoke } from "../src/mocks/tauri-core";
import truthTable from "./fixtures/remote-host-truth-table.json";

// Team-lead escalation (0.17.1, after two rounds of "mock is more lenient
// than the real backend" bugs already hit this repo): three places
// independently judge whether a remote-vault host string is reachable —
// Rust `base_url` (remote_client.rs), the browser mock's `remoteMockError`
// (tauri-core.ts), and TS's pre-flight `hostFieldProblem`
// (remote-host-field.ts). None of them can share code (Rust vs. TS), so a
// change to any ONE silently drifts from the other two unless something
// pins them together. This file is that pin, for the two TS surfaces: it
// runs EVERY row of the shared truth table (tests/fixtures/
// remote-host-truth-table.json) against both `hostFieldProblem` and the
// mock's `remote_pair`, and goes red the instant either one disagrees with
// the table. The Rust side has its own cargo tests pinned to the SAME rows
// (remote_client.rs's #[cfg(test)] module) — changing what the table says
// must mean updating both suites in the same change, not just one.
describe("remote-host truth table: mock and hostFieldProblem agree with the pinned table", () => {
  for (const row of truthTable.rows) {
    it(`"${row.input}" (${row.why}) → ${row.rejected ? "rejected" : "accepted"} by hostFieldProblem`, () => {
      const problem = hostFieldProblem(row.input);
      expect(problem !== null).toBe(row.rejected);
    });

    it(`"${row.input}" (${row.why}) → ${row.rejected ? "rejected" : "accepted"} by the mock's remote_pair`, async () => {
      const call = invoke("remote_pair", { host: row.input, code: "123456", label: "test-device" });
      if (row.rejected) {
        await expect(call).rejects.toBeTruthy();
      } else {
        await expect(call).resolves.toBeUndefined();
      }
    });
  }
});
