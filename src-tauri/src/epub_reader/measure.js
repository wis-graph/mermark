// Reader runtime injected into every EPUB chapter response by
// `epubview::inject_reader_runtime` (see `_workspace/01_architect_design_epub.md`
// §3 "높이 동기화"). This is the *only* code that runs inside a chapter
// iframe — everything else the book itself carries (inline scripts, `on*`
// handlers, `<script src>`) is killed by the per-token CSP's `script-src`,
// which names exactly this file's URL and nothing else.
//
// Contract with the parent (`src/chrome/viewer/epub-viewer.ts`):
//   parent.postMessage({ type: "mermark-epub-size", height, anchors }, "*")
// where `height` is the document's current scroll height and `anchors` is a
// map of every `id`-bearing element's `offsetTop`, used for TOC fragment
// jumps. The parent verifies `event.origin`/`event.source` itself — this
// script does not (and cannot meaningfully) authenticate the parent, it only
// reports its own measurements.
(function () {
  function collectAnchors() {
    var anchors = {};
    var nodes = document.querySelectorAll("[id]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      anchors[el.id] = el.offsetTop;
    }
    return anchors;
  }

  function report() {
    var height = document.documentElement.scrollHeight;
    parent.postMessage(
      { type: "mermark-epub-size", height: height, anchors: collectAnchors() },
      "*"
    );
  }

  if (typeof ResizeObserver === "function") {
    var observer = new ResizeObserver(report);
    observer.observe(document.documentElement);
  } else {
    // No ResizeObserver: report once after load and once more after a short
    // delay for late image decode — best-effort, not a hard guarantee.
    window.addEventListener("load", report);
    setTimeout(report, 300);
  }

  if (document.readyState === "complete") {
    report();
  } else {
    window.addEventListener("load", report);
  }
})();
