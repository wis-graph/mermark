import { describe, it, expect } from "vitest";
import { parseChangelogGroups, parseChangelogSections } from "../src/settings/panel/changelog";

const SAMPLE = `# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.

## [0.5.4] - 2026-07-11

### Added

- **이미지 뷰어**: 탐색기에서 이미지 파일을 클릭하면 뷰어로 열린다.
- **코드 블록 복사 버튼**: 복사 버튼이 나타난다.

### Fixed

- **버튼 무반응 문제**: 고쳤다.

### Changed

- **아이콘**: 바뀌었다.

---

## [0.5.3] - 2026-07-10

### Changed

- **경로 표시줄 정돈**: 정렬된다.

---

## [0.5.2] - 2026-07-09

### Changed

- **레일**: 바뀌었다.

---

## [0.5.1] - 2026-07-08

### Fixed

- **드래그 선택**: 고쳤다.
`;

describe("parseChangelogSections", () => {
  it("parses the newest N sections in document order with version/date/groups", () => {
    const sections = parseChangelogSections(SAMPLE, 3);
    expect(sections).toHaveLength(3);
    expect(sections[0].version).toBe("0.5.4");
    expect(sections[0].date).toBe("2026-07-11");
    expect(sections[0].groups.map((g) => g.category)).toEqual(["추가", "수정", "변경"]);
    expect(sections[0].groups[0].items).toEqual([
      "**이미지 뷰어**: 탐색기에서 이미지 파일을 클릭하면 뷰어로 열린다.",
      "**코드 블록 복사 버튼**: 복사 버튼이 나타난다.",
    ]);
    expect(sections[1].version).toBe("0.5.3");
    expect(sections[2].version).toBe("0.5.2");
  });

  it("returns an empty array for input with no version headings", () => {
    expect(parseChangelogSections("just some prose, no headings here", 3)).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseChangelogSections("", 5)).toEqual([]);
  });

  it("treats a heading with no trailing date as date: null", () => {
    const sections = parseChangelogSections("## [1.0.0]\n\n### Added\n\n- 첫 배포\n", 1);
    expect(sections).toHaveLength(1);
    expect(sections[0].version).toBe("1.0.0");
    expect(sections[0].date).toBeNull();
  });

  it("caps at `limit` even when more sections exist", () => {
    expect(parseChangelogSections(SAMPLE, 1)).toHaveLength(1);
    expect(parseChangelogSections(SAMPLE, 100)).toHaveLength(4);
  });
});

describe("parseChangelogGroups", () => {
  it("keeps bullets that appear before any ### heading as an unlabeled group", () => {
    const groups = parseChangelogGroups("- 카테고리 없는 항목\n\n### Added\n\n- 있는 항목\n");
    expect(groups).toHaveLength(2);
    expect(groups[0].category).toBe("");
    expect(groups[0].items).toEqual(["카테고리 없는 항목"]);
    expect(groups[1].category).toBe("추가");
    expect(groups[1].items).toEqual(["있는 항목"]);
  });

  it("maps unrecognized category headings through verbatim", () => {
    const groups = parseChangelogGroups("### Notes\n\n- 뭔가\n");
    expect(groups[0].category).toBe("Notes");
  });

  it("returns an empty array for a blank body", () => {
    expect(parseChangelogGroups("\n\n---\n\n")).toEqual([]);
  });

  it("ignores a stray '## [version]' line at the top of an update.body-style input", () => {
    const groups = parseChangelogGroups("## [0.6.0] - 2026-08-01\n\n### Added\n\n- 새 기능\n");
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("추가");
    expect(groups[0].items).toEqual(["새 기능"]);
  });
});
