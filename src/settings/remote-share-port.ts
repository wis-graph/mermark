// Host-side "공유 포트" (remote-share listen port) settings-facing wiring —
// the pure validation/suggestion rules themselves live in
// document/share-port-rules.ts (moved there in the audit re-review round 2,
// `_workspace/04_audit_report.md` item 2 — this file used to define them
// directly, which made document/remote-host-field.ts's "dependency-free"
// claim false the moment it imported from here for `sharePortProblem`).
// This file keeps only what's genuinely settings/DOM-facing: the persisted
// setting itself, and the `remote_share_start` error-to-Korean-sentence
// mapping.
import { defineSetting } from "./store";
import { DEFAULT_SHARE_PORT, SSH_TUNNEL_LOCAL_PORT, SHARE_PORT_RANGE_MESSAGE, sharePortProblem, suggestAlternativeSharePort } from "../document/share-port-rules";

export { DEFAULT_SHARE_PORT, SSH_TUNNEL_LOCAL_PORT, sharePortProblem, suggestAlternativeSharePort };

/** The user's saved "공유 포트" preference — the SSOT for what port the NEXT
 *  `remote_share_start` call should use (design §1-1: status.port is
 *  display-only "what's running now"; this setting is "what the user wants").
 *  A corrupted/out-of-range stored value falls back to `DEFAULT_SHARE_PORT`
 *  (store.ts's usual "parse returns null → default" contract) rather than
 *  ever being sent to the backend malformed. `remote_share.rs`'s
 *  `ShareConfig` is never persisted across restarts (`RemoteShareState::new`
 *  doesn't auto-start), so a backend config file would have nothing to
 *  survive for; this frontend setting is the only place the value needs to
 *  live. */
export const remoteSharePortSetting = defineSetting<number>({
  key: "mermark.remoteShare.port",
  default: DEFAULT_SHARE_PORT,
  parse: (raw) => (raw !== null && sharePortProblem(raw) === null ? Number(raw) : null),
});

/** Turn a `remote_share_start` rejection into a sentence the user can act on,
 *  for the specific `port` that was just attempted. Recognizes the 2 error
 *  prefixes that command can actually produce: `PORT_IN_USE:` (Rust's
 *  `remote_host::bind` classifying `ErrorKind::AddrInUse`, mirrored by the
 *  mock's magic port 49999 — see tauri-core.ts) points the user at the exact
 *  "공유 포트" row below and offers a concrete, never-the-tunnel-port
 *  alternative (`suggestAlternativeSharePort`). `PORT_INVALID:` (only
 *  reachable if some other caller bypassed this module's own pre-flight)
 *  reuses the identical range message. Anything else falls back to the raw
 *  error text — this function never swallows an error it doesn't recognize.
 *
 *  Audit re-review round 2: this used to ALSO strip `SSH_TUNNEL_PORT_IN_USE:`
 *  — dead code, since that prefix comes from `remote_ssh_connect`
 *  (remote_ssh.rs's `connect_with`), a completely different command this
 *  function's caller (`remote-share-panel.ts`'s `applyStart`) never touches.
 *  The one place that error actually reaches a user —
 *  `remote-vault-dialog.ts`'s pairing flow — strips it itself now
 *  (`pairingErrorMessage`), where the failure genuinely occurs. Pure query. */
export function shareStartErrorMessage(err: unknown, port: number): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("PORT_IN_USE:")) {
    return `포트 ${port}를 이 Mac의 다른 프로그램이 쓰고 있습니다. 아래 '공유 포트'를 다른 번호(예: ${suggestAlternativeSharePort(port)})로 바꾼 뒤 다시 켜세요.`;
  }
  if (msg.startsWith("PORT_INVALID:")) {
    return SHARE_PORT_RANGE_MESSAGE;
  }
  return msg;
}
