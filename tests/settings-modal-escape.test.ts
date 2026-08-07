import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSettingsButton } from "../src/settings/panel/modal";
import { themeJsonSetting } from "../src/settings/app";
import { builtInTheme } from "../src/settings/theme-schema";

// 2026-08 폴리시 5차 (team-lead, 사용자 보고: "esc 누르면 설정 자체가 사라져서
// 그건 별로고") — 이 테스트가 있었으면 그 결함이 그때 잡혔을 것이다.
//
// 별도 파일로 분리한 이유: modal.ts의 Escape-to-close 리스너는
// `document.addEventListener("keydown", onKeydown, true)`로 열 때 걸리고
// 닫을 때(`close()`)만 해제된다. `settings-modal.test.ts`의 몇몇 기존
// 테스트는 모달을 연 뒤 명시적으로 닫지 않는다(다음 테스트의
// `document.body.innerHTML = ""`가 DOM만 지울 뿐, `document` 자신에 걸린
// 리스너는 안 지운다) — 그 상태로 이 파일의 테스트와 같은 vitest 파일에
// 같이 있으면, 그 스테일 리스너들이 이 파일의 Escape 디스패치에도 같이
// 반응해 `activeEscapeConsumer`(controls.ts의 모듈 전역)를 내 테스트보다
// 먼저 "소비"해버려 결과가 오염된다(실제로 처음 이 테스트를 같은 파일에
// 뒀을 때 이 현상으로 실패했다). vitest는 테스트 파일마다 별도 jsdom
// 환경을 주므로, 파일을 분리하면 그 스테일 리스너 자체가 존재하지 않는다.
// 그리고 이 파일 안에서도 각 테스트가 끝나면 실제 `close()`를 트리거해
// (백드롭 자체 클릭 — 기존 공개 동작) 리스너를 정확히 해제한다, 새 API를
// 발명하지 않는다.
describe("settings modal — Escape의 중첩 해제(nested dismiss, 폴리시 5차)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    themeJsonSetting.set(builtInTheme("light"));
  });

  afterEach(() => {
    // 열려 있는 모달이 있으면 실제 close() 경로(백드롭 자체 클릭)로 닫아
    // document의 capture keydown 리스너가 이 테스트 파일 안에서도 누적되지
    //않게 한다 — modal.ts가 이미 공개하는 동작(backdrop mousedown)을 그대로
    //쓴다, 테스트 전용 API를 새로 만들지 않는다.
    const backdrop = document.querySelector<HTMLElement>(".settings-backdrop");
    if (backdrop && !backdrop.hidden) {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
    document.body.innerHTML = "";
    themeJsonSetting.set(builtInTheme("light"));
  });

  function openModalWithThemePane(): HTMLElement {
    const host = document.createElement("div");
    host.className = "editor-host";
    const bar = document.createElement("div");
    document.body.append(host, bar);
    bar.append(createSettingsButton());
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    return document.querySelector(".settings-backdrop") as HTMLElement;
  }

  it("카드가 열려 있을 때 Escape → 카드만 닫히고 모달은 그대로 남는다", () => {
    const backdrop = openModalWithThemePane();
    const bold = backdrop.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(backdrop.querySelector<HTMLElement>(".theme-inspector")!.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(backdrop.hidden).toBe(false); // 모달은 그대로
    expect(bold.getAttribute("aria-pressed")).toBe("false"); // 선택만 해제
    expect(backdrop.querySelector<HTMLElement>(".theme-inspector")!.hidden).toBe(true);
  });

  it("카드가 닫혀 있을 때(선택 없음) Escape → 모달이 닫힌다 (기존 동작 유지)", () => {
    const backdrop = openModalWithThemePane();
    expect(backdrop.querySelector<HTMLElement>(".theme-inspector")!.hidden).toBe(true); // 아무것도 선택 안 됨

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(backdrop.hidden).toBe(true);
  });

  it("포커스가 카드 안(색상 칩)에 있어도 같은 규칙이다 — Escape 한 번은 카드만 닫는다", () => {
    const backdrop = openModalWithThemePane();
    const bold = backdrop.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();
    const chip = backdrop.querySelector<HTMLElement>(".theme-inspector-palette .theme-chip")!;
    chip.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(backdrop.hidden).toBe(false);
    expect(bold.getAttribute("aria-pressed")).toBe("false");
  });

  it("두 번 연속 Escape — 1차는 선택만 해제, 2차는 모달을 닫는다", () => {
    const backdrop = openModalWithThemePane();
    const bold = backdrop.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop.hidden).toBe(true);
  });

  it("재클릭 토글(직전 지시)과 함께 동작한다 — 토글로 닫힌 뒤 Escape는 곧바로 모달을 닫는다", () => {
    const backdrop = openModalWithThemePane();
    const bold = backdrop.querySelector<HTMLElement>('[data-target="bold"]')!;
    bold.click(); // 선택
    bold.click(); // 재클릭 토글 — 선택 해제
    expect(bold.getAttribute("aria-pressed")).toBe("false");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop.hidden).toBe(true); // 이미 선택이 없으니 바로 모달 닫힘
  });
});
