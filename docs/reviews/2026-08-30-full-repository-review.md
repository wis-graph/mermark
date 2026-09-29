# mermark 전체 저장소 리뷰

- 리뷰 일자: 2026-08-30
- 대상 저장소: wis-graph/mermark
- 기준 버전: v0.16.1
- 기준 커밋: 44c8893
- 리뷰 범위: 아키텍처, 파일 저장·복구, 파일 감시, 검색, 문서 뷰어 격리, 의존성 보안, 테스트, 빌드, 릴리스, 유지보수성

## 1. 요약

mermark는 Tauri 2와 CodeMirror 6을 기반으로 한 기능 밀도 높은 데스크톱 문서 편집기다. Markdown 안전 렌더링, 충돌·복구 UX, 뷰어 동적 로딩, EPUB 스크립트 차단, SQLite 읽기 전용 처리, 업데이트 서명 검증 등 주요 경계에 설계 의도가 잘 드러난다. 프런트엔드 테스트도 넓고 세밀하다.

다만 현재 버전은 다음 릴리스 전에 해결할 필요가 있는 문제가 있다.

1. pdfjs-dist, Mermaid, DOMPurify의 알려진 런타임 취약점
2. mtime 하나에 의존하는 파일 충돌 검사와 워처 자체 저장 판별
3. 안전하지 않은 임시 파일 생성과 원자적 교체 과정의 파일 메타데이터 손실
4. Windows에서 스크립트 HTML 문서별 origin 격리가 성립하지 않는 문제
5. 테스트가 실제 릴리스 게이트에 포함되지 않은 문제

판정: 기능·구조·테스트 품질은 양호하지만, 보안 의존성과 저장 정합성 문제를 해결하기 전에는 새 릴리스를 보류하는 것이 안전하다.

## 2. 검토 및 검증 범위

| 항목 | 결과 |
|---|---|
| npm ci | 성공 |
| npm test | 성공: 136개 테스트 파일, 2,340개 테스트 |
| npm run build | 성공 |
| 프로덕션 의존성 감사 | 고위험 1건, 중간 2건 |
| cargo test | 실행하지 못함: 리뷰 환경에 cargo 없음 |
| cargo check | 실행하지 못함: 리뷰 환경에 cargo 없음 |
| 검토 코드 규모 | 관련 TypeScript·Rust·테스트·스크립트 약 76,575줄 |

빌드는 성공했지만 Vite가 500KB를 넘는 청크를 경고했다. 가장 큰 초기 JavaScript 청크는 약 1.06MB였고 Pretendard 가변 폰트는 약 2.06MB였다.

## 3. 발견사항

### F-01. 취약한 PDF 및 Mermaid 런타임 의존성

심각도: 릴리스 차단

현재 설치된 pdfjs-dist 6.1.200은 악성 PDF를 열 때 임의 JavaScript가 실행될 수 있는 취약점의 영향 범위에 포함된다. 패치 버전은 6.2.108이다. PDF 뷰어는 isEvalSupported를 false로 설정하지만, 해당 권고의 직접 완화책인 enableScripting: false는 설정하지 않는다. 앱 CSP가 일부 공격 경로를 제한할 수 있으나 이를 패치 대신 사용해서는 안 된다.

- [PDF.js 보안 권고](https://github.com/advisories/GHSA-hq66-cqwq-w95j)
- [PDF 로딩 설정](https://github.com/wis-graph/mermark/blob/main/src/extensions/pdf-viewer/index.ts#L1373-L1393)

Mermaid 11.15.0도 11.16.1 미만에 해당하는 CSS 주입, 프로토타입 오염, 무한 루프·서비스 거부 권고의 영향을 받는다. DOMPurify 3.4.12 취약점도 Mermaid를 통해 전이된다. 특히 mermark는 생성된 SVG 뒤에 별도 조작 요소를 붙이므로 형제 요소에 CSS가 적용되는 권고와 구조적으로 관련된다.

- [Mermaid CSS 주입 권고](https://github.com/advisories/GHSA-6x64-9x62-f2gx)
- [DOMPurify 권고](https://github.com/advisories/GHSA-55q2-fjhq-7xh7)

권고:

- pdfjs-dist를 6.2.108 이상으로 올린다.
- PDF getDocument 옵션에 enableScripting: false를 명시한다.
- Mermaid를 11.16.1 이상으로 올리고 잠금 파일의 DOMPurify도 패치 버전으로 갱신한다.
- npm audit --omit=dev를 PR 및 릴리스 게이트에 추가한다.

### F-02. 파일 충돌 검사가 파일 신원이 아니라 mtime 순서만 비교한다

심각도: 릴리스 차단

저장 경로는 baseline이 0이 아닐 때 현재 mtime이 baseline보다 큰 경우만 충돌로 판단한다. 다음 경우에는 외부 변경이 있어도 저장이 허용될 수 있다.

- 외부 도구가 같은 mtime 버킷 안에서 파일을 변경한 경우
- 타임스탬프를 보존하거나 과거 시각으로 설정한 경우
- 파일이 삭제되어 메타데이터 조회가 0을 반환한 경우
- 메타데이터 조회가 실패했지만 상위 디렉터리에는 쓸 수 있는 경우

워처도 이벤트 mtime이 마지막 자체 저장보다 과거이면 크기와 무관하게 자체 저장으로 처리하고, 같은 mtime과 같은 크기인 외부 변경도 자체 저장으로 처리한다. 이 조합에서는 외부 변경 알림이 사라지고 이후 자동 저장이 변경 내용을 덮어쓸 수 있다. 삭제된 파일을 자동 저장이 다시 생성하는 경쟁 조건도 백엔드 수준에서는 차단되지 않는다.

- [저장 충돌 검사](https://github.com/wis-graph/mermark/blob/main/src-tauri/src/commands.rs#L207-L236)
- [워처 자체 저장 판별](https://github.com/wis-graph/mermark/blob/main/src-tauri/src/watcher.rs#L77-L96)

권고:

- 읽기 결과에 mtime만이 아니라 파일 ID, 크기, 내용 해시 또는 명시적 revision 토큰을 포함한다.
- baseline이 존재할 때 대상 파일이 없거나 메타데이터를 읽지 못하면 실패 폐쇄 방식으로 충돌 처리한다.
- 실제 쓰기 직전에 기존 파일의 revision을 다시 비교한다.
- 워처 자체 저장 판별도 path·mtime·size 추정 대신 저장 시 기록한 강한 identity 또는 내용 해시를 사용한다.
- 같은 mtime·같은 크기 변경, 과거 mtime 변경, 삭제와 자동 저장 경쟁을 네이티브 통합 테스트로 추가한다.

### F-03. 임시 파일 생성과 교체가 파일시스템 의미를 보존하지 않는다

심각도: 높음

편집 저장은 예측 가능한 .mermark-tmp.<counter> 경로에 std::fs::write를 호출한다. create_new 또는 no-follow 성격의 방어가 없어 공유 디렉터리에 미리 만들어진 심볼릭 링크를 따라 쓸 수 있다. 같은 저장소의 첨부파일 가져오기 코드는 OpenOptions.create_new(true)를 사용하므로 두 경로의 안전 기준도 일치하지 않는다.

또한 새 임시 파일을 대상 경로로 rename하면 기존 inode가 교체된다. 그 결과 원본 권한, ACL, 확장 속성, Finder 태그, 심볼릭 링크와 하드 링크 관계가 사라질 수 있다. 쓰기 후 파일과 부모 디렉터리에 대한 fsync도 없어 시스템 장애 직후의 내구성은 원자성 설명보다 약하다.

- [현재 임시 파일 저장](https://github.com/wis-graph/mermark/blob/main/src-tauri/src/commands.rs#L229-L235)
- [첨부파일 경로의 create_new 사용](https://github.com/wis-graph/mermark/blob/main/src-tauri/src/attachment_import.rs#L230-L246)

권고:

- 충분히 예측 불가능한 이름과 create_new를 사용하고 심볼릭 링크를 따라가지 않도록 한다.
- 열린 파일 핸들을 기준으로 쓰기·검증·교체한다.
- 원본 권한과 플랫폼별 메타데이터 보존 정책을 명시한다.
- 필요한 내구성 수준에 맞춰 임시 파일과 부모 디렉터리를 동기화한다.
- 심볼릭 링크로 연 파일의 저장 의미를 명시하고 테스트한다.

### F-04. Windows 스크립트 HTML 문서의 origin 격리 보장이 성립하지 않는다

심각도: 높음

macOS와 Linux에서는 문서마다 token을 custom scheme host에 넣어 origin을 분리한다. Windows와 Android에서는 Tauri가 http://htmlview.localhost라는 고정 host를 사용하므로 token이 첫 번째 경로 세그먼트로 이동한다. 백엔드 주석도 이 플랫폼에서는 문서별 origin 보장이 성립하지 않는다고 명시한다.

프런트엔드는 스크립트 허용 시 iframe에 sandbox="allow-scripts allow-same-origin"을 부여한다. 따라서 Windows에서 동시에 열린 스크립트 문서들은 의도한 브라우저 origin 경계로 분리되지 않는다.

- [Windows fallback과 제한](https://github.com/wis-graph/mermark/blob/main/src-tauri/src/htmlview.rs#L239-L255)
- [스크립트 iframe sandbox](https://github.com/wis-graph/mermark/blob/main/src/extensions/html-viewer/index.ts#L303-L324)

권고:

- 동일한 보장을 구현할 때까지 Windows에서 스크립트 HTML 모드를 비활성화한다.
- 대안으로 프로세스당 하나의 스크립트 문서만 허용하거나 실제로 분리된 WebView/origin을 사용한다.
- 지원 플랫폼별 보안 보장을 설정 UI와 문서에 명시한다.
- Windows WebView2 실환경에서 교차 문서 DOM, storage, fetch 접근 테스트를 추가한다.

### F-05. 재귀 파일 검색이 불완전한 결과를 완전한 결과처럼 표시할 수 있다

심각도: 중간

검색 백엔드는 깊이 12와 파일 10,000개 제한에 도달하면 truncated를 반환한다. 그러나 읽을 수 없는 하위 디렉터리, 실패한 directory entry, 메타데이터 조회 실패는 조용히 건너뛰며 truncated를 설정하지 않는다. 프런트엔드는 truncated가 false이면 검색 결과를 완전한 것으로 취급하므로 실제로 파일을 건너뛴 상태에서 ‘일치하는 파일이 없습니다’를 표시할 수 있다.

- [재귀 검색 구현](https://github.com/wis-graph/mermark/blob/main/src-tauri/src/commands.rs#L1013-L1069)
- [검색 결과 표시](https://github.com/wis-graph/mermark/blob/main/src/sidebar/search/search-panel.ts#L218-L239)

권고:

- skippedCount와 partialReasons를 결과 계약에 추가한다.
- 어떤 하위 트리라도 읽지 못했다면 검색이 불완전하다는 배너를 표시한다.
- 필요하면 상세 경로는 노출하지 않고 실패 범주와 개수만 제공한다.

### F-06. 테스트가 PR 및 릴리스 게이트에 포함되지 않는다

심각도: 중간

저장소에는 광범위한 Vitest 테스트와 Rust 단위 테스트가 있지만 GitHub Actions에는 수동 실행되는 Windows 릴리스 워크플로 하나만 있다. 해당 워크플로와 scripts/release.sh는 프런트 빌드와 Tauri 빌드는 실행하지만 npm test, cargo test, cargo check를 강제하지 않는다. 따라서 테스트 실패 상태에서도 릴리스 산출물을 만들 수 있다.

- [Windows 릴리스 워크플로](https://github.com/wis-graph/mermark/blob/main/.github/workflows/release-windows.yml)
- [릴리스 스크립트](https://github.com/wis-graph/mermark/blob/main/scripts/release.sh)

권고:

- pull_request와 main push용 비밀키 없는 CI를 별도로 만든다.
- 최소 게이트를 npm ci, npm test, npm run build, cargo check, cargo test로 구성한다.
- 릴리스 스크립트 시작 전에 동일 게이트를 다시 확인한다.
- 테스트용 CI와 서명 권한을 가진 릴리스 워크플로를 분리한다.

### F-07. 초기 번들 크기와 앱 시작 비용

심각도: 중간

뷰어 확장을 동적으로 불러오는 구조는 좋지만 초기 JavaScript 청크가 약 1.06MB이고 Pretendard 가변 폰트가 약 2.06MB다. Mermaid, Wardley, XLSX, PDF 등의 개별 청크도 크다. 데스크톱 WebView에서는 네트워크 전송보다 parse·compile·메모리와 최초 화면 시간이 중요하므로 실제 cold start 예산을 두는 편이 좋다.

권고:

- bundle visualizer로 초기 청크의 CodeMirror, 아이콘, 글꼴 비중을 측정한다.
- Material icon 집합과 폰트 서브셋을 줄인다.
- 뷰어 모듈의 preload 조건을 명확히 한다.
- macOS와 Windows에서 cold start, 첫 문서 표시, 뷰어 최초 오픈 시간을 회귀 지표로 기록한다.

### F-08. 유지보수성과 공개 저장소 거버넌스

심각도: 낮음

src/main.ts는 약 1,765줄, src-tauri/src/commands.rs는 약 2,230줄로 조정 책임이 집중돼 있다. 또한 README, 소스, 테스트, 스크립트 등 105개 파일이 현재 저장소에 없는 _workspace 문서를 근거로 참조한다. 당시 의사결정의 흔적은 풍부하지만 외부 기여자는 근거 문서를 따라갈 수 없다.

공개 저장소 루트에는 LICENSE, SECURITY.md, Dependabot 설정이 없다. Cargo.toml의 authors=["you"]와 ‘Mermaid + Markdown viewer’ 설명도 현재 제품 범위와 맞지 않는다.

권고:

- main.ts를 부팅·문서 생명주기·워크스페이스 조정·뷰어 라우팅 단위로 분리한다.
- commands.rs를 파일 I/O, 탐색, 윈도우, 클립보드 등의 명시적 모듈로 분리한다.
- 유효한 설계 결정은 docs/decisions 또는 ADR로 옮기고 깨진 _workspace 참조를 제거한다.
- 라이선스 의도를 결정한 뒤 LICENSE, SECURITY.md, CONTRIBUTING.md를 추가한다.
- Dependabot 또는 동등한 의존성 갱신 정책을 설정한다.

## 4. 강점

- 2,340개 프런트 테스트가 통과하며 에디터, 렌더러, 워처 계약, 복구 상태, 설정과 뷰어를 넓게 다룬다.
- Markdown 렌더링은 제어된 DOM 생성 경로를 사용하고 Mermaid는 strict 보안 레벨을 사용한다.
- EPUB은 책의 임의 스크립트를 차단하고 zip entry 크기 제한을 둔다.
- SQLite 뷰어는 읽기 전용과 쿼리 시간 제한을 사용한다.
- HTML custom protocol은 token과 canonical path 검증으로 root escape를 막는다.
- 업데이트 공개키, 서명 검증, 액션 SHA 고정, 릴리스 자산 정합성 검사가 꼼꼼하다.
- 뷰어 등록 경계와 동적 import 구조가 확장에 유리하다.
- 충돌·복구 UI는 실패 시 사용자의 버퍼를 유지하려는 명확한 계약을 갖고 있다.

## 5. 권장 수정 순서

1. pdfjs-dist, Mermaid, DOMPurify를 패치하고 PDF scripting을 명시적으로 끈다.
2. mtime 기반 충돌 검사를 강한 파일 revision 계약으로 교체한다.
3. 임시 파일 생성·메타데이터 보존·fsync 정책을 보강한다.
4. Windows 스크립트 HTML 모드를 안전한 상태까지 제한한다.
5. PR 및 릴리스 CI에 프런트·Rust 테스트와 의존성 감사를 추가한다.
6. 불완전 검색 표시와 성능 예산을 추가한다.
7. 큰 조정 모듈과 깨진 설계 문서 참조를 점진적으로 정리한다.

## 6. 리뷰 제한

이 리뷰 환경에는 Rust cargo 도구체인이 없어 cargo test와 cargo check를 직접 실행하지 못했다. Rust 발견사항은 소스와 테스트 계약을 정적으로 검토한 결과다. 수정 후에는 macOS, Windows 실환경에서 네이티브 테스트와 파일시스템 경쟁 조건 테스트를 별도로 수행해야 한다.

이 문서는 코드 변경 없이 현재 main의 v0.16.1 상태를 검토한 기록이다.