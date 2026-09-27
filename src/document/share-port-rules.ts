// Pure "공유 포트" (remote-share listen port) validation/suggestion rules —
// the real-world bug behind this whole family of changes was 8787 colliding
// with another service on the user's Mac mini and blocking sharing
// entirely (_workspace/00_request.md). Design decision B
// (_workspace/01_architect_design.md §0-1): default moves to 47878 and the
// port becomes a user-editable setting.
//
// Moved here from settings/remote-share-port.ts (audit re-review round 2,
// `_workspace/04_audit_report.md` item 2): src/document/remote-host-field.ts
// is documented dependency-free (no DOM, no invoke) but had started
// importing settings/remote-share-port.ts just to reuse `sharePortProblem`
// — pulling in `defineSetting`'s localStorage-reading side effect
// (settings/store.ts) as an unwanted transitive dependency for a module
// that's supposed to have none. This module has NEITHER settings NOR DOM/
// invoke dependencies — both `document/remote-host-field.ts` and
// `settings/remote-share-port.ts` (which re-exports these for its own
// existing consumers: the panel, the mock, and its own
// `remoteSharePortSetting`/`shareStartErrorMessage`) import from here.
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
 *  `shareStartErrorMessage` (settings/remote-share-port.ts, backend's
 *  `PORT_INVALID:` rejection) so the two surfaces never drift into two
 *  different wordings for the same rule. */
export const SHARE_PORT_RANGE_MESSAGE = "공유 포트는 1024에서 65535 사이 숫자입니다.";

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
