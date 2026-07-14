#!/bin/bash
set -e

# --dry-run: 게이트·분기 로직만 실행하고, 실제로 상태를 바꾸는 gh/git 명령은
# 실행 대신 무엇을 실행했을지 출력만 한다. 이 스크립트가 지금까지 한 번도
# 적대적으로 시험된 적이 없었다는 게 2026-07-14 세션의 지적이었다 — 이 플래그로
# 실제 태그/릴리스를 만들지 않고도 분기(멱등성 판정, run 포착 로직)를 반복
# 검증할 수 있게 한다.
DRY_RUN=0
if [ "${1:-}" == "--dry-run" ]; then
  DRY_RUN=1
  echo "[dry-run] 게이트·분기만 실행합니다. release/upload/dispatch/commit/push는 실행되지 않습니다."
fi

# 상태를 바꾸는 명령을 감싼다: dry-run이면 실행할 명령을 그대로 echo만 하고
# 반환값 0으로 진행, 아니면 실제로 실행한다.
run_mutating() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# package.json에서 현재 버전 정보 동적 추출
VERSION=$(node -e "console.log(require('./package.json').version)")
TAG="v$VERSION"

echo "=================================================="
# 빌드 결과물 경로 정의
DMG_PATH="src-tauri/target/release/bundle/dmg/mermark_${VERSION}_aarch64.dmg"
TAR_PATH="src-tauri/target/release/bundle/macos/mermark.app.tar.gz"
SIG_PATH="src-tauri/target/release/bundle/macos/mermark.app.tar.gz.sig"

# 파일이 없는 경우 다른 빌드 타겟 구조(x86_64 등)나 경로 대응을 위해 파일 감지 및 대체
if [ ! -f "$DMG_PATH" ]; then
  # 대안 파일 검색
  ALT_DMG=$(find src-tauri/target/release/bundle/dmg -name "mermark_*_aarch64.dmg" -o -name "mermark_*_x64.dmg" | head -n 1)
  if [ -n "$ALT_DMG" ]; then
    DMG_PATH="$ALT_DMG"
  fi
fi

if [ ! -f "$DMG_PATH" ] || [ ! -f "$TAR_PATH" ] || [ ! -f "$SIG_PATH" ]; then
  echo "오류: 빌드 결과물 파일이 존재하지 않습니다. 먼저 빌드를 완료해 주세요."
  echo "확인 대상:"
  echo " - DMG: $DMG_PATH"
  echo " - TAR: $TAR_PATH"
  echo " - SIG: $SIG_PATH"
  exit 1
fi

# --- 배포 게이트: 변경 내역 정합성 -------------------------------------------
# 앱 안 "설정 › 버전 › 변경 내역"은 version-pane이 CHANGELOG.md를 vite `?raw`로
# 빌드 시점에 번들에 구워 넣는다. 반면 아래 NOTES(=GH 릴리스 노트·updater.json)는
# 배포 시점에 CHANGELOG를 읽는다. 두 시점이 달라서, CHANGELOG를 쓰기 전에 빌드를
# 돌리면 updater/GH는 멀쩡한데 앱 안에서만 이번 버전 항목이 통째로 비는 불일치가
# 난다 (2026-07-14 v0.5.11에서 실제 발생 — 번들이 16초 먼저 구워졌다).
#
# 그래서 "순서를 기억한다"가 아니라 "틀리면 배포가 막힌다"로 강제한다. 실제로 나갈
# 산출물(dist/)을 검사하는 게 핵심 — 소스만 보면 이 버그를 못 잡는다.
if ! grep -q "^## \[$VERSION\]" CHANGELOG.md; then
  echo "오류: CHANGELOG.md에 '## [$VERSION]' 섹션이 없습니다."
  echo "      릴리스 노트를 먼저 작성하세요. 순서: 버전범프 → CHANGELOG → 빌드 → 릴리스."
  exit 1
fi
if ! grep -rq "\[$VERSION\]" dist/ 2>/dev/null; then
  echo "오류: 빌드된 번들(dist/)에 [$VERSION]의 변경 내역이 없습니다."
  echo "      = CHANGELOG.md를 쓰기 전에 빌드가 실행됐습니다. 앱 안 '변경 내역'이 비어서 나갑니다."
  echo "      해결: CHANGELOG.md를 확정한 뒤 다시 빌드하세요 → npm run tauri build"
  exit 1
fi
echo "✓ 변경 내역 정합성 OK — CHANGELOG·번들 모두 [$VERSION] 포함"

# --- 배포 게이트: 업데이터 서명키 정합성 ---------------------------------------
# 셸 환경의 TAURI_SIGNING_PRIVATE_KEY 기본값이 다른 프로젝트(galpi) 키라, 그대로
# 빌드하면 앱이 신뢰하는 pubkey(tauri.conf.json)와 다른 키로 서명된 .sig가 나간다.
# 그러면 기존 사용자 전원의 자동 업데이트가 서명 검증 실패로 깨진다 — 배포 후에야
# 드러나는 최악의 실패다. 빌드는 `npm run release:build`가 키를 강제하고, 여기서는
# 실제로 나갈 .sig의 키ID를 pubkey의 키ID와 대조해 2중으로 막는다.
# 로직은 scripts/lib/check-signing-key.py 하나뿐 — 아래 윈도우 .sig 검증도 같은
# 스크립트를 쓴다(복붙 아님. 하나가 고장나면 둘 다 고장나야 정직하다).
KEY_CHECK=$(python3 scripts/lib/check-signing-key.py "$SIG_PATH")
if [ "$KEY_CHECK" != "OK" ]; then
  echo "오류: 업데이터 서명키가 앱이 신뢰하는 pubkey와 다릅니다 ($KEY_CHECK)"
  echo "      이대로 배포하면 기존 사용자 전원의 자동 업데이트가 서명 검증 실패로 깨집니다."
  echo "      해결: 올바른 키로 다시 빌드하세요 → npm run release:build"
  exit 1
fi
echo "✓ 서명키 정합성 OK — .sig가 tauri.conf.json의 pubkey와 같은 키"

# 릴리즈 노트 = CHANGELOG.md의 최신 버전 섹션 본문.
# GH Release 본문과 updater.json의 notes에 같은 내용이 들어가, 앱의
# "업데이트가 있습니다" 카드가 실제 변경 내역을 보여줄 수 있다 (2026-07-11).
# 섹션을 못 찾으면(형식 이탈) 기존 한 줄 문구로 폴백한다.
NOTES=$(python3 - <<'PY'
import re
text = open("CHANGELOG.md", encoding="utf-8").read()
m = re.search(r"^## \[[^\]]+\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
body = m.group(1).strip() if m else ""
print(body.rstrip("-").strip() or "")
PY
)
[ -z "$NOTES" ] && NOTES="mermark $TAG 버전 자동 릴리즈 업데이트"

GH="/opt/homebrew/bin/gh"
WORKFLOW_FILE="release-windows.yml"

# --- 멱등성: 릴리스가 이미 있으면 create 대신 upload --clobber -----------------
# 재시도(윈도우 CI가 한 번 실패해 사람이 이 스크립트를 다시 돌리는 흔한 경우)에서
# `gh release create`는 "태그/릴리스가 이미 존재"로 막혀 스크립트가 죽는다. 그러면
# 사람이 반쯤 나간 릴리스를 손으로 수술하게 되고, updater.json 사고는 정확히 그
# 순간에 난다. 존재 확인은 읽기 전용이라 dry-run에서도 항상 실제로 실행한다 —
# 이게 검증해야 할 분기 자체이기 때문이다.
if "$GH" release view "$TAG" >/dev/null 2>&1; then
  echo "=== 1. GitHub Release ($TAG) 이미 존재 — macOS 자산 재업로드(clobber) ==="
  run_mutating "$GH" release upload "$TAG" "$DMG_PATH" "$TAR_PATH" "$SIG_PATH" --clobber
else
  echo "=== 1. GitHub Release ($TAG) 생성 및 파일 업로드 (macOS) ==="
  run_mutating "$GH" release create "$TAG" "$DMG_PATH" "$TAR_PATH" "$SIG_PATH" --title "$TAG" --notes "$NOTES"
fi

# --- 배포 게이트: 윈도우 CI를 직접 디스패치하고 대기 --------------------------
# updater.json의 writer는 이 스크립트 하나뿐이어야 한다(SSOT). release-windows.yml은
# push:tags 트리거가 없다(workflow_dispatch 전용) — 이 스크립트가 유일한
# 오케스트레이터다. "최신 run 1개"를 추측하지 않고, 디스패치 직전 타임스탬프
# 이후에 생긴 workflow_dispatch run만 내 것으로 인정한다
# (scripts/lib/find-dispatched-run.mjs, 재시도 시 어제의 실패한 run을 오판하지
# 않기 위한 장치). 윈도우 빌드가 실패하면 이 스크립트도 실패해야 한다 — macOS
# 자산은 이미 나갔으니 macOS 사용자는 정상 업데이트를 받지만(의도된 부분 성공),
# updater.json이 아직 안 갱신됐으니 어느 플랫폼에도 알림은 안 나간다.
echo "=== 2. 윈도우 빌드(CI) 디스패치 및 대기 ==="
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_mutating "$GH" workflow run "$WORKFLOW_FILE" --ref "$TAG" -f "tag=$TAG"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 실제 디스패치가 없으므로 이후(CI 대기·서명키 검증·updater.json 기록) 단계는 건너뜁니다."
  echo "[dry-run] 게이트·멱등성 분기 검증 완료."
  exit 0
fi

RUN_ID=""
for i in $(seq 1 30); do
  RUNS_JSON=$("$GH" run list --workflow="$WORKFLOW_FILE" --limit 20 --json databaseId,createdAt,event 2>/dev/null || echo '[]')
  RUN_ID=$(echo "$RUNS_JSON" | node scripts/find-dispatched-run-cli.mjs "$SINCE" || true)
  if [ -n "$RUN_ID" ]; then
    break
  fi
  echo "  … 디스패치한 윈도우 워크플로 실행이 나타나길 기다리는 중 ($i/30)"
  sleep 10
done
if [ -z "$RUN_ID" ]; then
  echo "오류: 디스패치한 윈도우 워크플로 실행을 5분 내에 찾지 못했습니다."
  echo "      .github/workflows/release-windows.yml이 main에 있는지, workflow_dispatch가 맞는지 확인하세요:"
  echo "      $GH run list --workflow=$WORKFLOW_FILE"
  exit 1
fi
# run id는 순수 10진수여야 한다. 이 검사가 없으면 오염된 값(ANSI 색상 코드가
# 섞인 적이 있다 — find-dispatched-run-cli.mjs 주석 참고)이 그대로 gh에 넘어가
# "invalid control character in URL" 같은 엉뚱한 에러로 나타나고, 진짜 원인이
# 윈도우 빌드 실패인지 우리 스크립트 버그인지 구분할 수 없게 된다.
if ! [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "오류: 워크플로 run id가 숫자가 아닙니다: $(printf '%q' "$RUN_ID")"
  echo "      scripts/find-dispatched-run-cli.mjs의 출력이 오염됐습니다(제어문자·색상코드 등)."
  exit 1
fi
echo "  워크플로 실행 발견 (run $RUN_ID). 완료 대기 중…"
if ! "$GH" run watch "$RUN_ID" --exit-status; then
  echo "오류: 윈도우 빌드 워크플로가 실패했습니다 (run $RUN_ID)."
  echo "      https://github.com/wis-graph/mermark/actions/runs/$RUN_ID 에서 로그를 확인하세요."
  echo "      macOS 자산은 이미 릴리스에 올라갔지만 updater.json은 갱신되지 않았으므로"
  echo "      어느 플랫폼에도 자동 업데이트 알림은 나가지 않습니다(안전 상태)."
  echo "      해결: 원인을 고친 뒤 이 스크립트를 그대로 다시 실행하세요 — 릴리스가 이미"
  echo "      있으므로 자동으로 재업로드+재디스패치 경로를 탑니다(손 수술 불필요)."
  exit 1
fi
echo "✓ 윈도우 빌드 완료 (run $RUN_ID)"

# --- 배포 게이트: 윈도우 업데이터 서명키 정합성 ------------------------------
# macOS와 정확히 같은 게이트를 윈도우 .sig에도 적용한다. CI가 서명을 시작하는
# 순간부터 이게 없으면 검증되지 않은 서명이 사용자에게 나갈 수 있다.
echo "=== 3. 윈도우 서명키 정합성 검증 ==="
WIN_ASSETS=$("$GH" release view "$TAG" --json assets --jq '.assets[].name')
WIN_EXE=$(echo "$WIN_ASSETS" | grep -i 'setup\.exe$' | head -n1 || true)
WIN_SIG=$(echo "$WIN_ASSETS" | grep -i 'setup\.exe\.sig$' | head -n1 || true)
if [ -z "$WIN_EXE" ] || [ -z "$WIN_SIG" ]; then
  echo "오류: '$TAG' 릴리스 자산에서 윈도우 setup.exe/.sig를 찾지 못했습니다."
  echo "      실제 자산 목록:"
  echo "$WIN_ASSETS" | sed 's/^/        /'
  exit 1
fi
WIN_TMPDIR=$(mktemp -d)
trap 'rm -rf "$WIN_TMPDIR"' EXIT
"$GH" release download "$TAG" --pattern "$WIN_SIG" --dir "$WIN_TMPDIR" --clobber
WIN_KEY_CHECK=$(python3 scripts/lib/check-signing-key.py "$WIN_TMPDIR/$WIN_SIG")
if [ "$WIN_KEY_CHECK" != "OK" ]; then
  echo "오류: 윈도우 업데이터 서명키가 앱이 신뢰하는 pubkey와 다릅니다 ($WIN_KEY_CHECK)"
  echo "      updater.json에 윈도우 플랫폼을 추가하지 않고 중단합니다."
  echo "      (macOS는 이미 배포됐지만 updater.json 미갱신이라 알림은 안 나갑니다.)"
  exit 1
fi
echo "✓ 윈도우 서명키 정합성 OK — $WIN_SIG가 tauri.conf.json의 pubkey와 같은 키"

echo "=== 4. updater.json 갱신 및 GitHub 배포 (darwin-aarch64 + windows-x86_64) ==="
run_mutating env \
  VERSION="$VERSION" \
  TAG="$TAG" \
  NOTES="$NOTES" \
  PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  MAC_SIG_CONTENT="$(cat "$SIG_PATH")" \
  WIN_EXE_NAME="$WIN_EXE" \
  WIN_SIG_CONTENT="$(cat "$WIN_TMPDIR/$WIN_SIG")" \
  node scripts/write-updater-json.mjs

echo "updater.json 파일이 갱신되었습니다. GitHub main 브랜치로 푸시합니다..."
run_mutating git add updater.json
run_mutating git commit -m "deploy: update release metadata for $TAG"
run_mutating git push origin main

echo "=================================================="
echo "🎉 v$VERSION 배포가 완벽하게 완료되었습니다!"
echo "이제 이전 사용자가 설정에서 '업데이트 확인'을 누르면 자동으로 이 버전이 적용됩니다."
echo "=================================================="
