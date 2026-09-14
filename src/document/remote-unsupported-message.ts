// What a v1 remote vault can actually open. Until T6 (0.18.0) this module
// owned BOTH halves of that question: a hand-kept extension Set (which files
// a remote vault could open at all) AND the refusal wording for the rest.
// The Set is GONE — T6 makes a registered Viewer declare its own remote
// support by implementing `openRemote` (chrome/viewer/registry.ts's
// `RemoteViewerSource`/`viewerSupportsRemote`), so "can this file open
// remotely" is now answered by walking the actual viewer registry
// (main.ts's `openWithViewer`), not by a list here that a new viewer could
// silently forget to update (the exact drift this Set's own old comment
// already warned about: "the registry is empty until boot runs
// registerViewer for each" is precisely why a parallel hand-kept list was a
// standing risk).
//
// This module's ONLY remaining job is the refusal WORDING shown in place of
// a broken/empty viewer when a registered viewer declines to open remotely.
// It stays a plain, standalone pure function (no registry import) — an
// open-time gate and its unit tests both need this before any viewer
// machinery exists.
import { extensionOf } from "../sidebar/explorer/file-icons";

const SQLITE_EXTENSIONS = new Set(["sqlite", "sqlite3", "db", "db3"]);
const HWP_EXTENSIONS = new Set(["hwp", "hwpx"]);

/** The refusal shown in place of a broken/empty viewer when a registered
 *  viewer has no `openRemote` (design §4.3). Distinct wording PER KIND — a
 *  user needs to tell "this can never work over a network" (sqlite: the
 *  viewer's whole design is reading only the pages it needs, and shipping
 *  the entire database defeats that) apart from "not built yet, might
 *  arrive later" (epub: needs Range support; hwp: needs a temp-file
 *  lifetime story) apart from "an unrecognized/future viewer type" (the
 *  fail-closed default — a viewer registered with no entry here still gets
 *  a real refusal message, never a silently-broken open). Pure query. */
export function remoteUnsupportedMessage(fileName: string): string {
  const ext = extensionOf(fileName);
  if (SQLITE_EXTENSIONS.has(ext)) {
    // 「아직」을 쓰지 않는다 — 구조적 한계다 (design §4.3). 20 MiB 상한이 실사용
    // DB 대부분을 어차피 거절하고, 무엇보다 "필요한 페이지만 디스크에서 읽는다"는
    // 이 뷰어의 존재 이유를 전체 바이트 전송이 정면으로 깬다.
    return "원격 볼트의 데이터베이스는 열 수 없습니다 — 데이터베이스는 필요한 부분만 디스크에서 읽어야 해서 원격으로는 지원하지 않습니다.";
  }
  if (ext === "epub") {
    return "원격 볼트의 EPUB은 아직 지원하지 않습니다.";
  }
  if (HWP_EXTENSIONS.has(ext)) {
    return "원격 볼트의 한글 문서는 아직 지원하지 않습니다.";
  }
  // Fail-closed default (unchanged wording — a future viewer that forgets to
  // implement `openRemote` gets THIS message, not a broken open).
  return "원격 볼트에서는 아직 지원하지 않습니다";
}
