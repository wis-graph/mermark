// The "버전" category's pane: version display + the update-check/install flow
// that used to live as a small corner of the sidebar (a version line + a
// "업데이트 확인" button + an inline result note). It's promoted to a full-size
// category here per DESIGN feedback ("UI 큼직하게") and gains a download
// progress bar. Tauri v2's webview (wry) doesn't implement window.confirm/alert
// — it's a quiet no-op (2026-07-11 실사용 확인: 업데이트를 찾아도 confirm()이
// 창 없이 false를 반환해 버튼이 "죽은" 것처럼 보였다) — so the install offer and
// progress are drawn as real DOM here instead of a dialog. modal.ts just mounts
// this pane into .settings-pane like any registry category; this module owns
// the version/update DOM and its wiring exclusively.
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { icon } from "../../icons";
import { downloadPercent, formatDownloadProgress } from "./update-progress";
import { parseChangelogGroups, parseChangelogSections, type ChangelogGroup, type ChangelogSection } from "./changelog";
import { renderInlineMarkdown } from "../../markdown/inline-render";
// Bundled as a plain string at build time (vite's `?raw` — see src/vite-env.d.ts
// for the ambient module type). No IPC: CHANGELOG.md ships inside the app, so
// the "변경 내역" section reads from what was built, not the live repo file.
import changelogRaw from "../../../CHANGELOG.md?raw";

// "변경 내역" shows the newest N sections — enough to feel useful without
// turning the panel into the whole changelog file.
const CHANGELOG_SECTION_LIMIT = 3;

/** Build the 버전 pane. Factory, mirrors the registry renderers: a fresh root
 *  each call, no external subscriptions to tear down (state lives on local
 *  closures, not a Setting), so modal.ts can mount/discard it like any pane. */
export function renderVersionPane(): HTMLElement {
  const root = document.createElement("div");
  root.className = "version-pane";

  const heading = document.createElement("div");
  heading.className = "version-pane-heading";
  heading.textContent = "mermark";
  root.appendChild(heading);

  const versionNum = document.createElement("div");
  versionNum.className = "version-pane-number";
  versionNum.textContent = "—"; // replaced once getVersion() resolves; no hardcoded fallback
  root.appendChild(versionNum);
  getVersion()
    .then((v) => {
      if (v) versionNum.textContent = `v${v}`;
    })
    .catch(() => {});

  const checkBtn = document.createElement("button");
  checkBtn.type = "button";
  checkBtn.className = "version-check-btn";
  checkBtn.append(icon("refresh-cw"), " 업데이트 확인");
  root.appendChild(checkBtn);

  const status = document.createElement("div");
  status.className = "version-status";
  root.appendChild(status);

  let isChecking = false;
  checkBtn.addEventListener("click", async () => {
    if (isChecking) return;
    isChecking = true;
    checkBtn.disabled = true;
    showChecking(status);
    try {
      const update = await check();
      if (update) showAvailable(status, update, checkBtn);
      else showUpToDate(status);
    } catch (err) {
      showError(status, `업데이트 확인 실패: ${err}`);
    } finally {
      isChecking = false;
      checkBtn.disabled = false;
    }
  });

  root.appendChild(renderChangelog());

  return root;
}

/** Render a single "### 카테고리" group as a subheading (when labeled) + a
 *  bullet list, each bullet's `**bold**: text` run through the shared inline
 *  markdown renderer (no innerHTML — same XSS-safe path as table cells). */
function renderChangelogGroup(group: ChangelogGroup): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "version-changelog-group";
  if (group.category) {
    const cat = document.createElement("div");
    cat.className = "version-changelog-cat";
    cat.textContent = group.category;
    wrap.appendChild(cat);
  }
  const list = document.createElement("ul");
  list.className = "version-changelog-list";
  for (const item of group.items) {
    const li = document.createElement("li");
    li.appendChild(renderInlineMarkdown(item));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

/** Render a flat list of category groups (shared by the "변경 내역" section's
 *  per-version groups AND an update card's release-notes groups — same shape,
 *  same renderer, no duplicated DOM-building logic). */
function renderChangelogGroups(groups: ChangelogGroup[]): HTMLElement {
  const wrap = document.createElement("div");
  for (const group of groups) wrap.appendChild(renderChangelogGroup(group));
  return wrap;
}

function renderChangelogSection(section: ChangelogSection): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "version-changelog-section";
  const head = document.createElement("div");
  head.className = "version-changelog-section-head";
  const ver = document.createElement("span");
  ver.className = "version-changelog-version";
  ver.textContent = `v${section.version}`;
  head.appendChild(ver);
  if (section.date) {
    const date = document.createElement("span");
    date.className = "version-changelog-date";
    date.textContent = section.date;
    head.appendChild(date);
  }
  wrap.append(head, renderChangelogGroups(section.groups));
  return wrap;
}

/** The "변경 내역" section under the update UI: CHANGELOG.md's newest
 *  CHANGELOG_SECTION_LIMIT version sections, each with its own heading + date +
 *  category groups. */
function renderChangelog(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "version-changelog";
  const heading = document.createElement("div");
  heading.className = "version-changelog-heading";
  heading.textContent = "변경 내역";
  wrap.appendChild(heading);
  for (const section of parseChangelogSections(changelogRaw, CHANGELOG_SECTION_LIMIT)) {
    wrap.appendChild(renderChangelogSection(section));
  }
  return wrap;
}

/** "확인 중..." spinner. Command/CQS: void, mutates `status` in place. */
function showChecking(status: HTMLElement): void {
  status.replaceChildren();
  const row = document.createElement("div");
  row.className = "version-status-row";
  const spinner = icon("loader-circle");
  spinner.classList.add("version-spin");
  row.append(spinner, document.createTextNode("확인 중..."));
  status.appendChild(row);
}

/** "최신 버전을 사용 중입니다". Command/CQS: void. */
function showUpToDate(status: HTMLElement): void {
  status.replaceChildren();
  const row = document.createElement("div");
  row.className = "version-status-row is-ok";
  row.append(icon("check"), document.createTextNode("최신 버전을 사용 중입니다"));
  status.appendChild(row);
}

/** A red inline error note (check failure or install failure share this). */
function showError(status: HTMLElement, message: string): void {
  status.replaceChildren();
  const note = document.createElement("div");
  note.className = "version-status-error";
  note.textContent = message;
  status.appendChild(note);
}

/** The found-an-update card: version + optional publish date + big install/later
 *  actions + a progress slot (hidden until install starts). Command/CQS: void —
 *  wires the install click, doesn't return anything for the caller to hold. */
function showAvailable(status: HTMLElement, update: Update, checkBtn: HTMLButtonElement): void {
  status.replaceChildren();
  const card = document.createElement("div");
  card.className = "version-update-card";

  const title = document.createElement("div");
  title.className = "version-update-title";
  title.textContent = `v${update.version} 업데이트가 있습니다`;
  card.appendChild(title);

  if (update.date) {
    const date = document.createElement("div");
    date.className = "version-update-date";
    date.textContent = update.date;
    card.appendChild(date);
  }

  // release.sh feeds updater.json's `notes` from the matching CHANGELOG.md
  // section, so update.body shares the "### Category / - bullet" shape —
  // parse/render it through the exact same path as the 변경 내역 section.
  if (update.body) {
    const notes = document.createElement("div");
    notes.className = "version-update-notes";
    notes.appendChild(renderChangelogGroups(parseChangelogGroups(update.body)));
    card.appendChild(notes);
  }

  const actions = document.createElement("div");
  actions.className = "version-update-actions";
  const install = document.createElement("button");
  install.type = "button";
  install.className = "version-install-btn";
  install.textContent = "지금 설치하고 재시작";
  const later = document.createElement("button");
  later.type = "button";
  later.className = "version-later-btn";
  later.textContent = "나중에";
  later.addEventListener("click", () => status.replaceChildren());
  actions.append(install, later);
  card.appendChild(actions);

  const progress = document.createElement("div");
  progress.className = "version-progress";
  progress.hidden = true;
  const caption = document.createElement("div");
  caption.className = "version-progress-caption";
  const track = document.createElement("div");
  track.className = "version-progress-track";
  const fill = document.createElement("div");
  fill.className = "version-progress-fill";
  track.appendChild(fill);
  progress.append(caption, track);
  card.appendChild(progress);

  install.addEventListener("click", () => startInstall(update, { install, later, checkBtn, progress, caption, fill, status }));

  status.appendChild(card);
}

/** Drive downloadAndInstall → relaunch, updating the progress bar/caption from
 *  each DownloadEvent (Started fixes the total, Progress accumulates, Finished
 *  announces the impending relaunch). Locks 나중에/업데이트 확인 for the
 *  duration so the flow can't be abandoned or restarted mid-install. */
function startInstall(
  update: Update,
  els: {
    install: HTMLButtonElement;
    later: HTMLButtonElement;
    checkBtn: HTMLButtonElement;
    progress: HTMLElement;
    caption: HTMLElement;
    fill: HTMLElement;
    status: HTMLElement;
  },
): void {
  const { install, later, checkBtn, progress, caption, fill, status } = els;
  install.disabled = true;
  later.disabled = true;
  checkBtn.disabled = true;
  progress.hidden = false;
  caption.textContent = "다운로드 중...";

  let downloaded = 0;
  let total: number | null = null;
  update
    .downloadAndInstall((ev: DownloadEvent) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? null;
      } else if (ev.event === "Progress") {
        downloaded += ev.data.chunkLength;
        caption.textContent = formatDownloadProgress(downloaded, total);
        const pct = downloadPercent(downloaded, total);
        if (pct != null) fill.style.width = `${pct}%`;
      } else if (ev.event === "Finished") {
        fill.style.width = "100%";
        caption.textContent = "설치 중... 곧 재시작됩니다";
      }
    })
    .then(() => relaunch())
    .catch((err) => {
      checkBtn.disabled = false;
      showError(status, `설치 실패: ${err}`);
    });
}
