// Task 10's pure decision layer for the "원격 볼트 추가" flow: a host+code form
// gate (canSubmit only turns on once the backend's own constraints — non-empty
// host, exactly 6 digits — are already satisfiable client-side, so the UI
// never offers a guaranteed-failing submit) and a badge mapping for the 4
// distinct connection states classifyRemoteError (file-host.ts) resolves to.
// Kept dependency-free (no DOM, no invoke) so both are covered by plain unit
// tests; the DOM wiring that calls these lives in workspace-sidebar.ts.
import type { RemoteConnectionState } from "../document/file-host";

export interface RemoteBadge {
  readonly label: string;
  readonly tone: "ok" | "warn" | "error";
}

/** Maps each of the 4 states classifyRemoteError can resolve to, to its own
 *  label/tone — deliberately NOT collapsed into one generic "연결 실패"
 *  (project convention: distinct failures must say distinct things, since
 *  "인증 만료" and "호스트가 공유를 껐음" call for different user actions). */
export const badgeFor = (state: RemoteConnectionState): RemoteBadge => {
  switch (state) {
    case "connected": return { label: "연결됨", tone: "ok" };
    case "unreachable": return { label: "연결 안 됨", tone: "warn" };
    case "auth-expired": return { label: "인증 만료", tone: "error" };
    case "sharing-off": return { label: "호스트가 공유를 껐음", tone: "warn" };
  }
};

export interface AddRemoteForm {
  setHost(value: string): void;
  setCode(value: string): void;
  /** True only once host is non-empty AND code is exactly 6 digits — the
   *  backend enforces the same shape (remote_pair), so this just keeps the UI
   *  from ever offering a submit the server would reject outright. */
  canSubmit(): boolean;
  values(): { host: string; code: string };
}

export const makeAddRemoteForm = (): AddRemoteForm => {
  let host = "";
  let code = "";
  return {
    setHost: (v: string) => { host = v.trim(); },
    setCode: (v: string) => { code = v.trim(); },
    canSubmit: () => host.length > 0 && /^\d{6}$/.test(code),
    values: () => ({ host, code }),
  };
};
