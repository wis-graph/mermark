// T2 (0.17.1): pre-flight validation for the "원격 볼트 추가" host field
// (remote-vault-dialog.ts). Before this existed, typing a Korean host like
// "맥미니" silently went out IDNA/punycode-encoded (`xn--9i1bx8ksvb`),
// producing a `REMOTE:Unreachable` the user had no way to connect back to
// "I typed the wrong kind of thing" — Rust's `base_url` (remote_client.rs)
// only rejects that AFTER a pairing attempt is already underway. This module
// runs the SAME judgment client-side, before the user even clicks 페어링, so
// the failure reads as guidance ("영문 호스트 이름을 넣으세요") instead of an
// opaque network error. Kept dependency-free (no DOM, no invoke) — the same
// reasoning as `add-remote-vault.ts`'s `makeAddRemoteForm`.
//
// `base_url` is this rule's OTHER half (Rust rejects non-ASCII too, as a
// backstop for a bypassed/buggy/older frontend) — the two must keep agreeing
// on what's rejected, even though the messages differ (Rust's is a single
// generic string; this one distinguishes reasons so the UI can say something
// different for each). `src/mocks/tauri-core.ts`'s `remoteMockError` mirrors
// the ASCII half of this same rule so the mock rejects what the real backend
// rejects (mermark-dev's 3경계 정합 requirement).

/** Is every character of `host` plain ASCII — the alphabet `base_url`
 *  requires for a bare `name[:port]`. Named separately so both this
 *  module's non-ASCII branch and any future caller read the same domain
 *  rule by name, not by re-deriving a regex inline. Pure query. */
function isAsciiHost(host: string): boolean {
  return /^[\x00-\x7f]*$/.test(host);
}

/** Whether `host` contains whitespace anywhere — a host field value that
 *  slipped in a space (e.g. "mac mini") can never resolve as a single
 *  hostname. Pure query. */
function hasWhitespace(host: string): boolean {
  return /\s/.test(host);
}

/** Splits a `host[:port]` string into its host and (optional, unparsed) port
 *  segment. `ssh://`-prefixed values never reach this — the caller returns
 *  early for those, since `base_url` treats the WHOLE string as an SSH
 *  target, not a `host:port` pair. Pure query. */
function splitHostPort(input: string): { host: string; port: string | null } {
  const idx = input.lastIndexOf(":");
  if (idx === -1) return { host: input, port: null };
  return { host: input.slice(0, idx), port: input.slice(idx + 1) };
}

/** Is `port` a syntactically valid TCP port (1–65535, digits only, no
 *  leading/trailing junk)? `Number("")` and `Number(" ")` are both `0`
 *  (falsy-looking but NOT NaN), so this checks the digit shape directly
 *  rather than trusting `Number.isFinite` alone. Pure query. */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** What's wrong with this host-field input, in a sentence the user can act
 *  on — or `null` if it's a shape `remote_pair`/`base_url` can actually
 *  reach. Runs BEFORE pairing is attempted (remote-vault-dialog.ts's pairBtn
 *  handler), so a rejected value never leaves the client as a network
 *  request. Each rejection reason gets its OWN message (project convention:
 *  distinct failures say distinct things) — never collapsed into one generic
 *  "잘못된 입력". Pure query. */
export function hostFieldProblem(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "호스트를 입력하세요.";

  // `ssh://`-prefixed values are a distinct shape `base_url` handles
  // entirely differently (Task 12's SSH tunnel target) — never a
  // `host[:port]` pair, so none of the checks below apply to it.
  if (trimmed.startsWith("ssh://")) return null;

  if (hasWhitespace(trimmed)) {
    return "호스트 이름에는 영문·숫자·점·하이픈만 쓸 수 있습니다. Tailscale 주소(예: 100.64.1.2)나 영문 호스트 이름(예: mac-mini)을 넣으세요.";
  }
  if (trimmed.includes("://") || trimmed.includes("/")) {
    return "주소가 아니라 호스트 이름만 적습니다(예: mac-mini:8787).";
  }
  if (!isAsciiHost(trimmed)) {
    return "호스트 이름에는 영문·숫자·점·하이픈만 쓸 수 있습니다. Tailscale 주소(예: 100.64.1.2)나 영문 호스트 이름(예: mac-mini)을 넣으세요.";
  }

  const { port } = splitHostPort(trimmed);
  if (port !== null && !isValidPort(port)) {
    return "포트는 1에서 65535 사이 숫자입니다.";
  }

  return null;
}
