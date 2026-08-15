// native — the ONLY genuinely native harness for single-window-opening
// Todo 6. Unlike scripts/workspace-smoke.mjs (browser-mode + mock invoke)
// and scripts/workspace-native-smoke.mjs (despite its name: Playwright +
// Chromium + mock invoke — see its own JSON's `mode` field), this script
// launches the REAL debug `mermark` binary, drives its REAL WKWebView
// windows (no CDP — WKWebView has none; there is no Chromium here at all),
// and speaks REAL Tauri IPC. Delivery is observed through the backend's
// debug-only qa_trace seam (src-tauri/src/qa_trace.rs) — pid-scoped JSONL
// files — cross-referenced against `src/qa/native-smoke-driver.ts`, a
// dev-only bridge module gated by `import.meta.env.DEV &&
// import.meta.env.VITE_QA_BRIDGE` that never ships in `npm run build`
// output (verified separately — see _workspace/02_frontend_todo6_changes.md).
//
// This harness proves multi-window CLI routing, isolated-launch
// non-interception, and vault attachment end-to-end against a real OS
// process and a real singleton socket. It runs against a QA-only Tauri
// `identifier` (com.mermark.qa), which resolves to its OWN singleton socket
// (/tmp/com_mermark_qa_si.sock) — structurally isolated from a developer's
// real running mermark (com.mermark.app / /tmp/com_mermark_app_si.sock).
// This harness launches real GUI windows and requires a real macOS session
// (not CI-headless).
//
// ## What this harness does NOT cover
// Read this before treating a green run as "multi-window routing is verified".
// Each gap is a deliberate decision with a compensating layer, not an oversight.
//
//  1. Focus-flip scenarios (make window B most-recent, then assert delivery).
//     Driving focus from JS needs `core:window:allow-set-focus` in
//     capabilities/default.json — a permanent production IPC grant for a
//     test-only need, and production never focuses from JS (it focuses
//     natively via RoutingAction::Focus). That was rejected. The one
//     substitute available under existing permissions, minimizeSelf, was
//     measured rather than assumed: it does not reliably fire
//     WindowEvent::Focused(true) for the window regaining focus, AND a
//     minimized WKWebView permanently stops answering the QA bridge, so it
//     destroys the very channel this harness observes through.
//     Compensated by: cargo unit tests over resolve_recipient / focus
//     recency. What stays unproven is one layer — whether the OS focus event
//     reaches logic those units already lock.
//  2. Packaged custom-scheme + CSP behaviour. This runs a debug binary, which
//     loads devUrl with devCsp null. The real app serves from a custom scheme
//     under a real CSP, and this repo has previously shipped a bug visible
//     ONLY in a `tauri build` bundle (golden + `tauri dev` are http origins
//     and missed it). Nothing here can stand in for that.
//     Compensated by: nothing. Verify against a real bundle before release.
//  3. SpawnMain (recreating `main` with zero live windows). Closing the last
//     window exits the process, so this is not dead code but a defence for
//     the narrow race between Destroyed and exit — unreachable from a driver.
//     Compensated by: cargo units no_live_window_spawns_main_once,
//     dead_focus_and_dead_main_recreates_main.
//  4. The native NSOpenPanel itself, and forcing a CodeMirror insertion
//     failure in a real webview. MERMARK_QA_PICK_FILE substitutes for the
//     panel (replacing exactly one dialog call, leaving the rest of the
//     import real); insertion-failure rollback orchestration lives in
//     tests/attach-image.test.ts.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { startQaDriverBridge } from "./qa-driver-bridge.mjs";

const REPO_ROOT = resolve(".");
const SRC_TAURI = join(REPO_ROOT, "src-tauri");
const QA_IDENTIFIER = "com.mermark.qa";
const QA_SOCKET_PATH = "/tmp/com_mermark_qa_si.sock";
const QA_TARGET_DIR = join(SRC_TAURI, "target", "qa");
const QA_BINARY = join(QA_TARGET_DIR, "debug", "mermark");
const VITE_PORT = 1420;
const WATCHDOG_MS = 240_000;

const evidenceDir = resolve(process.env.WORKSPACE_SMOKE_EVIDENCE ?? ".omo/evidence/single-window-opening/task-6");
const forceFailure = process.env.WINDOW_ROUTING_SMOKE_FORCE_FAILURE === "1";
const checks = [];
const outOfScope = [
  { item: "네이티브 NSOpenPanel 조작(실제 선택/취소 클릭)", why: "OS 모달, 스크립팅 seam 없음", coveredBy: "MERMARK_QA_PICK_FILE debug 우회(다이얼로그 1콜만 대체) + 취소 의미론은 이 하네스의 S10 + 기존 vitest" },
  { item: "SpawnMain(살아있는 창 0에서 main 재생성) 네이티브 재현", why: "마지막 창 닫힘 = 앱 종료 — 그 상태가 프로덕션에 도달 불가한 것이 아니라, Destroyed와 프로세스 종료 사이의 좁은 레이스 구간에서만 도달하는 레이스 방어 코드(오케스트레이터 판정)", coveredBy: "cargo 유닛 no_live_window_spawns_main_once / dead_focus_and_dead_main_recreates_main" },
  { item: "패키지드 커스텀 스킴/CSP 하의 동작", why: "debug 바이너리는 devUrl + devCsp:null로 돈다 — 실앱과 다른 조건. 이 리포의 알려진 테스트 사각지대(과거 WKWebView 커스텀 스킴 전용 버그가 golden/tauri dev로는 안 잡히고 tauri build 번들에서만 드러난 전례)", coveredBy: "이 하네스는 이 증명을 하지 않는다 — 릴리스 전 실제 tauri build 번들 확인은 Todo 7/릴리스 프로세스 소관" },
  { item: "삽입-실패 유발 롤백의 프론트 자동 경로", why: "실 WKWebView에서 CodeMirror dispatch 실패를 강제할 훅이 없다(프로덕션 표면 증가 없이는 불가)", coveredBy: "롤백 커맨드 자체(rollback_attachment_import)는 이 하네스의 S11이 네이티브로 검증, 프론트 오케스트레이션은 기존 tests/attach-image.test.ts" },
];

function check(id, condition, observable) {
  const passed = Boolean(condition);
  checks.push({ id, passed, observable });
  console.log(`${passed ? "PASS" : "FAIL"} ${id}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-qa-smoke-"));
const routingRoot = join(fixtureRoot, "routing");
const vaultRoot = join(fixtureRoot, "vault");
const traceDir = join(fixtureRoot, "trace");
await mkdir(routingRoot, { recursive: true });
await mkdir(vaultRoot, { recursive: true });
await mkdir(traceDir, { recursive: true });
await mkdir(evidenceDir, { recursive: true });

const fixtureDoc = (name) => join(routingRoot, name);
async function writeMarker(path, name) {
  await writeFile(path, `# fixture-marker: ${name}\n\ncontent for ${name}\n`, "utf8");
}
for (const name of ["fixture-a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "j.md", "k.md"]) {
  await writeMarker(fixtureDoc(name), name);
}
const iPath = fixtureDoc("i.md");
await writeMarker(iPath, "i.md");
await chmod(iPath, 0o000);

// 1x1 transparent PNG.
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const picPath = join(fixtureRoot, "pic.png");
await writeFile(picPath, onePixelPng);
const vaultNotePath = join(vaultRoot, "note.md");
await writeMarker(vaultNotePath, "note.md");

// ── Process registry + cleanup ──────────────────────────────────────────
const registry = new Map(); // pid -> { proc, name }
function registerChild(name, proc) {
  registry.set(proc.pid, { proc, name });
  proc.on("exit", () => registry.delete(proc.pid));
  return proc;
}

async function killAllChildren() {
  for (const [pid, { proc }] of registry) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && [...registry.keys()].some(isAlive)) await sleep(100);
  for (const [pid, { proc }] of registry) {
    if (isAlive(pid)) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }
}

let vite;
let bridge;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await killAllChildren();
  await vite?.close().catch(() => {});
  await bridge?.close().catch(() => {});
  await chmod(iPath, 0o644).catch(() => {});
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  await rm(QA_SOCKET_PATH, { force: true }).catch(() => {});
}

let watchdogTimer;
function armWatchdog() {
  watchdogTimer = setTimeout(async () => {
    console.error(`window-routing-smoke: watchdog fired after ${WATCHDOG_MS}ms — forcing cleanup`);
    await cleanup();
    process.exit(1);
  }, WATCHDOG_MS);
  watchdogTimer.unref?.();
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

// ── Named domain helpers (design's "명명할 도메인 함수") ──────────────────

/** Port 1420 must be free (it's baked into the debug binary's devUrl at
 *  compile time — see design fact 1 — so nothing here can move it) and any
 *  QA singleton socket left behind by a prior crashed run must be gone
 *  before this run starts, or its first launch would believe a primary is
 *  already up. */
async function preflightGuard() {
  const busy = await new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(true));
    probe.once("listening", () => probe.close(() => resolvePort(false)));
    probe.listen(VITE_PORT, "127.0.0.1");
  });
  if (busy) {
    throw new Error(
      `preflightGuard: port ${VITE_PORT} is already in use — stop \`npm run dev\` / a prior harness run first`,
    );
  }
  await rm(QA_SOCKET_PATH, { force: true });
}

/** Build the QA-identifier debug binary into an isolated --target-dir (so
 *  this never touches a developer's normal `target/debug` build cache).
 *  `TAURI_CONFIG` is a BUILD-time merge (tauri-build's json_patch::merge —
 *  design fact 2), baked into the binary via `generate_context!()`; it has
 *  no effect at runtime, so it's set here and nowhere else. */
async function buildQaBinary() {
  await new Promise((resolveBuild, rejectBuild) => {
    const proc = spawn("cargo", ["build", "--target-dir", "target/qa"], {
      cwd: SRC_TAURI,
      env: { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: QA_IDENTIFIER }) },
      stdio: "inherit",
    });
    proc.on("exit", (code) => (code === 0 ? resolveBuild() : rejectBuild(new Error(`cargo build (qa) exited ${code}`))));
    proc.on("error", rejectBuild);
  });
  if (!existsSync(QA_BINARY)) throw new Error(`buildQaBinary: expected binary missing at ${QA_BINARY}`);
  return QA_BINARY;
}

function spawnQa(name, args, extraEnv = {}) {
  const proc = spawn(QA_BINARY, args, {
    env: { ...process.env, MERMARK_QA_TRACE_DIR: traceDir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  registerChild(name, proc);
  const stdout = [];
  const stderr = [];
  proc.stdout.on("data", (d) => stdout.push(d));
  proc.stderr.on("data", (d) => stderr.push(d));
  proc.qaOutput = () => ({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  return proc;
}

async function waitForPath(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() > deadline) throw new Error(`waitForPath: ${path} did not appear within ${timeoutMs}ms`);
    await sleep(80);
  }
}

/** Launch the primary/first QA process (optionally opening `fileArg`) and
 *  wait for the singleton socket to appear — Rust-side singleton install
 *  happens before `tauri::Builder` even creates a window, well before any
 *  frontend JS runs, which is exactly what makes "pre-ready but Rust-ready"
 *  (S4) a real, not simulated, state. */
async function launchPrimary(fileArg, extraEnv = {}) {
  const proc = spawnQa("primary", fileArg ? [fileArg] : [], extraEnv);
  await waitForPath(QA_SOCKET_PATH, 8000);
  return proc;
}

/** Launch a second `mermark <file>` invocation and wait for it to exit —
 *  a successfully-routed secondary process notifies the primary and calls
 *  `process::exit(0)` inside the plugin's own setup (crate fact 1), so it
 *  never reaches a window of its own. */
async function launchCliOpen(fileArg, extraArgs = [], extraEnv = {}) {
  const proc = spawnQa("cli-open", [fileArg, ...extraArgs], extraEnv);
  const pid = proc.pid;
  const exitCode = await new Promise((resolveExit) => proc.on("exit", (code) => resolveExit(code)));
  return { pid, exitCode, output: proc.qaOutput() };
}

/** Launch an isolated process that must NOT be intercepted by the running
 *  singleton (`--right`, piped stdin). Long-lived — caller SIGTERMs it via
 *  the process registry during cleanup or its own scenario teardown. */
function launchIsolated(name, args) {
  return spawnQa(name, args);
}

async function readTraceLines(pid) {
  try {
    const raw = await readFile(join(traceDir, `${pid}.jsonl`), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Every scenario after the first shares the SAME primary pid's trace file
// (S4 through S8 all run against one L1 process), so a naive "first line
// matching the predicate" search would happily match a STALE line from an
// earlier scenario (e.g. S1 waiting for "ack, outcome=opened" could match
// S4's g.md ack instead of its own c.md one). `traceCursor` is a per-pid
// high-water mark: every match advances it, and every search only looks at
// lines strictly after it — so scenarios read the trace as a moving window,
// never re-matching something an earlier scenario already consumed.
const traceCursor = new Map(); // pid -> last consumed seq

/** Advance `pid`'s cursor to its current tail without requiring a specific
 *  event match — used after a scenario inspects trace lines by hand (S3's
 *  FIFO-order scan) so a LATER awaitTraceEvent call doesn't re-scan into
 *  territory that scenario already accounted for. */
async function markTraceConsumed(pid) {
  const lines = await readTraceLines(pid);
  const tail = lines.at(-1)?.seq;
  if (tail !== undefined) traceCursor.set(pid, Math.max(traceCursor.get(pid) ?? 0, tail));
}

/** Poll `pid`'s trace file for the first NOT-YET-CONSUMED line (see
 *  `traceCursor` above) matching `event` + `predicate(fields)`, and consume
 *  up to it. Decisiveness over sleeps (design's own rule): a timeout always
 *  dumps the last lines actually observed, never a bare "timed out". */
async function awaitTraceEvent(pid, event, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const floor = traceCursor.get(pid) ?? 0;
  let lines = [];
  for (;;) {
    lines = await readTraceLines(pid);
    const hit = lines.find((l) => l.seq > floor && l.event === event && predicate(l.fields ?? {}));
    if (hit) {
      traceCursor.set(pid, Math.max(traceCursor.get(pid) ?? 0, hit.seq));
      return hit;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `awaitTraceEvent: pid ${pid} never emitted "${event}" matching the predicate (after seq ${floor}) within ${timeoutMs}ms.\nRecent lines:\n${lines
          .slice(-12)
          .map((l) => JSON.stringify(l))
          .join("\n")}`,
      );
    }
    await sleep(80);
  }
}

/** Send a bridge command to `label`'s driver, waiting for it to be
 *  registered first (a fresh window's driver needs a moment to boot). */
async function drive(label, name, args = {}, timeoutMs) {
  await bridge.waitForLabel(label);
  return bridge.send(label, name, args, timeoutMs);
}

/** The driver registers with the bridge as the FIRST statement of boot()
 *  (native-smoke-driver.ts's gate), well before the rest of boot() finishes
 *  reading/mounting the document — so `bridge.waitForLabel(label)` resolving
 *  does NOT mean a document is open yet, only that the JS realm exists. A
 *  command issued immediately after openPath (e.g. `runAction("image.attach")`,
 *  which needs `view !== null`) can race a still-loading window and silently
 *  no-op (attachImageToVault's `view === null` early return — no invoke, no
 *  trace, no error: exactly the timeout this harness saw before this helper
 *  existed). Poll `queryDoc` until `marker` appears in the mounted text
 *  before proceeding. */
async function awaitDocLoaded(label, marker, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let doc;
  for (;;) {
    doc = await drive(label, "queryDoc", {});
    if (doc.textHead.includes(marker)) return doc;
    if (Date.now() > deadline) {
      throw new Error(`awaitDocLoaded: "${label}" never showed "${marker}" within ${timeoutMs}ms (last textHead: ${JSON.stringify(doc.textHead)})`);
    }
    await sleep(150);
  }
}

/** `seedVault` reloads the page mid-command — its /result ack races the
 *  navigation and is unreliable by design (see
 *  _workspace/02_frontend_todo6_changes.md). Wait for a NEW /register event
 *  for `label` instead of the command's own result. */
async function seedVaultAndWaitReload(label, rootPath, timeoutMs = 10000) {
  const before = bridge.events.filter((e) => e.type === "register" && e.label === label).length;
  await drive(label, "seedVault", { rootPath }, 3000).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = bridge.events.filter((e) => e.type === "register" && e.label === label).length;
    if (after > before) return;
    if (Date.now() > deadline) throw new Error(`seedVaultAndWaitReload: "${label}" never re-registered after reload within ${timeoutMs}ms`);
    await sleep(80);
  }
}

// ── Vite hold middleware (S4: deterministic pre-ready window) ──────────
const holdState = { holding: false, parked: [] };
function releaseHold() {
  holdState.holding = false;
  const parked = holdState.parked.splice(0, holdState.parked.length);
  for (const release of parked) release();
}
function qaHoldPlugin() {
  return {
    name: "qa-hold-main-ts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!holdState.holding || !req.url || !req.url.startsWith("/src/main.ts")) return next();
        holdState.parked.push(() => next());
      });
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────
armWatchdog();
try {
  await preflightGuard();
  check("preflight.socket-absent-before-run", !existsSync(QA_SOCKET_PATH), { QA_SOCKET_PATH });

  await buildQaBinary();

  bridge = await startQaDriverBridge({ token: (await import("node:crypto")).randomBytes(18).toString("hex") });
  process.env.VITE_QA_BRIDGE = `${bridge.url}#${bridge.token}`;
  vite = await createViteServer({
    plugins: [qaHoldPlugin()],
    server: { host: "127.0.0.1", port: VITE_PORT, strictPort: true },
  });
  await vite.listen();

  // ── S4: pre-ready request preservation (L1's very first launch) ───────
  holdState.holding = true;
  const primary = await launchPrimary(fixtureDoc("fixture-a.md"));
  check("primary.socket-exists-after-launch", existsSync(QA_SOCKET_PATH), { QA_SOCKET_PATH });

  const g = await launchCliOpen(fixtureDoc("g.md"));
  check("s4.secondary-exit-0", g.exitCode === 0, g);
  await awaitTraceEvent(g.pid, "launch-class", (f) => f.class === "singleton-routed");
  const enqueueLine = await awaitTraceEvent(primary.pid, "routing", (f) => f.trigger === "enqueue");
  const mainQueueAtEnqueue = enqueueLine.fields.snapshot?.queues?.main ?? [];
  check(
    "s4.pre-ready-queued-not-delivered",
    mainQueueAtEnqueue.some((item) => item.path.endsWith("g.md") && item.delivered === false) &&
      !(enqueueLine.fields.actions ?? []).some((a) => a.startsWith("Deliver")),
    enqueueLine.fields,
  );

  releaseHold();
  const readyLine = await awaitTraceEvent(primary.pid, "routing", (f) => f.trigger === "ready");
  check("s4.ready-delivers-queued-request", (readyLine.fields.actions ?? []).some((a) => a.startsWith("Deliver") && a.includes("main")), readyLine.fields);
  const ackLine = await awaitTraceEvent(primary.pid, "routing", (f) => f.trigger === "ack" && f.outcome === "opened");
  check("s4.ack-outcome-opened", ackLine.fields.outcome === "opened", ackLine.fields);
  const mainDocAfterG = await drive("main", "queryDoc", {});
  check("s4.main-shows-g", mainDocAfterG.textHead.includes("g.md"), mainDocAfterG);

  // ── S1: two windows, last-focused-only delivery (+ negative assertion) ──
  // Needs no focus-flip TRIGGER at all — w1 gets OS focus for free just by
  // being created (natural creation focus), which is what S1 tests. Runs
  // unconditionally, in its own try/catch so a failure here can't mask the
  // S2/S3/S5 declaration below (or vice versa).
  try {
    await drive("main", "openPath", { path: fixtureDoc("b.md") });
    await bridge.waitForLabel("w1");
    await awaitTraceEvent(primary.pid, "window-focused", (f) => f.label === "w1"); // natural: new window takes OS focus on creation

    const c = await launchCliOpen(fixtureDoc("c.md"));
    check("s1.secondary-exit-0", c.exitCode === 0, c);
    const s1Enqueue = await awaitTraceEvent(primary.pid, "routing", (f) => f.trigger === "enqueue" && (f.snapshot?.queues?.w1 ?? []).some((i) => i.path.endsWith("c.md")));
    check("s1.queued-only-in-w1", !(s1Enqueue.fields.snapshot?.queues?.main ?? []).some((i) => i.path.endsWith("c.md")), s1Enqueue.fields);
    // The original assertion here raced: it grabbed the enqueue snapshot
    // (assumed to never carry Deliver — true for S4's deliberately-held
    // "main", but NOT guaranteed for w1 here, since nothing holds w1's
    // readiness back) and the FIRST subsequent ack&&opened line, hoping the
    // Deliver action would show up on one of the two. Whether it does
    // depends on a genuine timing race in the app itself: if w1 is already
    // "ready" by the time c.md is routed, `Deliver{label:"w1"}` is bundled
    // onto the SAME "enqueue" trigger line; if not, it lands on a LATER,
    // separate "ready" trigger line (same shape as S4/S2). A naive
    // "await a second, later trace line" (as a prior version of this fix
    // did) breaks the bundled case: `s1Enqueue`'s own match already
    // consumes/advances the cursor past that line, so a second search for
    // the same line's Deliver action finds nothing and times out. Handle
    // both shapes: reuse s1Enqueue directly when it already carries the
    // Deliver action, only poll forward when it doesn't.
    const s1Deliver = (s1Enqueue.fields.actions ?? []).some((a) => a.startsWith("Deliver") && a.includes("w1"))
      ? s1Enqueue
      : await awaitTraceEvent(primary.pid, "routing", (f) => (f.actions ?? []).some((a) => a.startsWith("Deliver") && a.includes("w1")));
    check("s1.deliver-only-w1", true, { enqueue: s1Enqueue.fields, deliver: s1Deliver.fields });
    await awaitTraceEvent(primary.pid, "routing", (f) => f.trigger === "ack" && f.outcome === "opened");
    const negNoMainDeliver = !(s1Deliver.fields.actions ?? []).some((a) => a.startsWith("Deliver") && a.includes("main"));
    const w1Doc = await drive("w1", "queryDoc", {});
    const mainDocStillG = await drive("main", "queryDoc", {});
    check("s1.negative-no-delivery-to-main", negNoMainDeliver && !mainDocStillG.textHead.includes("c.md") && mainDocStillG.textHead.includes("g.md"), { mainDocStillG });
    check("s1.w1-received-c", w1Doc.textHead.includes("c.md"), w1Doc);
  } catch (s1Error) {
    check("s1.uncaught", false, { message: s1Error instanceof Error ? s1Error.message : String(s1Error) });
  }

  // ── S2/S3/S5: focus-flip-BACK-to-main scenarios — NOT attempted ────────
  // Orchestrator ruling (single-window-opening Todo 6 adjudication,
  // 2026-08-15): adding `core:window:allow-set-focus` was REJECTED (real,
  // non-dev-gated release IPC-surface increase; production never needs
  // JS-side setFocus). A prior run of this harness substituted
  // `minimizeSelf` (already-granted `core:window:allow-minimize`) as a
  // workaround, on the theory that minimizing w1 would hand OS focus back
  // to main. That was ATTEMPTED and MEASURED, not assumed, and both halves
  // of the theory failed:
  //   1. Minimizing w1 did not reliably fire `WindowEvent::Focused(true)`
  //      for main within any reasonable timeout — macOS does not treat
  //      "front window minimized" the same as "next window gains key
  //      focus" for an app whose Space isn't already frontmost.
  //   2. Worse: once minimized, w1's WKWebView stops answering the qa
  //      bridge's long-poll entirely (a minimized WKWebView is
  //      power-throttled and its JS realm stops making outbound
  //      fetch()es) — so the harness's OWN observation channel for that
  //      window goes dark. A later `drive("w1", "closeSelf")` (e.g. in a
  //      catch-block cleanup) then hangs waiting for a /result that can
  //      never arrive, w1 never actually closes, and because w1 stays
  //      open the whole primary process never exits at L1 teardown
  //      (`l1.primary-exited` fails) — which in turn left a stale/zombie
  //      L1 process alive when L2 launched for S9, corrupting later
  //      scenarios too (`harness.uncaught`).
  // Given both the intended mechanism (setFocus) and the substitute
  // (minimize) are unusable — one by policy, one by measurement — there is
  // no non-destructive way to automate a focus-flip-back-to-main from this
  // harness. Do NOT retry minimize; declare these not-automated up front
  // instead of attempting something already known to corrupt the run.
  check("s2-s3-s5.intentionally-not-automated", false, {
    reason:
      "core:window:allow-set-focus rejected by the orchestrator (adjudication 2026-08-15). The only available substitute, minimizeSelf, was attempted in a prior run of this harness and measured to (a) not reliably fire WindowEvent::Focused(true) for the window regaining focus, and (b) permanently stop a minimized WKWebView from answering the qa bridge's long-poll — which cascades into l1.primary-exited and harness.uncaught for every scenario after it in the same run. Not retried this run. The routing decision logic itself remains locked by cargo unit tests (resolve_recipient_never_picks_arbitrary_w / focused_label_moves_to_front / focus_only_follows_recency_not_main) — S1 above already proves the natural-creation-focus half of that logic end-to-end natively; only the flip-BACK-to-main direction is unautomated.",
  });
  outOfScope.push({
    item: "S2/S3/S5 (minimize 기반 포커스 플립 재라우팅 시나리오)",
    why: "core:window:allow-set-focus 미부여(오케스트레이터 판정) + 대체 트리거(minimizeSelf)를 실측한 결과 (1) WindowEvent::Focused(true) 미발화, (2) 최소화된 WKWebView가 브리지 롱폴 응답을 영구 중단 → w1이 안 닫혀 L1 프로세스가 안 죽고, 이후 L2 시나리오까지 연쇄로 깨짐(harness.uncaught) — 재시도하지 않음",
    coveredBy: "cargo 유닛 테스트(recipient 해석 규칙 자체는 잠겨 있음) — S1이 자연 생성 포커스 방향은 이미 네이티브로 증명. 미검증인 것은 '포커스를 main으로 되돌리는' 방향 한 겹뿐",
  });
  // w1 is still open (never minimized this run) and therefore still fully
  // responsive to the bridge — close it cleanly so L1 teardown below sees
  // only "main" left alive, same as if S2/S3/S5 had never been reached.
  if (bridge.isRegistered("w1")) {
    await drive("w1", "closeSelf", {}).catch(() => {});
    await awaitTraceEvent(primary.pid, "window-destroyed", (f) => f.label === "w1").catch(() => {});
  }

  // ── S6: recovered ack (unreadable target) ─────────────────────────────
  const iResult = await launchCliOpen(iPath);
  check("s6.secondary-exit-0", iResult.exitCode === 0, iResult);
  const s6Ack = await awaitTraceEvent(primary.pid, "routing", (f) => f.trigger === "ack" && f.outcome === "recovered", 10000);
  check("s6.ack-outcome-recovered", true, s6Ack.fields);
  check("s6.queue-empty-after-recovered-ack", (s6Ack.fields.snapshot?.queues?.main ?? []).length === 0, s6Ack.fields);
  const mainAfterRecovery = await drive("main", "queryDoc", { selectors: [".recovery-modal"] });
  check("s6.recovery-modal-visible", mainAfterRecovery.selectors[".recovery-modal"] === true, mainAfterRecovery);

  // ── S7: stdin bytes + isolated non-interception ───────────────────────
  // `secondary-invocation` trace lines are written BY the primary process
  // (route_secondary_invocation's only call site), so every line in
  // primary.pid's own file always carries primary.pid as its top-level
  // `pid` — there is no per-line "which secondary process notified me"
  // field to match against. The correct isolation proof is therefore
  // structural: an isolated launch must produce ZERO NEW
  // "secondary-invocation" lines in primary's file at all (it never
  // installs the plugin, so it can never notify) — not a search for a
  // (nonexistent) matching pid.
  const s7PrimaryFloor = traceCursor.get(primary.pid) ?? 0;
  const stdinProc = launchIsolated("isolated-stdin", ["-"]);
  const stdinBytes = "# pipe";
  stdinProc.stdin.write(stdinBytes);
  stdinProc.stdin.end();
  // launch-class fires BEFORE stdin-scratch (classification happens right
  // after argv parsing, before .setup buffers stdin) — check it first, or
  // the cursor advance from the later stdin-scratch match would leave
  // nothing before it to find.
  await awaitTraceEvent(stdinProc.pid, "launch-class", (f) => f.class === "isolated");
  check("s7.isolated-class", true, {});
  const stdinTrace = await awaitTraceEvent(stdinProc.pid, "stdin-scratch", () => true);
  check("s7.scratch-byte-length", stdinTrace.fields.bytes === Buffer.byteLength(stdinBytes), stdinTrace.fields);
  const scratchOnDisk = await readFile(stdinTrace.fields.path, "utf8").catch(() => null);
  check("s7.scratch-content-matches", scratchOnDisk === stdinBytes, { scratchOnDisk });
  check("s7.isolated-still-alive", isAlive(stdinProc.pid), { pid: stdinProc.pid });
  const primaryLinesAtStdin = (await readTraceLines(primary.pid)).filter((l) => l.seq > s7PrimaryFloor);
  check("s7.no-secondary-invocation-observed-on-primary", !primaryLinesAtStdin.some((l) => l.event === "secondary-invocation"), { primaryLinesAtStdin });
  try {
    stdinProc.kill("SIGTERM");
  } catch {}
  await rm(stdinTrace.fields.path, { force: true }).catch(() => {});

  // ── S8: --right geometry ──────────────────────────────────────────────
  const rightProc = launchIsolated("isolated-right", ["--right", fixtureDoc("j.md")]);
  // Same ordering rule as S7: launch-class fires before isolated-geometry.
  await awaitTraceEvent(rightProc.pid, "launch-class", (f) => f.class === "isolated" && f.right === true);
  const geomTrace = await awaitTraceEvent(rightProc.pid, "isolated-geometry", () => true);
  const { window: win, monitor } = geomTrace.fields;
  check(
    "s8.right-half-geometry",
    win.x === win.width && win.width === monitor.logical_width / 2 && win.height === monitor.logical_height && win.y === 0,
    geomTrace.fields,
  );
  try {
    rightProc.kill("SIGTERM");
  } catch {}

  // ── L1 teardown ─────────────────────────────────────────────────────
  await drive("main", "closeSelf", {}).catch(() => {});
  const l1Deadline = Date.now() + 8000;
  while (Date.now() < l1Deadline && isAlive(primary.pid)) await sleep(100);
  check("l1.primary-exited", !isAlive(primary.pid), { pid: primary.pid });
  await rm(QA_SOCKET_PATH, { force: true });

  // ── S9: attachment import + render ────────────────────────────────────
  // Boot main DIRECTLY with vaultNotePath as its initial file (the same
  // `index.html?file=...` mechanism S1/S4/etc. already proved natively),
  // instead of seedVault-ing main and then `openPath`-ing a SEPARATELY
  // SPAWNED window (w1) to hold the note. MEASURED (this harness, prior
  // run): the spawn approach reliably produced "no-permanent-vault" — a
  // live read of the flash-status DOM node right after `image.attach`
  // showed the Korean VAULT_ATTACHMENT_MESSAGES["no-permanent-vault"]
  // text, i.e. `vaultImageContext()` returned null in the SPAWNED window
  // even though `seedVault` had already written the vault into
  // localStorage on "main" before spawning it. Whatever the underlying
  // cause (window-scoped WorkspaceStore construction not re-reading a
  // sibling window's already-written localStorage, or similar), booting
  // the vault-target window directly and then reloading THAT SAME window
  // sidesteps the question entirely: `seedVault`'s `location.reload()`
  // re-parses the identical `?file=` query param on the second boot pass,
  // by which point the vault IS in localStorage for that exact window —
  // no cross-window inheritance required.
  const l2 = await launchPrimary(vaultNotePath, { MERMARK_QA_PICK_FILE: picPath });
  await awaitDocLoaded("main", "note.md"); // first boot pass — file loads, but no vault registered yet
  await seedVaultAndWaitReload("main", vaultRoot);
  await awaitDocLoaded("main", "note.md"); // second boot pass, post-reload — now vault-aware
  await drive("main", "runAction", { id: "image.attach" });
  // flashStatus's message self-clears ~1200ms after it's set (main.ts), so a
  // diagnostic read taken only AFTER the full attach-import timeout would
  // always see it already reverted to blank — sample it eagerly, right
  // after the action fires, and carry that forward into the timeout's own
  // error message instead of re-querying too late to see anything.
  await sleep(400);
  const quickStatus = await drive("main", "queryDoc", {}).catch(() => null);
  const importTrace = await awaitTraceEvent(l2.pid, "attach-import", (f) => f.outcome === "imported", 10000).catch((traceError) => {
    throw new Error(`${traceError.message}\nDIAGNOSTIC: main status-pos text ~400ms after runAction("image.attach"): ${JSON.stringify(quickStatus?.statusText)}\nDIAGNOSTIC: main debugVault: ${JSON.stringify(quickStatus?.debugVault, null, 2)}`);
  });
  check("s9.attach-import-imported", true, importTrace.fields);
  await awaitTraceEvent(l2.pid, "attach-finalize", (f) => f.token === importTrace.fields.token);
  check("s9.attach-finalize", true, {});
  const attachedPath = join(vaultRoot, importTrace.fields.rel_path);
  const attachedBytes = await readFile(attachedPath).catch(() => null);
  check("s9.disk-bytes-match-source", attachedBytes !== null && attachedBytes.equals(onePixelPng), { attachedPath });
  const mainDocAfterAttach = await drive("main", "queryDoc", { selectors: [] });
  // `vault:` withdrawal (_workspace/00_request_vaultimage_fix.md): the
  // insertion contract is now a plain `![[fileName]]` wikilink-image embed,
  // not a `vault:`-scheme link — attach-image.ts's `embedMarkdownFor`. The
  // qa_trace "imported" event only carries `rel_path` (`.attachments/<name>`),
  // not a separate file_name field, so derive the basename the same way the
  // frontend does.
  const attachedFileName = importTrace.fields.rel_path.split("/").pop();
  check(
    "s9.doc-references-wikilink-embed",
    mainDocAfterAttach.textHead.includes(`![[${attachedFileName}]]`),
    mainDocAfterAttach,
  );
  await drive("main", "runAction", { id: "mode.toggle" });
  // The `vault:` render path (VaultImageWidget, `.cm-vault-image`) is gone —
  // a vault-scope `![[name]]` embed now renders through the SAME ImageWidget
  // as any other image (image.ts), whose DOM class is `.cm-image`.
  const mainReadModeAttach = await drive("main", "queryDoc", { selectors: [".cm-image"] });
  check("s9.cm-image-present-in-read-mode", mainReadModeAttach.selectors[".cm-image"] === true, mainReadModeAttach);
  await drive("main", "runAction", { id: "mode.toggle" });

  // ── S11: rollback rejected (attachment changed on disk) ────────────────
  // Calling through `image.attach` (like S9) auto-inserts the markdown
  // reference into the live document and immediately finalizes the import
  // on a successful insertion — by the time this harness's JS gets a
  // chance to tamper with the file and call rollback, the import is no
  // longer "pending". MEASURED: this raced and consistently lost,
  // producing "ROLLBACK_UNKNOWN: no pending import for token N" instead of
  // the intended "ROLLBACK_CHANGED:" — finalize runs synchronously in the
  // same call stack as the insertion that triggers it, with no seam to
  // pause it. Route around this by invoking `import_vault_attachment`
  // directly via `invokeRaw` — the SAME backend command `image.attach`'s
  // orchestration calls first (attach-image.ts), just without the
  // frontend's insert+finalize follow-through, so the import stays
  // genuinely pending until THIS scenario's own rollback call resolves it.
  await drive("main", "invokeRaw", { cmd: "import_vault_attachment", args: { vaultRoot } });
  const importTrace2 = await awaitTraceEvent(l2.pid, "attach-import", (f) => f.outcome === "imported" && f.token !== importTrace.fields.token, 10000);
  check("s11.second-attach-new-token", importTrace2.fields.token !== importTrace.fields.token, importTrace2.fields);
  const attachedPath2 = join(vaultRoot, importTrace2.fields.rel_path);
  const originalBytes2 = await readFile(attachedPath2);
  await rm(attachedPath2, { force: true });
  await writeFile(attachedPath2, Buffer.concat([onePixelPng, Buffer.from("changed")]));
  const rollbackReject = await drive("main", "invokeRaw", { cmd: "rollback_attachment_import", args: { token: importTrace2.fields.token } }).then(
    () => null,
    (e) => e,
  );
  check("s11.rollback-rejects-changed", rollbackReject !== null && String(rollbackReject.message ?? rollbackReject).includes("ROLLBACK_CHANGED:"), { rollbackReject: String(rollbackReject) });
  const rollbackTrace = await awaitTraceEvent(l2.pid, "attach-rollback", (f) => f.token === importTrace2.fields.token);
  check("s11.rollback-trace-result-changed", rollbackTrace.fields.result === "changed", rollbackTrace.fields);
  const attachedBytesAfterReject = await readFile(attachedPath2);
  check("s11.disk-bytes-preserved", attachedBytesAfterReject.length === onePixelPng.length + "changed".length, {});
  check("s11.disk-not-restored-to-original", !attachedBytesAfterReject.equals(originalBytes2), {});

  // ── S12: unresolved name-search reference stays a harmless broken image ──
  // `vault:` withdrawal (_workspace/00_request_vaultimage_fix.md): there is
  // no more scheme-specific rejection path (`resolveVaultImage`,
  // `.cm-vault-image-error`) — an unresolved `![[name]]` now falls through
  // the SAME recursive-search fallback as any other image (image.ts) and,
  // finding nothing, just stays a normal (broken) `.cm-image` <img> with its
  // literal (failing) src — no special error class, no rejection-reason
  // title. This only re-proves the two invariants that still matter here:
  // the raw markdown is never mutated by a failed search, and the widget
  // still mounts (doesn't silently vanish) even when resolution fails.
  //
  // No command in the fixed 7-vocabulary types text into the live editor
  // (runAction only triggers a registered action id; invokeRaw is IPC-only)
  // — and main's `write_file` would be recorded as main's own self-write by
  // the backend watcher (record_self_write), muting the file-changed reload
  // it would otherwise get. Route around both by writing the broken ref to
  // disk directly, then `openPath`-ing the SAME path into a fresh window
  // (w1): that's a real `read_file` from disk, no self-write suppression,
  // and still only ever the fixed 7 commands.
  const mainHead = await drive("main", "queryDoc", {});
  const brokenAppend = "\n\n![[missing-does-not-exist.png]]\n";
  await drive("main", "invokeRaw", {
    cmd: "write_file",
    args: { path: vaultNotePath, text: `${mainHead.textHead}${brokenAppend}`, baseline: 0 },
  });
  await drive("main", "openPath", { path: vaultNotePath });
  await bridge.waitForLabel("w1");
  await awaitDocLoaded("w1", "missing-does-not-exist.png"); // wait for the just-written broken ref, not just the realm
  await drive("w1", "runAction", { id: "mode.toggle" }); // -> read mode; the image widget renders there
  const s12Doc = await drive("w1", "queryDoc", { selectors: [".cm-image"] });
  check("s12.raw-text-preserved", s12Doc.textHead.includes("![[missing-does-not-exist.png]]"), s12Doc);
  check("s12.image-widget-still-mounts-when-unresolved", s12Doc.selectors[".cm-image"] === true, s12Doc);
  await drive("w1", "closeSelf", {}).catch(() => {});

  // ── S10: picker cancel ─────────────────────────────────────────────────
  await drive("main", "closeSelf", {}).catch(() => {});
  const l2Deadline = Date.now() + 8000;
  while (Date.now() < l2Deadline && isAlive(l2.pid)) await sleep(100);
  await rm(QA_SOCKET_PATH, { force: true });

  const l3 = await launchPrimary(vaultNotePath, { MERMARK_QA_PICK_FILE: "" });
  await awaitDocLoaded("main", "note.md");
  await seedVaultAndWaitReload("main", vaultRoot);
  await awaitDocLoaded("main", "note.md");
  const attachmentsBefore = existsSync(join(vaultRoot, ".attachments"))
    ? (await readdir(join(vaultRoot, ".attachments"))).length
    : 0;
  await drive("main", "runAction", { id: "image.attach" });
  const cancelTrace = await awaitTraceEvent(l3.pid, "attach-import", (f) => f.outcome === "cancelled", 10000);
  check("s10.attach-import-cancelled", true, cancelTrace.fields);
  const attachmentsAfter = existsSync(join(vaultRoot, ".attachments"))
    ? (await readdir(join(vaultRoot, ".attachments"))).length
    : 0;
  check("s10.attachments-dir-unchanged", attachmentsBefore === attachmentsAfter, { attachmentsBefore, attachmentsAfter });
  await drive("main", "closeSelf", {}).catch(() => {});
  const l3Deadline = Date.now() + 8000;
  while (Date.now() < l3Deadline && isAlive(l3.pid)) await sleep(100);

  if (forceFailure) {
    check("red-control.intentional-failure", false, { note: "WINDOW_ROUTING_SMOKE_FORCE_FAILURE=1" });
  }
} catch (error) {
  checks.push({ id: "harness.uncaught", passed: false, observable: { message: error instanceof Error ? error.message : String(error) } });
  console.error(error);
} finally {
  clearTimeout(watchdogTimer);
  await cleanup();

  // ── S13: residue check (post-cleanup) ──────────────────────────────────
  check("s13.all-children-dead", [...registry.keys()].every((pid) => !isAlive(pid)), { remaining: [...registry.keys()] });
  check("s13.qa-socket-absent", !existsSync(QA_SOCKET_PATH), { QA_SOCKET_PATH });
  check("s13.fixture-root-removed", !existsSync(fixtureRoot), { fixtureRoot });
  check("s13.port-1420-free", await new Promise((r) => {
    const probe = createServer();
    probe.once("error", () => r(false));
    probe.once("listening", () => probe.close(() => r(true)));
    probe.listen(VITE_PORT, "127.0.0.1");
  }), {});

  await writeFile(
    join(evidenceDir, "window-routing-smoke.json"),
    JSON.stringify({ mode: "native — real debug binary, real WKWebView, real IPC, no browser/mock", forceFailure, checks, outOfScope }, null, 2),
  );
}

const failed = checks.filter((entry) => !entry.passed);
console.log(JSON.stringify({ checks: checks.length, passed: checks.length - failed.length, failed: failed.map((entry) => entry.id), evidenceDir }, null, 2));
if (failed.length > 0) process.exitCode = 1;
