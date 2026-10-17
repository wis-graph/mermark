// `mermark share on [이름...]` 요청의 프론트 처리 — Rust 제어 소켓이 준비된 창 1개에
// `cli-share-request`로 배달하면, 여기서 볼트 이름을 해석하고 패널과 같은
// `remote_share_start` 경로로 공유를 켠 뒤 `complete_cli_request`로 회신한다.
//
// 불변식: CLI 인자는 이름이든 경로든 **이미 등록된 영구 볼트**로만 해석된다 — 임의
// 디렉터리를 arm할 수 없다. 이름 매칭 규칙은 전부 아래 명명 함수가 소유한다.
import { canonicalRootPath, readPersistedWorkspaceState } from "../workspace/workspace-state";
import {
  checkTailscaleAvailable,
  completeCliRequest,
  startShare,
  type BindMode,
  type CliShareRequestPayload,
  type ShareSelection,
} from "./remote-share-ipc";
import { buildVaultsToArm, shareableVaultsFrom, type VaultOption } from "./remote-share-panel";
import { remoteSharePortSetting, shareStartCliErrorMessage } from "./remote-share-port";

/** macOS 폴더명(NFD)과 터미널 입력(NFC)을 같은 이름으로 만든다. */
export const normalizeVaultName = (s: string): string => s.normalize("NFC").trim();

/** CLI 클라이언트가 경로형 인자를 이미 절대 경로로 바꿔 보낸다. */
export const isPathVaultArg = (arg: string): boolean => arg.startsWith("/");

export type VaultMatch =
  | { readonly ok: true; readonly vault: VaultOption }
  | { readonly ok: false; readonly reason: "not-found" | "ambiguous"; readonly candidates: readonly VaultOption[] };

const dedupeById = (options: readonly VaultOption[]): VaultOption[] => {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
};

/** 인자 1개 → 볼트 1개. 경로형은 등록 루트와 정확 일치만(하위 경로/미등록 = not-found).
 *  이름형은 NFC 정확 일치 집합이 있으면 그것, 없으면 대소문자 무시 집합. */
export function matchVaultArg(arg: string, options: readonly VaultOption[]): VaultMatch {
  if (isPathVaultArg(arg)) {
    const target = canonicalRootPath(arg);
    const hit = options.find((o) => canonicalRootPath(o.root) === target);
    return hit ? { ok: true, vault: hit } : { ok: false, reason: "not-found", candidates: [] };
  }
  const wanted = normalizeVaultName(arg);
  const exact = dedupeById(options.filter((o) => normalizeVaultName(o.displayName) === wanted));
  const pool = exact.length > 0 ? exact : dedupeById(options.filter((o) => normalizeVaultName(o.displayName).toLowerCase() === wanted.toLowerCase()));
  if (pool.length === 1) return { ok: true, vault: pool[0] };
  return { ok: false, reason: pool.length === 0 ? "not-found" : "ambiguous", candidates: pool };
}

export type ShareTargets =
  | { readonly ok: true; readonly vaults: readonly VaultOption[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

const notFoundMessage = (arg: string, options: readonly VaultOption[]): string =>
  options.length === 0
    ? "공유할 수 있는 로컬 볼트가 없습니다 — mermark에서 볼트를 먼저 추가하세요"
    : `볼트 "${arg}"를 찾을 수 없습니다. 공유할 수 있는 볼트: ${options.map((o) => o.displayName).join(", ")}`;

const ambiguousMessage = (arg: string, candidates: readonly VaultOption[]): string =>
  `"${arg}"에 해당하는 볼트가 여러 개입니다: ${candidates.map((o) => o.root).join(", ")} — 경로로 지정하세요 (예: mermark share on ${candidates[0].root})`;

/** 이름 인자 우선(하나라도 실패하면 전체 실패 — 부분 공유 없음) → 없으면 기억값. */
export function resolveShareTargets(payload: Pick<CliShareRequestPayload, "names" | "remembered">, options: readonly VaultOption[]): ShareTargets {
  if (payload.names.length > 0) {
    const picked: VaultOption[] = [];
    for (const arg of payload.names) {
      const m = matchVaultArg(arg, options);
      if (!m.ok) return { ok: false, error: m.reason === "ambiguous" ? ambiguousMessage(arg, m.candidates) : notFoundMessage(arg, options) };
      if (!picked.some((p) => p.id === m.vault.id)) picked.push(m.vault);
    }
    return { ok: true, vaults: picked, warnings: [] };
  }
  const remembered = payload.remembered?.vaults ?? [];
  if (remembered.length === 0) return { ok: false, error: "볼트 이름을 넣으세요 (예: mermark share on 노트)" };
  const present = remembered.map((r) => ({ r, opt: options.find((o) => o.id === r.id) }));
  const vaults = present.flatMap((p) => (p.opt ? [p.opt] : []));
  if (vaults.length === 0) {
    return { ok: false, error: `기억된 볼트(${remembered.map((r) => r.display_name).join(", ")})가 더 이상 등록돼 있지 않습니다 — 볼트 이름을 넣으세요` };
  }
  const warnings = present.filter((p) => !p.opt).map((p) => `기억된 볼트 "${p.r.display_name}"는 더 이상 등록돼 있지 않아 제외했습니다`);
  return { ok: true, vaults, warnings };
}

/** 기억값이 있으면 그 방식, 없으면 Tailscale 감지 여부로(패널 pending 기본값 규칙과 동일). */
export const chooseBindMode = (remembered: ShareSelection | null, tailscaleAvailable: boolean): BindMode =>
  remembered ? remembered.bind_mode : tailscaleAvailable ? "tailscale" : "localhost-only";

export interface CliShareDeps {
  /** 매 요청마다 localStorage에서 새로 읽는다(창별 스토어 캐시는 낡을 수 있다). */
  readonly readOptions: () => readonly VaultOption[];
  readonly port: () => number;
}

const defaultDeps: CliShareDeps = {
  readOptions: () => shareableVaultsFrom(readPersistedWorkspaceState()),
  port: () => remoteSharePortSetting.get(),
};

/** 해석 → 시작 → 회신. 어떤 분기에서도 `complete_cli_request`를 정확히 1번 호출한다. */
export async function handleCliShareRequest(payload: CliShareRequestPayload, deps: CliShareDeps = defaultDeps): Promise<void> {
  const port = deps.port();
  try {
    const options = deps.readOptions();
    const targets = resolveShareTargets(payload, options);
    if (!targets.ok) {
      await completeCliRequest(payload.id, { kind: "failed", error: targets.error });
      return;
    }
    const tailscale = payload.remembered ? true : await checkTailscaleAvailable().catch(() => true);
    const bindMode = chooseBindMode(payload.remembered, tailscale);
    try {
      await startShare(bindMode, port, buildVaultsToArm(options, targets.vaults.map((v) => v.id)));
    } catch (err) {
      await completeCliRequest(payload.id, { kind: "failed", error: shareStartCliErrorMessage(err, port) });
      return;
    }
    await completeCliRequest(payload.id, { kind: "started", warnings: targets.warnings });
  } catch (err) {
    await completeCliRequest(payload.id, { kind: "failed", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
  }
}
