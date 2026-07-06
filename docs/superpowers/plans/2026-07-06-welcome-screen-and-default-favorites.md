# Welcome Screen and Default Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱이 파일 경로 인자 없이 실행되었을 때 에디터 대신 중앙 정렬된 1컬럼의 웰컴 화면(즐겨찾기 상단, 최근 문서 하단)을 보여주고, 최초 실행 시 홈 폴더(`~`) 및 문서 폴더(`~/Documents`)를 자동으로 기본 즐겨찾기에 등록합니다.

**Architecture:**
1. **권한 설정**: `src-tauri/capabilities/default.json`에 `"path:default"` 권한을 등록해 프론트엔드가 홈 및 문서 경로를 획득할 수 있도록 합니다.
2. **백엔드 URL 라우팅**: `src-tauri/src/lib.rs`에서 `cli::parse_args` 결과가 `CliError::Missing`일 때 임시 파일 `untitled.md` 경로를 쿼리에 주던 우회 코드를 제거하고, 인자 없는 경우 `index.html` 단독(웰컴 상태)으로 앱 창을 생성하도록 롤백합니다.
3. **즐겨찾기 기본값 초기화**: `src/main.ts` 혹은 초기화 로직에 `initDefaultFavorites()` 비동기 함수를 추가하여 최초 실행 시 `~`와 `~/Documents` 절대 경로를 로컬 스토리지에 기본 등록합니다.
4. **웰컴 화면 UI 구현**: `src/main.ts`에서 `file` 쿼리 파라미터가 없으면 멈추는 대신 웰컴 화면 UI(`.welcome-pane`)를 렌더링하고, 클릭 시 해당 파일 열기 또는 즐겨찾기 폴더 점프 기능이 작동하도록 구현합니다.
5. **CSS 스타일 규칙**: `src/styles.css`에 웰컴 화면 전용 미니멀/중앙정렬 스타일을 정의합니다.

**Tech Stack:** Rust (Tauri Backend), TypeScript/CSS (Frontend)

## Global Constraints
- macOS 외에도 다른 OS 플랫폼의 기본 폴더를 정상 반환할 수 있도록 Tauri `homeDir()` 및 `documentDir()`을 표준적으로 사용합니다.
- UI 배치 시 컬럼을 쪼개지 않는 직관적인 1컬럼 중앙 정렬을 엄격히 고수합니다.

---

### Task 1: Tauri Permissions and Backend URL Routing

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add path permission in default.json**

  [src-tauri/capabilities/default.json:6-16](file:///Users/wis/Documents/programming/mermark/src-tauri/capabilities/default.json#L6-L16)의 `permissions` 배열 내부에 `"path:default"`를 추가하여 프론트엔드의 path API 권한을 획득합니다.
  
  ```json
    "permissions": [
      ...
      "process:allow-restart",
      "path:default"
    ]
  ```

- [ ] **Step 2: Modify Argument Handling in Rust Setup**

  [src-tauri/src/lib.rs:226-250](file:///Users/wis/Documents/programming/mermark/src-tauri/src/lib.rs#L226-L250)의 `parsed_args` 처리 흐름을 수정합니다. 에러 시 강제 종료가 아닌, 파일 인자가 없을 때 `None`을 리턴하도록 처리하고 창 로드 시 `index.html`만 전달하게 구성합니다.

  ```rust
            let parsed_args = cli::parse_args(&args, &cwd);
            let launch_args = match parsed_args {
                Ok(args) => Some(args),
                Err(cli::CliError::Missing) => None,
                Err(cli::CliError::IsDirectory(p)) => {
                    eprintln!(
                        "mermark: {} is a directory, not a file.\nusage: mermark <file.md>",
                        p.display()
                    );
                    std::process::exit(2);
                }
            };
  ```

- [ ] **Step 3: Modify Webview URL Construction in Rust Setup**

  [src-tauri/src/lib.rs:251-285](file:///Users/wis/Documents/programming/mermark/src-tauri/src/lib.rs#L251-L285)의 창 빌드 로직을 변경합니다:

  ```rust
            let url = match launch_args {
                Some(cli::LaunchArgs { target, right }) => {
                    let target_path = match target {
                        cli::Target::File(path) => {
                            if let Err(e) = ensure_file_target(&path) {
                                eprintln!("mermark: cannot open {}: {e}", path.display());
                                std::process::exit(2);
                            }
                            path
                        }
                        cli::Target::Stdin => {
                            if !stdin_is_piped() {
                                eprintln!(
                                    "mermark: '-' reads piped stdin; nothing was piped.\nusage: cat file.md | mermark -"
                                );
                                std::process::exit(2);
                            }
                            write_stdin_to_scratch(
                                std::io::stdin().lock(),
                                &std::env::temp_dir(),
                            )
                            .map_err(|e| format!("mermark: failed to buffer stdin: {e}"))?
                        }
                    };
                    tauri::WebviewUrl::App(
                        format!(
                            "index.html?file={}",
                            urlencoding::encode(&target_path.to_string_lossy())
                        )
                        .into(),
                    )
                }
                None => {
                    // 파일 인자가 전혀 없을 때 쿼리 없이 웰컴 모드로 창 띄움
                    tauri::WebviewUrl::App("index.html".into())
                }
            };

            // right-docks(우측도킹) flag가 있을 때와 없을 때 빌더 설정
            let right_flag = launch_args.as_ref().map(|a| a.right).unwrap_or(false);
            let right_half = if right_flag {
                app.primary_monitor()
                    .ok()
                    .flatten()
                    .map(|monitor| {
                        let scale = monitor.scale_factor();
                        let size = monitor.size();
                        let logical_width = size.width as f64 / scale;
                        let logical_height = size.height as f64 / scale;
                        right_half_geometry(logical_width, logical_height)
                    })
            } else {
                None
            };
  ```

- [ ] **Step 4: Verify Rust Build**

  Run: `npm run tauri build -- --no-bundle`
  Expected: Rust 소스가 성공적으로 컴파일됨.

- [ ] **Step 5: Commit**

  ```bash
  git add src-tauri/capabilities/default.json src-tauri/src/lib.rs
  git commit -m "feat(backend): configure welcome URL routing and path permissions"
  ```

---

### Task 2: Default Favorites Initialization and Welcome UI

**Files:**
- Modify: `src/main.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Implement `initDefaultFavorites`**

  [src/main.ts](file:///Users/wis/Documents/programming/mermark/src/main.ts)의 상단 임포트 부분에 아래 내용을 추가합니다:
  
  ```typescript
  import { homeDir, documentDir } from "@tauri-apps/api/path";
  import { normalizePath, basename } from "./path";
  ```

  그리고 `boot()` 함수 진입점 혹은 적당한 상단에 기본 즐겨찾기 초기화 코드를 추가합니다:

  ```typescript
  async function initDefaultFavorites() {
    const current = favoriteFoldersSetting.get();
    if (current.length === 0 && localStorage.getItem("mermark.favoriteFolders") === null) {
      try {
        const home = await homeDir();
        const docs = await documentDir();
        if (home) favoriteFoldersSetting.set(t => [...t, normalizePath(home)]);
        // 만약 t => [...t] 형태가 아니라면 일반 세팅 업데이트 방식을 사용:
        // const list = [normalizePath(home)];
        // if (docs) list.push(normalizePath(docs));
        // favoriteFoldersSetting.set(list);
        const list: string[] = [];
        if (home) list.push(normalizePath(home));
        if (docs) list.push(normalizePath(docs));
        favoriteFoldersSetting.set(list);
      } catch (err) {
        console.error("Failed to init default favorites:", err);
      }
    }
  }
  ```

  이후 `boot()` 비동기 함수 시작 시점에 `await initDefaultFavorites();`를 기입합니다.

- [ ] **Step 2: Render Welcome Screen in main.ts**

  [src/main.ts:175-180](file:///Users/wis/Documents/programming/mermark/src/main.ts#L175-L180)의 `if (!file)` 처리를 단순 에러 출력이 아닌 웰컴 대시보드 화면 생성으로 대체합니다.

  **기존 코드:**
  ```typescript
    const file = new URLSearchParams(location.search).get("file");
    if (!file) {
      root.textContent = "No file specified.";
      return;
    }
  ```

  **수정 코드:**
  ```typescript
    const file = new URLSearchParams(location.search).get("file");
    
    // 파일이 없이 구동되었을 때 웰컴 화면 마운트
    if (!file) {
      // #app 구조를 초기화하고 웰컴 전용 사이드바 + 웰컴 중앙 화면 구성
      root.innerHTML = "";
      const host = el("div", "editor-host welcome-host");
      const workspace = el("div", "workspace");
      workspace.append(host);
      
      const bar = el("div", "status-bar");
      const titleBar = createTitleBar();
      root.append(titleBar.el, workspace, bar);
      
      seedSessionMode();
      
      // 사이드바 구조 셋업 (기존 에디터 켜질 때와 동일)
      const breadcrumb = createBreadcrumb({ onJump: (abs) => explorer.jumpToRoot(abs) });
      const closeOtherSidebars = (keep: "explorer" | "outline" | "recent"): void => {
        if (keep !== "explorer") explorer.close();
        if (keep !== "outline") outline.close();
        if (keep !== "recent") recent.close();
      };
      
      const outline = createOutlinePanel({
        getView: () => undefined as any, // 웰컴 모드에선 뷰가 없음
        onOpen: () => closeOtherSidebars("outline"),
      });
      
      const favoritesSection = createFavoritesSection({
        getFavorites: () => favoriteFoldersSetting.get(),
        onJump: (abs) => explorer.jumpToRoot(abs),
        onRemove: (abs) => favoriteFoldersSetting.set(removeFavorite(favoriteFoldersSetting.get(), abs)),
      });
      
      function toggleFavorite(abs: string): void {
        const list = favoriteFoldersSetting.get();
        favoriteFoldersSetting.set(isFavorite(list, abs) ? removeFavorite(list, abs) : pushFavorite(list, abs));
      }
      
      const explorer = createExplorerPanel({
        listDir: (p) => invoke("list_dir", { path: p }),
        getBaseDir: () => "", // baseDir 없음
        onOpenFile: async (absPath) => {
          // 파일을 선택해 열었을 때 index.html을 해당 파일 파라미터와 함께 리다이렉트
          location.href = `index.html?file=${encodeURIComponent(absPath)}`;
        },
        onOpen: () => closeOtherSidebars("explorer"),
        onRootChange: (root) => breadcrumb.render(root),
        isFavorite: (p) => isFavorite(favoriteFoldersSetting.get(), p),
        onToggleFavorite: toggleFavorite,
        favoritesSlot: favoritesSection.el,
        focusFavorites: favoritesSection.focusFirst,
      });
      
      const recent = createRecentPanel({
        getRecent: () => recentDocsSetting.get(),
        onOpenFile: async (absPath) => {
          location.href = `index.html?file=${encodeURIComponent(absPath)}`;
        },
        onOpen: () => closeOtherSidebars("recent"),
      });
      
      const mode = makeModeToggle();
      const pos = el("span", "status-pos");
      const spacer = el("span", "status-spacer");
      const save = makeSaveStatus();
      const themeBtn = makeThemeToggle(() => loadPreset(nextPreset(themeSetting.get())));
      themeSetting.bind(themeBtn.render);
      
      arrangeTitleBar(titleBar.el, {
        explorer: explorer.button,
        recent: recent.button,
        outline: outline.button,
        openPath: null as any, // 웰컴화면에선 경로열기 숨김
        mode: mode.btn,
        theme: themeBtn.btn,
        settings: createSettingsButton(),
      });
      
      arrangeStatusBar(bar, {
        breadcrumb: breadcrumb.el,
        spacer,
        save: save.el,
        pos,
      });
      
      workspace.prepend(outline.aside);
      workspace.prepend(explorer.aside);
      workspace.prepend(recent.aside);
      
      const sash = createSidebarSash();
      host.before(sash.el);
      
      // ── 웰컴 화면 본문 드로잉 (중앙 정렬 1컬럼 스크롤) ──
      const pane = el("div", "welcome-pane");
      
      // 1. 즐겨찾기 섹션
      const favSection = el("div", "welcome-section");
      const favHeader = el("h2", "welcome-title");
      favHeader.textContent = "즐겨찾기";
      favSection.append(favHeader);
      
      const renderFavorites = () => {
        const folders = favoriteFoldersSetting.get();
        const listContainer = el("div", "welcome-list");
        if (folders.length === 0) {
          const empty = el("div", "welcome-empty");
          empty.textContent = "등록된 즐겨찾기 폴더가 없습니다.";
          listContainer.append(empty);
        } else {
          folders.forEach(folder => {
            const row = el("div", "welcome-row welcome-folder-row");
            const iconSpan = el("span", "welcome-icon");
            iconSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
            
            const name = el("span", "welcome-name");
            name.textContent = basename(folder) || folder;
            
            const pathInfo = el("span", "welcome-path");
            pathInfo.textContent = folder;
            
            row.append(iconSpan, name, pathInfo);
            row.addEventListener("click", () => {
              explorer.jumpToRoot(folder);
              // 탐색기 사이드바 열기
              explorer.open();
            });
            listContainer.append(row);
          });
        }
        return listContainer;
      };
      
      let favList = renderFavorites();
      favSection.append(favList);
      pane.append(favSection);
      
      // 즐겨찾기 갱신 구독
      favoriteFoldersSetting.subscribe(() => {
        const next = renderFavorites();
        favList.replaceWith(next);
        favList = next;
      });
      
      // 2. 최근 문서 섹션
      const recSection = el("div", "welcome-section");
      const recHeader = el("h2", "welcome-title");
      recHeader.textContent = "최근 문서";
      recSection.append(recHeader);
      
      const renderRecents = () => {
        const docs = recentDocsSetting.get();
        const listContainer = el("div", "welcome-list");
        if (docs.length === 0) {
          const empty = el("div", "welcome-empty");
          empty.textContent = "최근 열어본 문서가 없습니다.";
          listContainer.append(empty);
        } else {
          docs.forEach(doc => {
            const row = el("div", "welcome-row welcome-file-row");
            const iconSpan = el("span", "welcome-icon");
            iconSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
            
            const name = el("span", "welcome-name");
            name.textContent = basename(doc);
            
            const pathInfo = el("span", "welcome-path");
            pathInfo.textContent = doc;
            
            row.append(iconSpan, name, pathInfo);
            row.addEventListener("click", () => {
              location.href = `index.html?file=${encodeURIComponent(doc)}`;
            });
            listContainer.append(row);
          });
        }
        return listContainer;
      };
      
      let recList = renderRecents();
      recSection.append(recList);
      pane.append(recSection);
      
      // 최근 문서 갱신 구독
      recentDocsSetting.subscribe(() => {
        const next = renderRecents();
        recList.replaceWith(next);
        recList = next;
      });
      
      host.append(pane);
      
      // sidebar 가로 너비 동기화
      sidebarWidthSetting.bind(cssVarSink("--sidebar-width", (px: number) => `${px}px`));
      
      return;
    }
  ```

- [ ] **Step 3: Define CSS Rules in styles.css**

  [src/styles.css](file:///Users/wis/Documents/programming/mermark/src/styles.css)의 적당한 하단에 웰컴 화면 전용 CSS 스타일 규칙을 추가합니다:

  ```css
  /* ── 웰컴 화면 스타일 ──────────────────────────────────────────────────────── */
  .welcome-host {
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow-y: auto;
    background: var(--bg);
    color: var(--fg);
    width: 100%;
    height: 100%;
  }

  .welcome-pane {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 800px;
    padding: 6rem 2rem;
    box-sizing: border-box;
    gap: 4rem;
  }

  .welcome-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center; /* 전체 중앙 정렬 */
    width: 100%;
  }

  .welcome-title {
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--fg);
    opacity: 0.95;
    margin: 0;
    text-align: center;
  }

  .welcome-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    max-width: 600px; /* 리스트 가로너비 제한 */
  }

  .welcome-empty {
    padding: 2rem;
    text-align: center;
    font-size: 13px;
    color: var(--muted);
    border: 1px dashed var(--border);
    border-radius: 6px;
  }

  .welcome-row {
    display: flex;
    align-items: center;
    padding: 0.8rem 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    background: color-mix(in srgb, var(--bg) 95%, var(--surface));
    transition: background 0.15s ease, border-color 0.15s ease;
    gap: 0.8rem;
  }

  .welcome-row:hover {
    background: color-mix(in srgb, var(--bg) 85%, var(--accent));
    border-color: var(--accent);
  }

  .welcome-icon {
    display: flex;
    align-items: center;
    color: var(--accent);
    opacity: 0.8;
  }

  .welcome-name {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 120px;
  }

  .welcome-path {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-left: auto; /* 우측 정렬 */
    padding-left: 1rem;
  }
  ```

- [ ] **Step 4: Verify Frontend Build**

  Run: `npm run build`
  Expected: 빌드가 성공적으로 통과함.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main.ts src/styles.css
  git commit -m "feat(frontend): implement welcome dashboard UI and default favorites"
  ```
