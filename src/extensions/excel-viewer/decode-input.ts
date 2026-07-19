// csv 파일은 "바이트 = 텍스트"(SheetJS에 문자열로 넘겨야 정확히 파싱되는
// 포맷)이고, xlsx/xls는 "바이트 = 바이너리"(zip/OLE 컨테이너, SheetJS에 바이트
// 그대로 넘겨야 하는 포맷)다 — 이 둘을 가르는 단 하나의 규칙이 이 파일의 전부.
//
// 실제로 재현된 버그: BOM 없는 UTF-8 CSV(`정산표.csv`, "카테고리" 헤더)를
// `XLSX.read(new Uint8Array(bytes), { type: "array" })`로 열면 SheetJS가
// 바이트 배열을 latin1로 읽어 "ì¹´í…Œê³ ë¦¬"로 깨졌다. 바이트를 먼저 문자열로
// 디코드해 `{ type: "string" }`으로 넘기면 정상 렌더된다 — 그 문자열 디코드가
// 이 파일의 두 함수다. (xlsx/xls는 바이너리이므로 이 문제 자체가 없다 —
// `{ type: "array" }`로 바이트 그대로 넘기는 게 옳고, 지금도 그렇다.)

/** 이 경로의 확장자가 "텍스트 스프레드시트"(csv)인가 — SheetJS에 문자열로
 *  넘길지 바이트 그대로 넘길지를 가르는 단 하나의 규칙. 순수 질의. */
export function isTextSpreadsheet(absPath: string): boolean {
  return /\.csv$/i.test(absPath);
}

/** 텍스트 스프레드시트(csv)의 바이트를 문자열로 디코드한다: 엄격 UTF-8을
 *  먼저 시도하고(`fatal: true` — 잘못된 바이트열이면 throw해 폴백을 유도),
 *  실패하면 CP949(EUC-KR)로 재시도한다. UTF-8 디코더는 기본 `ignoreBOM:
 *  false`라 선두 BOM을 스스로 삼키므로 여기서 BOM을 따로 잘라내지 않는다.
 *  바이너리 포맷(xlsx/xls)은 `isTextSpreadsheet`가 false를 돌려주므로 바이트를
 *  그대로(Uint8Array로) 통과시킨다 — 현행 동작 유지. */
export function decodeSpreadsheetInput(
  absPath: string,
  bytes: ArrayBuffer | Uint8Array,
): Uint8Array | string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isTextSpreadsheet(absPath)) return u8;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8);
  } catch {
    return new TextDecoder("euc-kr").decode(u8);
  }
}
