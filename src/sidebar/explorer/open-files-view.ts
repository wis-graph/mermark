import { icon } from "../../icons";
import { basename, dirOf } from "../../document/path";
import { extensionOf, renderEntryGlyph } from "./file-icons";
import type { VaultTab, VaultTabs } from "../../workspace/vault-tabs";

export type ExplorerView = "tree" | "open-files";

/** 한 볼트의 열린 파일 스냅샷. scopeId = vaultId(탐색기에겐 불투명 문자열). */
export interface OpenFilesSnapshot {
  readonly scopeId: string;
  readonly tabs: VaultTabs;
  /** D6 접두사 기준 — 영구=rootPath, 글로벌·원격=null(접두사 없음). */
  readonly rootPath: string | null;
}

export interface OpenFilesHandlers {
  /** pure query */
  current(): OpenFilesSnapshot;
  /** command — 반환 Promise는 잡지 않는다(복구 UI는 openDocumentSafely가 소유). */
  onSelect(scopeId: string, tab: VaultTab): void | Promise<boolean>;
  /** command */
  onClose(scopeId: string, tab: VaultTab): void;
}

export interface OpenFilesView {
  readonly root: HTMLElement;
  /** current()를 다시 읽어 전부 재구성. command */
  render(): void;
  /** 활성 행 select → 첫 행 select → root 순으로 포커스. command */
  focusPrimary(): void;
}

const EMPTY_TEXT = "열린 파일이 없습니다. 트리에서 파일을 열면 여기에 표시됩니다.";

/** D6's one-level folder prefix: the muted "which folder" hint shown before a
 *  file's name, or null when none applies (no vault root; file directly under
 *  the root). Two-or-more levels deep collapses to a bare "…/", and a single
 *  level over MAX_PREFIX_CHARS keeps its first N characters plus "…/".
 *  Pure query — the caller also decides on the PREVIOUS row's folder. */
const MAX_PREFIX_CHARS = 10;
export function folderPrefixFor(path: string, vaultRoot: string | null): string | null {
  if (!vaultRoot) return null;
  const dir = dirOf(path);
  if (dir === vaultRoot) return null;
  if (!dir.startsWith(vaultRoot)) return null; // defensive: a tab outside its own vault's root
  const relative = dir.slice(vaultRoot.length).replace(/^[\\/]/, "");
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length > 1) return "…/";
  const folder = segments[0] ?? "";
  return folder.length > MAX_PREFIX_CHARS ? `${folder.slice(0, MAX_PREFIX_CHARS)}…/` : `${folder}/`;
}

/** D5: the icon already says the type, so the extension is stripped — only when
 *  there IS one (extensionOf excludes dotfiles), so "README"/".gitignore" stay. Pure query. */
export function openFileLabel(path: string): string {
  const base = basename(path);
  const ext = extensionOf(base);
  return ext ? base.slice(0, base.length - ext.length - 1) : base;
}

/** D7: display order = path order (plain string comparison, deterministic across
 *  locales). Sorts a COPY — the stored order is untouched. Pure query. */
export function inPathOrder(tabs: readonly VaultTab[]): VaultTab[] {
  return [...tabs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Whether `tab` is the vault's active file. Pure query. */
export function isActiveOpenFile(tab: VaultTab, tabs: VaultTabs): boolean {
  return tab.tabId === tabs.activeTabId;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};

/** Explorer's "열린 파일" body: a flat list of the current vault's tabs. Pure DOM
 *  — it knows nothing of VaultTabStore; main.ts injects the snapshot query and
 *  the select/close commands (same convention as listDir/isVaultRegistered). */
export function createOpenFilesView(handlers: OpenFilesHandlers): OpenFilesView {
  const root = create("div", "explorer-open-files");
  root.setAttribute("role", "list");
  root.setAttribute("aria-label", "열린 파일");
  root.tabIndex = -1;

  const render = (): void => {
    const snapshot = handlers.current();
    root.replaceChildren();
    if (snapshot.tabs.tabs.length === 0) {
      const empty = create("div", "explorer-empty");
      empty.textContent = EMPTY_TEXT;
      root.append(empty);
      return;
    }
    // Prefix tracks the real folder path (not the lossy "…/" text) so two
    // different deep folders are never mistaken for "the same folder".
    let previousDir: string | null = null;
    for (const tab of inPathOrder(snapshot.tabs.tabs)) {
      const base = basename(tab.path);
      const dir = dirOf(tab.path);
      const prefixText = dir === previousDir ? null : folderPrefixFor(tab.path, snapshot.rootPath);
      previousDir = dir;
      const item = create("div", "explorer-open-file");
      item.setAttribute("role", "listitem");
      const select = create("button", "explorer-open-file-select");
      select.type = "button"; select.dataset.tabId = tab.tabId; select.title = tab.path;
      const glyph = create("span", "explorer-open-file-glyph");
      renderEntryGlyph(glyph, base, false, false);
      select.append(glyph);
      if (prefixText) {
        const prefix = create("span", "explorer-open-file-prefix");
        prefix.textContent = prefixText;
        select.append(prefix);
      }
      const name = create("span", "explorer-open-file-name");
      name.textContent = openFileLabel(tab.path);
      select.append(name);
      if (isActiveOpenFile(tab, snapshot.tabs)) { select.dataset.active = "true"; select.setAttribute("aria-current", "page"); }
      // snapshot is captured: a late click resolves to the vault this row belongs to.
      select.addEventListener("click", () => { void handlers.onSelect(snapshot.scopeId, tab); });
      const close = create("button", "explorer-open-file-close");
      close.type = "button"; close.title = "닫기"; close.setAttribute("aria-label", `${base} 닫기`);
      close.append(icon("x"));
      close.addEventListener("click", (event) => { event.stopPropagation(); handlers.onClose(snapshot.scopeId, tab); });
      item.append(select, close);
      root.append(item);
    }
  };

  const focusPrimary = (): void => {
    const target = root.querySelector<HTMLElement>(".explorer-open-file-select[data-active=\"true\"]")
      ?? root.querySelector<HTMLElement>(".explorer-open-file-select")
      ?? root;
    target.focus();
  };

  return { root, render, focusPrimary };
}
