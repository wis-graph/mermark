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

// F1 (_workspace/01_architect_design.md §2.3, 47878 포트 변경): the mock's
// remote_ssh_connect independently re-runs the same ssh suffix rules
// (parse_ssh_host ②③ on the Rust side) right before dialing the tunnel — so
// every SSH-shaped row of the SAME shared table must agree here too, not
// just through remote_pair above.
describe("remote-host truth table: mock's remote_ssh_connect agrees with every ssh:// row", () => {
  const sshRows = truthTable.rows.filter((row) => row.input.startsWith("ssh://"));
  // The mock enforces a single-tunnel-slot invariant (SSH_TUNNEL_BUSY: a
  // second DISTINCT host can't connect while one is active) — the same
  // invariant `decide_connect` (remote_ssh.rs) enforces for real. Looping
  // over several distinct accepted hosts would otherwise collide with that
  // guard, which is a real behavior this loop must work AROUND, not weaken
  // by connecting to the same host twice. Disconnecting the previous
  // successful connection before each new attempt keeps every row testing
  // ONLY the ssh-suffix rule it's here to pin.
  let lastConnectedHost: string | null = null;
  for (const row of sshRows) {
    it(`"${row.input}" (${row.why}) → ${row.rejected ? "rejected" : "accepted"} by the mock's remote_ssh_connect`, async () => {
      if (lastConnectedHost) {
        await invoke("remote_ssh_disconnect", { host: lastConnectedHost });
        lastConnectedHost = null;
      }
      const call = invoke("remote_ssh_connect", { host: row.input });
      if (row.rejected) {
        await expect(call).rejects.toBeTruthy();
      } else {
        await expect(call).resolves.toBeUndefined();
        lastConnectedHost = row.input;
      }
    });
  }
});

// F1: the shared table's `sharePortRows` pins Rust `validate_share_port`,
// TS `sharePortProblem` (tests/remote-share-port.test.ts covers that side),
// and the mock's `remote_share_start` together — every row here must also
// agree when actually driven through the mock's start command. A non-empty,
// otherwise-valid vault list is supplied so a REJECTED call is rejected
// because of the port specifically, not because of the (unrelated)
// vault-emptiness guard `remote_share_start` also enforces.
describe("remote-host truth table: mock's remote_share_start agrees with every sharePortRows row", () => {
  for (const row of truthTable.sharePortRows) {
    it(`port "${row.input}" → ${row.rejected ? "rejected" : "accepted"} by the mock's remote_share_start`, async () => {
      const call = invoke("remote_share_start", {
        bindMode: "tailscale",
        port: Number(row.input),
        vaults: [{ id: "v1", display_name: "테스트", root: "/tmp/mermark-truth-table-test" }],
      });
      if (row.rejected) {
        await expect(call).rejects.toBeTruthy();
      } else {
        await expect(call).resolves.toBeUndefined();
      }
    });
  }
});
