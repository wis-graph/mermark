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

echo "=== 1. GitHub Release ($TAG) 생성 및 파일 업로드 ==="
/opt/homebrew/bin/gh release create "$TAG" "$DMG_PATH" "$TAR_PATH" "$SIG_PATH" --title "$TAG" --notes "mermark $TAG 버전 자동 릴리즈 업데이트"

echo "=== 2. updater.json 갱신 및 GitHub 배포 ==="
# 서명 파일 내용 읽기
SIG_CONTENT=$(cat "$SIG_PATH")

# updater.json 생성
cat <<EOF > updater.json
{
  "version": "$VERSION",
  "notes": "mermark $TAG 버전 자동 릴리즈 업데이트",
  "pub_date": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG_CONTENT",
      "url": "https://github.com/wis-graph/mermark/releases/download/$TAG/mermark.app.tar.gz"
    }
  }
}
EOF

echo "updater.json 파일이 갱신되었습니다. GitHub main 브랜치로 푸시합니다..."
git add updater.json
git commit -m "deploy: update release metadata for $TAG"
git push origin main

echo "=================================================="
echo "🎉 v$VERSION 배포가 완벽하게 완료되었습니다!"
echo "이제 이전 사용자가 설정에서 '업데이트 확인'을 누르면 자동으로 이 버전이 적용됩니다."
echo "=================================================="
