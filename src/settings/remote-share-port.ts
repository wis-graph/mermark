// Host-side "공유 포트" (remote-share listen port) — the fix for the
// real-world bug report in _workspace/00_request.md: 8787 collided with
// another service already running on the user's Mac mini, blocking sharing
// entirely. Design decision B (_workspace/01_architect_design.md §0-1):
// default moves to 47878, and the port becomes a user-editable SETTING
// (this module's SSOT) rather than a hardcoded constant — `remote_share.rs`'s
// `ShareConfig` is never persisted across restarts (`RemoteShareState::new`
// doesn't auto-start), so a backend config file would have nothing to
// survive for; the frontend setting is the only place this value needs to
// live.
//
// Dependency-free (no DOM, no invoke) — same reasoning as
// remote-host-field.ts: this module is pure enough to unit-test directly and
// is consumed both by the settings panel (remote-share-panel.ts) and by the
// shared 3-경계 truth table (tests/remote-host-truth-table.test.ts's
// `sharePortRows`, tests/fixtures/remote-host-truth-table.json).
import { defineSetting } from "./store";

/** New default listen port for host-side remote sharing (was 8787 — see
 *  _workspace/00_request.md for why it moved). Rust's `DEFAULT_PORT`
 *  (remote_client.rs) and the browser mock's `DEFAULT_SHARE_PORT` import both
 *  must equal this value; the shared fixture's `defaultPort` field pins all
 *  three together. */
export const DEFAULT_SHARE_PORT = 47878;

/** The CLIENT's fixed local SSH tunnel port (`SSH_TUNNEL_LOCAL_PORT`,
 *  remote_client.rs) — deliberately different from `DEFAULT_SHARE_PORT` so
 *  this Mac sharing a vault (localhost-only) and simultaneously SSH-tunneling
 *  into a DIFFERENT host can never collide on the same local port. This
 *  module needs the value only to keep `suggestAlternativeSharePort` from
 *  ever recommending it (audit 🟡-1) — it is otherwise a Rust-side-only
 *  constant. Cross-checked against the shared fixture's `sshTunnelLocalPort`
 *  field (same SSOT-by-fixture pattern as `DEFAULT_SHARE_PORT`⇄`defaultPort`)
 *  — see tests/remote-share-port.test.ts. */
export const SSH_TUNNEL_LOCAL_PORT = 47879;

/** The single human-readable message for "this string isn't a valid share
 *  port" — reused by `sharePortProblem` (bad input) and
 *  `shareStartErrorMessage` (backend's `PORT_INVALID:` rejection) so the two
 *  surfaces never drift into two different wordings for the same rule. */
const SHARE_PORT_RANGE_MESSAGE = "공유 포트는 1024에서 65535 사이 숫자입니다.";

/** What's wrong with this "공유 포트" field input — or `null` if it's a port
 *  `remote_share_start`/`validate_share_port` (Rust) can actually accept.
 *  Digits-only, 1024–65535 (design §1.4: below 1024 risks a privileged-port/
 *  system-service mix-up). Ports below 1024 or non-numeric strings mirror
 *  the SAME rule `validate_share_port` (remote_share.rs) enforces server-side
 *  — this is the client-side pre-flight half, run before the port is ever
 *  sent. Pure query. */
export function sharePortProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return SHARE_PORT_RANGE_MESSAGE;
  const n = Number(trimmed);
  if (n < 1024 || n > 65535) return SHARE_PORT_RANGE_MESSAGE;
  return null;
}

/** The user's saved "공유 포트" preference — the SSOT for what port the NEXT
 *  `remote_share_start` call should use (design §1-1: status.port is
 *  display-only "what's running now"; this setting is "what the user wants").
 *  A corrupted/out-of-range stored value falls back to `DEFAULT_SHARE_PORT`
 *  (store.ts's usual "parse returns null → default" contract) rather than
 *  ever being sent to the backend malformed. */
export const remoteSharePortSetting = defineSetting<number>({
  key: "mermark.remoteShare.port",
  default: DEFAULT_SHARE_PORT,
  parse: (raw) => (raw !== null && sharePortProblem(raw) === null ? Number(raw) : null),
});

/** A different port to suggest after `port` failed with `PORT_IN_USE:` —
 *  audit 🟡-1 (`_workspace/04_audit_report.md`): the old inline `port + 1`
 *  could recommend `SSH_TUNNEL_LOCAL_PORT` (47879, the exact self-collision
 *  this port-conflict round exists to prevent — `SSH_TUNNEL_PORT_IN_USE:` if
 *  the user takes the advice and then also SSH-tunnels from this same Mac)
 *  or walk past 65535 into an invalid port. Steps forward one at a time,
 *  wrapping 65535 back to 1024 rather than overflowing, and skips over
 *  `SSH_TUNNEL_LOCAL_PORT` specifically — the loop always terminates because
 *  only one value in the whole 1024–65535 range is excluded. Pure query. */
export function suggestAlternativeSharePort(port: number): number {
  let candidate = port;
  do {
    candidate = candidate >= 65535 ? 1024 : candidate + 1;
  } while (candidate === SSH_TUNNEL_LOCAL_PORT);
  return candidate;
}

/** Turn a `remote_share_start` rejection into a sentence the user can act on,
 *  for the specific `port` that was just attempted. Recognizes all 3 error
 *  prefixes backend confirmed for this port-conflict round
 *  (_workspace/02_backend_changes.md): `PORT_IN_USE:` (Rust's
 *  `remote_host::bind` classifying `ErrorKind::AddrInUse`, mirrored by the
 *  mock's magic port 49999 — see tauri-core.ts) points the user at the exact
 *  "공유 포트" row below and offers a concrete alternative. `PORT_INVALID:`
 *  (only reachable if some other caller bypassed this module's own
 *  pre-flight) reuses the identical range message. `SSH_TUNNEL_PORT_IN_USE:`
 *  (a different failure domain — see its own branch below) is stripped to
 *  its already-human-readable remainder. Anything else falls back to the raw
 *  error text — this function never swallows an error it doesn't recognize.
 *  Pure query. */
export function shareStartErrorMessage(err: unknown, port: number): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("PORT_IN_USE:")) {
    return `포트 ${port}를 이 Mac의 다른 프로그램이 쓰고 있습니다. 아래 '공유 포트'를 다른 번호(예: ${suggestAlternativeSharePort(port)})로 바꾼 뒤 다시 켜세요.`;
  }
  if (msg.startsWith("PORT_INVALID:")) {
    return SHARE_PORT_RANGE_MESSAGE;
  }
  // SSH_TUNNEL_PORT_IN_USE: (remote_ssh.rs's connect_with, via remote_ssh_connect)
  // can't actually reach a remote_share_start failure in practice — it's the
  // CLIENT's own local SSH tunnel port (47879), a different conflict than
  // this HOST's bind above — but it's still a recognized error prefix this
  // module owns (team review, 2026-09-27: backend confirmed 3 prefixes total).
  // Rust's own message is already a complete, actionable Korean sentence once
  // the machine prefix is stripped, so this branch stays exhaustive instead of
  // falling through to the raw-text fallback below for a prefix we DO know.
  if (msg.startsWith("SSH_TUNNEL_PORT_IN_USE:")) {
    return msg.slice("SSH_TUNNEL_PORT_IN_USE:".length).trim();
  }
  return msg;
}
