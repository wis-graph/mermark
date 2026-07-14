#!/bin/bash
set -e

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
# pubkey(tauri.conf.json)도 .sig 파일도 "minisign 파일 전체를 base64로 한 번 더 감싼"
# 형태다. 한 겹 벗기면 [주석 줄 + base64 줄]이 나오고, 그 base64가
# [알고 2B][키ID 8B][본문…] — 이 키ID가 서로 일치해야 한다.
KEY_CHECK=$(SIG_PATH="$SIG_PATH" python3 - <<'PY'
import base64, json, os

def key_id(blob: str) -> bytes:
    for line in blob.splitlines():
        line = line.strip()
        if line and not line.lower().startswith(("untrusted comment:", "trusted comment:")):
            return base64.b64decode(line)[2:10]
    raise ValueError("base64 라인을 찾지 못함")

pub_b64 = json.load(open("src-tauri/tauri.conf.json"))["plugins"]["updater"]["pubkey"]
pub_id = key_id(base64.b64decode(pub_b64).decode())
sig_id = key_id(base64.b64decode(open(os.environ["SIG_PATH"], encoding="utf-8").read()).decode())
print("OK" if pub_id == sig_id else f"MISMATCH pub={pub_id.hex()} sig={sig_id.hex()}")
PY
)
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

echo "=== 1. GitHub Release ($TAG) 생성 및 파일 업로드 ==="
/opt/homebrew/bin/gh release create "$TAG" "$DMG_PATH" "$TAR_PATH" "$SIG_PATH" --title "$TAG" --notes "$NOTES"

echo "=== 2. updater.json 갱신 및 GitHub 배포 ==="
# 서명 파일 내용 읽기
SIG_CONTENT=$(cat "$SIG_PATH")

# updater.json 생성 — notes에 멀티라인 마크다운이 들어가므로 heredoc 문자열
# 치환 대신 python json.dump로 이스케이프를 보장한다.
NOTES="$NOTES" SIG_CONTENT="$SIG_CONTENT" VERSION="$VERSION" TAG="$TAG" python3 - <<'PY'
import json, os, datetime
json.dump(
    {
        "version": os.environ["VERSION"],
        "notes": os.environ["NOTES"],
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            "darwin-aarch64": {
                "signature": os.environ["SIG_CONTENT"],
                "url": f"https://github.com/wis-graph/mermark/releases/download/{os.environ['TAG']}/mermark.app.tar.gz",
            }
        },
    },
    open("updater.json", "w", encoding="utf-8"),
    ensure_ascii=False,
    indent=2,
)
PY

echo "updater.json 파일이 갱신되었습니다. GitHub main 브랜치로 푸시합니다..."
git add updater.json
git commit -m "deploy: update release metadata for $TAG"
git push origin main

echo "=================================================="
echo "🎉 v$VERSION 배포가 완벽하게 완료되었습니다!"
echo "이제 이전 사용자가 설정에서 '업데이트 확인'을 누르면 자동으로 이 버전이 적용됩니다."
echo "=================================================="
