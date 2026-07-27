// Generates the docx-viewer golden's POSITIVE fixture (01_architect_plan.md
// Stage 8): mock-assets/mock/vault/sample.docx. A hand-built, MINIMAL but
// VALID OOXML package (not fake bytes — docx-preview/JSZip must actually
// open this) — 2 identifying paragraphs of Korean text + 60 filler
// paragraphs (qa-verifier addition — tall enough that the rendered document
// reliably exceeds the viewer pane's viewport height, so G-docx-4 can prove
// a REAL scroll: scrollHeight > clientHeight AND a scrollTop write actually
// moves) + a 1-row table, exercising docx-preview's paragraph + table
// rendering paths (G-docx-2's assertions).
//
// Built directly with `jszip` (a transitive dependency of `docx-preview`,
// already present in node_modules — no new devDependency needed just to
// author a fixture) rather than a docx-authoring library: the OOXML markup
// below is the smallest set of parts Word/docx-preview both accept
// ([Content_Types].xml + _rels/.rels + word/document.xml), hand-written so
// this script has zero third-party OOXML-generation dependency of its own.
//
// Run once (or whenever the fixture needs regenerating):
//
//   node scripts/lib/make-docx-fixture.mjs
//
// This script itself only runs at fixture-authoring time; it is never
// imported by app code or tests.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const OUT = fileURLToPath(new URL("../../mock-assets/mock/vault/sample.docx", import.meta.url));

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// One heading-ish paragraph, one body paragraph (Korean text — the golden
// asserts a Korean text node is actually present, G-docx-2), a run of FILLER
// paragraphs (qa-verifier addition, team-lead's re-scroll-check follow-up to
// the 3계층→2계층 scroll-contract blocker: a 1-2 paragraph fixture never
// exceeds the pane's viewport height, so the golden could never PROVE the
// pane actually scrolls — only that it doesn't visibly spill, which the
// contract's whole point is more than that), and a 1x2 table (docx-preview's
// table-rendering path, exercised the same way the golden checks
// `section.docx` page + table markup).
const FILLER_PARAGRAPH_COUNT = 60;
const fillerParagraphs = Array.from(
  { length: FILLER_PARAGRAPH_COUNT },
  (_, i) =>
    `    <w:p><w:r><w:t>스크롤 검증용 채움 문단 ${i + 1} — 이 문단은 docx-viewer의 세로 스크롤 계약(scrollHeight > clientHeight, 실제 scrollTop 이동)을 실브라우저 골든에서 확인하기 위한 필러 텍스트입니다.</w:t></w:r></w:p>`,
).join("\n");

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr><w:b/></w:rPr>
        <w:t>mermark docx 뷰어 픽스처</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>이 문단은 docx-preview 렌더링을 확인하기 위한 한글 본문입니다.</w:t>
      </w:r>
    </w:p>
${fillerParagraphs}
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>
          <w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
          <w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tr>
        <w:tc>
          <w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>
          <w:p><w:r><w:t>항목</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>
          <w:p><w:r><w:t>값</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
      <w:tr>
        <w:tc>
          <w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>
          <w:p><w:r><w:t>버전</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>
          <w:p><w:r><w:t>0.9.10</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
    <w:p/>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const zip = new JSZip();
zip.file("[Content_Types].xml", CONTENT_TYPES);
zip.folder("_rels").file(".rels", ROOT_RELS);
zip.folder("word").file("document.xml", DOCUMENT_XML);

mkdirSync(dirname(OUT), { recursive: true });
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
writeFileSync(OUT, buf);
console.log("wrote", OUT, `(${buf.length} bytes)`);
