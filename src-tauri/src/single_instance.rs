//! Single-window-opening Todo 2's routing broker: delivers an ordinary
//! `mermark <file>` launch from a second process to exactly one already-open
//! window instead of spawning a duplicate. Split into a **pure core**
//! (`Routing` and its methods, decision-only, no Tauri types) and a **thin
//! shell** (the free functions below it: `route_secondary_invocation`,
//! `apply_actions`, `track_window_event`, and the two `#[tauri::command]`s)
//! that executes the core's `RoutingAction` decisions against the real app.
//! The split exists so every state transition — pre-ready queuing, FIFO
//! delivery, close-mid-delivery requeue, main respawn — is a plain
//! `Vec<RoutingAction>` a unit test can assert on without a running Tauri
//! app; only the shell needs one, and it does no deciding of its own.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::qa_trace::qa_trace;

/// One request still awaiting delivery-and-acknowledgement, FIFO-queued per
/// recipient label. `delivered` distinguishes "sent, awaiting ack" from
/// "queued, not yet sent" — `pump` only ever advances it forward, and only
/// `acknowledge` (matching `id`) may retire the request it guards.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenRequest {
    pub id: u64,
    pub path: PathBuf,
    pub delivered: bool,
}

/// The pure routing core: recency, readiness, and per-recipient FIFO queues.
/// No Tauri type appears here — every method takes the caller's `live`
/// window-label snapshot as a parameter rather than owning a copy of it, so
/// the single source of truth for "which windows exist" stays the real
/// Tauri window manager (`app.webview_windows()`), never a stale mirror.
pub struct Routing {
    /// Most-recently-focused-first, document windows only (`is_document_window`).
    focus_order: Vec<String>,
    /// Labels the frontend has called `register_window_ready` for.
    ready: HashSet<String>,
    /// Recipient-scoped FIFO queues of not-yet-acknowledged requests.
    queues: HashMap<String, VecDeque<OpenRequest>>,
    /// Next request id to hand out; monotonic for the process's lifetime so
    /// a stale/duplicate ack id can never collide with a live request's id.
    next_id: u64,
    /// True while a `SpawnMain` has been issued but neither acknowledged by
    /// focus nor readiness yet — guards against issuing a second one for a
    /// burst of requests that all resolve to "recreate main".
    main_spawn_pending: bool,
}

impl Default for Routing {
    fn default() -> Self {
        Routing {
            focus_order: Vec::new(),
            ready: HashSet::new(),
            queues: HashMap::new(),
            next_id: 1,
            main_spawn_pending: false,
        }
    }
}

/// The managed (`.manage()`) wrapper around `Routing`. A plain `Mutex`, not a
/// heavier concurrent structure — decisions are quick, pure function calls,
/// and every caller releases the lock before doing anything Tauri-effectful
/// (`apply_actions` always runs after the guard from a `.lock()` call has
/// gone out of scope), so lock hold time never overlaps a `run_on_main_thread`
/// hop and can't deadlock against it.
#[derive(Default)]
pub struct RoutingState(pub Mutex<Routing>);

/// An effect the shell must perform after a `Routing` method returns.
/// `Debug + PartialEq` deliberately, so both the unit tests here and a
/// future Todo 6 trace seam can assert on/observe an exact action sequence.
#[derive(Debug, Clone, PartialEq)]
pub enum RoutingAction {
    /// Emit `"cli-open-request"` to this webview window, targeted (never a
    /// global emit — see `apply_actions`).
    Deliver { label: String, id: u64, path: PathBuf },
    /// Recreate the standard `main` window (no `?file=` query — the routed
    /// document, if any, arrives afterward once `main` registers ready).
    SpawnMain,
    /// Bring an existing window to the front (bare second-process launch).
    Focus { label: String },
}

/// Where an ordinary CLI open or a bare (no-arg) launch should land.
#[derive(Debug, PartialEq)]
enum Recipient {
    Existing(String),
    RecreateMain,
}

/// True for a label this broker treats as a document window — eligible for
/// focus-recency tracking and as a routing recipient. `"main"` is the
/// startup window; any `w{n}` label is a wikilink-spawned window
/// (`commands::document_window_spec`). Named so a future non-document window
/// (e.g. a settings panel) can be excluded from routing by simply not
/// matching this predicate, rather than by auditing every call site that
/// walks `focus_order`.
fn is_document_window(label: &str) -> bool {
    label == "main" || label.starts_with('w')
}

/// Decide which window an ordinary CLI file-open (or a bare launch) should
/// go to: the most-recently-focused label that is still alive, else the
/// live `"main"`, else recreate `"main"`. Deliberately has **no** branch
/// that falls back to an arbitrary `live` `w*` label when recency is empty
/// — under the approved window-routing matrix, a `w*` label may only ever
/// be chosen because it is the most recently focused window, never as a
/// fallback of convenience.
fn resolve_recipient(focus_order: &[String], live: &HashSet<String>) -> Recipient {
    if let Some(label) = focus_order.iter().find(|l| live.contains(l.as_str())) {
        return Recipient::Existing(label.clone());
    }
    if live.contains("main") {
        return Recipient::Existing("main".to_string());
    }
    Recipient::RecreateMain
}

impl Routing {
    /// Move `label` to the front of the focus-recency list when it gains
    /// focus (`WindowEvent::Focused(true)`), and clear the "a main respawn
    /// is already underway" gate if `main` itself is the label — a freshly
    /// (re)built `main` getting focus is one of the two signals (the other
    /// is `mark_ready`) that the respawn it was waiting on has landed.
    /// Non-document labels are ignored outright: they must never crowd out
    /// real recency data or be eligible as a routing recipient.
    pub fn note_focused(&mut self, label: &str) {
        if !is_document_window(label) {
            return;
        }
        self.focus_order.retain(|l| l != label);
        self.focus_order.insert(0, label.to_string());
        if label == "main" {
            self.main_spawn_pending = false;
        }
    }

    /// Queue an ordinary CLI file-open, addressed to whichever window
    /// `resolve_recipient` names, then immediately try to deliver it
    /// (`pump`) in case that window is already ready. Assigns a fresh,
    /// monotonically increasing request id — ids are never reused, so a
    /// stale ack from an earlier request can never be mistaken for the
    /// current head's ack (see `acknowledge`).
    pub fn enqueue_open(&mut self, path: PathBuf, live: &HashSet<String>) -> Vec<RoutingAction> {
        let id = self.next_id;
        self.next_id += 1;
        let (label, spawn) = match resolve_recipient(&self.focus_order, live) {
            Recipient::Existing(label) => (label, false),
            Recipient::RecreateMain => {
                let spawn = !self.main_spawn_pending;
                self.main_spawn_pending = true;
                ("main".to_string(), spawn)
            }
        };
        self.queues
            .entry(label.clone())
            .or_default()
            .push_back(OpenRequest { id, path, delivered: false });
        let mut actions = Vec::new();
        if spawn {
            actions.push(RoutingAction::SpawnMain);
        }
        actions.extend(self.pump(&label));
        actions
    }

    /// Register `label` as able to receive deliveries (the frontend's
    /// `register_window_ready`, sent only after its `cli-open-request`
    /// listener is already attached) and immediately try to deliver its
    /// queue head. Marking `"main"` ready also clears the respawn gate, the
    /// other half of the "main respawn landed" signal alongside
    /// `note_focused`.
    pub fn mark_ready(&mut self, label: &str) -> Vec<RoutingAction> {
        self.ready.insert(label.to_string());
        if label == "main" {
            self.main_spawn_pending = false;
        }
        self.pump(label)
    }

    /// Retire the head of `label`'s queue, but only when it is both
    /// delivered and its id matches `id` exactly; a mismatched id (stale,
    /// duplicate, or for a different recipient's former head) is ignored
    /// and the head stays queued untouched. This is the "a failed/cancelled
    /// safe-open must not vanish" guarantee: only a matching ack — whatever
    /// its `outcome` string says, the core doesn't care — ever pops a
    /// request.
    pub fn acknowledge(&mut self, label: &str, id: u64) -> Vec<RoutingAction> {
        let popped = matches!(
            self.queues.get(label).and_then(|q| q.front()),
            Some(head) if head.delivered && head.id == id
        );
        if !popped {
            return Vec::new();
        }
        self.queues.get_mut(label).unwrap().pop_front();
        self.pump(label)
    }

    /// React to a document window closing (`WindowEvent::Destroyed`): drop
    /// it from recency and readiness, then re-home every request still
    /// queued for it — including an in-flight, not-yet-acked head — by
    /// re-resolving each one through `enqueue_open`, in original FIFO
    /// order. This is "a recipient closing mid-delivery retries
    /// resolution": a request is never dropped just because the window it
    /// was addressed to died before acking it.
    pub fn window_destroyed(&mut self, label: &str, live: &HashSet<String>) -> Vec<RoutingAction> {
        self.focus_order.retain(|l| l != label);
        self.ready.remove(label);
        let drained = self.queues.remove(label).unwrap_or_default();
        let mut actions = Vec::new();
        for req in drained {
            actions.extend(self.enqueue_open(req.path, live));
        }
        actions
    }

    /// Handle a bare second-process launch (no argv): focus the resolved
    /// recipient if one is alive, or recreate `main` if none is. Unlike
    /// `enqueue_open`, this never touches a queue — there is no document to
    /// lose track of — but still shares `enqueue_open`'s recipient
    /// resolution and respawn gate, rather than the deleted
    /// `focus_main_window`'s unconditional "always main" rule.
    pub fn focus_only(&mut self, live: &HashSet<String>) -> Vec<RoutingAction> {
        match resolve_recipient(&self.focus_order, live) {
            Recipient::Existing(label) => vec![RoutingAction::Focus { label }],
            Recipient::RecreateMain => {
                if self.main_spawn_pending {
                    Vec::new()
                } else {
                    self.main_spawn_pending = true;
                    vec![RoutingAction::SpawnMain]
                }
            }
        }
    }

    /// Deliver `label`'s queue head exactly once, if that window is ready
    /// and nothing of its is already in flight. "In flight" means the head
    /// is marked delivered but not yet acked; `pump` never re-delivers it,
    /// so at most one undelivered request per label is ever outstanding —
    /// the next head only ships once `acknowledge` pops the current one and
    /// calls `pump` again. Emitting is a *decision* here, not the emit
    /// itself: the shell (`apply_actions`) performs the actual `emit_to`.
    fn pump(&mut self, label: &str) -> Vec<RoutingAction> {
        if !self.ready.contains(label) {
            return Vec::new();
        }
        match self.queues.get_mut(label).and_then(|q| q.front_mut()) {
            Some(head) if !head.delivered => {
                head.delivered = true;
                vec![RoutingAction::Deliver { label: label.to_string(), id: head.id, path: head.path.clone() }]
            }
            _ => Vec::new(),
        }
    }
}

/// QA-observability-only view of the routing core: focus recency order,
/// which labels have registered ready, and each label's queue (id/delivered/
/// path per still-pending request). A pure query (`&self`, no side effect) —
/// this is what lets the Todo 6 native harness observe "the request landed
/// in window w1's queue" even in the pre-ready case, where no `Deliver`
/// action exists yet to observe instead (see `enqueue_open`: a request can
/// sit queued, undelivered, before its recipient ever calls
/// `register_window_ready`). Debug-only, alongside the rest of the qa_trace
/// seam: this method doesn't exist in a release build, so a release call
/// site referencing it would be a compile error, not a runtime no-op — the
/// seam's absence is structural.
#[cfg(debug_assertions)]
impl Routing {
    pub(crate) fn qa_snapshot(&self) -> serde_json::Value {
        let queues: serde_json::Map<String, serde_json::Value> = self
            .queues
            .iter()
            .map(|(label, queue)| {
                let items: Vec<serde_json::Value> = queue
                    .iter()
                    .map(|req| {
                        serde_json::json!({
                            "id": req.id,
                            "delivered": req.delivered,
                            "path": req.path.to_string_lossy(),
                        })
                    })
                    .collect();
                (label.clone(), serde_json::Value::Array(items))
            })
            .collect();
        serde_json::json!({
            "focus_order": self.focus_order,
            "ready": self.ready.iter().cloned().collect::<Vec<_>>(),
            "queues": serde_json::Value::Object(queues),
        })
    }
}

#[cfg(test)]
impl Routing {
    /// Test-only introspection: the current queue head for `label`, without
    /// exposing the queue itself to production callers.
    fn head(&self, label: &str) -> Option<&OpenRequest> {
        self.queues.get(label).and_then(|q| q.front())
    }
}

/// The decision half of handling a second process's notification, kept free
/// of any `AppHandle` so it is unit-testable without a running Tauri app.
enum SecondaryOpen {
    File(PathBuf),
    FocusOnly,
}

/// Reclassify a second process's raw argv exactly the way the primary
/// process classified its own launch, and decide whether/how it should join
/// the singleton. `argv[0]` (the program path — the plugin's transport
/// includes it, see module doc on `route_secondary_invocation`) is skipped
/// before classifying. `Isolated`/`Headless`/`Err` classes are unreachable
/// in practice — a process that would classify to one of those never
/// installs the plugin, so it never notifies — but are handled defensively
/// as "never opens a document" rather than assumed away: an invalid or
/// unexpected invocation must never be silently upgraded into a successful
/// open.
fn secondary_route_decision(argv: &[String], cwd: &Path) -> Option<SecondaryOpen> {
    let rest = argv.get(1..).unwrap_or(&[]);
    match crate::cli::classify_launch(rest, cwd) {
        Ok(crate::cli::LaunchClass::SingletonRouted(Some(path))) => Some(SecondaryOpen::File(path)),
        Ok(crate::cli::LaunchClass::SingletonRouted(None)) => Some(SecondaryOpen::FocusOnly),
        _ => None,
    }
}

/// Runs `f` (a `Routing` core call) with the routing lock held, then — debug
/// builds only — emits a `"routing"` trace line for it. `extra` adds one
/// caller-supplied field (`acknowledge_open_request`'s `outcome`; every
/// other caller passes `None`). The snapshot is taken from `routing`
/// *before* the `MutexGuard` is dropped (so it reflects exactly the state
/// `f` just produced), but `qa_trace!` — the file write — runs only *after*
/// `drop(routing)`, so file I/O never happens while the routing mutex is
/// held. Centralizes that ordering rule once instead of repeating it at
/// every shell entry point (`route_secondary_invocation`,
/// `register_window_ready`, `acknowledge_open_request`, `track_window_event`'s
/// `Destroyed` arm).
#[cfg(debug_assertions)]
fn with_routing_trace(
    state: &RoutingState,
    trigger: &str,
    extra: Option<(&str, serde_json::Value)>,
    f: impl FnOnce(&mut Routing) -> Vec<RoutingAction>,
) -> Vec<RoutingAction> {
    let mut routing = state.0.lock().unwrap();
    let actions = f(&mut routing);
    let mut fields = serde_json::json!({
        "trigger": trigger,
        "actions": actions.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
        "snapshot": routing.qa_snapshot(),
    });
    if let (Some(map), Some((key, value))) = (fields.as_object_mut(), extra) {
        map.insert(key.to_string(), value);
    }
    drop(routing); // release the lock before any file I/O
    qa_trace!("routing", fields);
    actions
}

/// Release-build twin of the function above: same lock-and-call shape, no
/// tracing at all. This function (not a runtime `if`) is what a release
/// caller actually compiles against, so `trigger`/`extra`/`qa_snapshot` never
/// enter a release build through this path either.
#[cfg(not(debug_assertions))]
fn with_routing_trace(
    state: &RoutingState,
    _trigger: &str,
    _extra: Option<(&str, serde_json::Value)>,
    f: impl FnOnce(&mut Routing) -> Vec<RoutingAction>,
) -> Vec<RoutingAction> {
    f(&mut state.0.lock().unwrap())
}

/// The single-instance plugin's callback, invoked in the **primary**
/// process when a second `mermark` process launches (tauri-plugin-single-
/// instance transports `cwd + "\0\0" + argv` including `argv[0]`). The
/// second process has already created its file target (if any) itself,
/// before ever calling this notify — the plugin's `notify_singleton` exits
/// the second process right after a successful send (see crate fact 1 in
/// `_workspace/01_architect_todo2_design.md`), so this function never
/// creates or writes a file; it only routes an already-resolved path.
pub fn route_secondary_invocation(app: &tauri::AppHandle, argv: &[String], cwd: &str) {
    let decision = secondary_route_decision(argv, Path::new(cwd));
    qa_trace!(
        "secondary-invocation",
        serde_json::json!({
            "argv": argv,
            "decision": match &decision {
                Some(SecondaryOpen::File(_)) => "file",
                Some(SecondaryOpen::FocusOnly) => "focus-only",
                None => "none",
            },
        })
    );
    let live: HashSet<String> = app.webview_windows().keys().cloned().collect();
    let state = app.state::<RoutingState>();
    let actions = match decision {
        Some(SecondaryOpen::File(path)) => {
            with_routing_trace(&state, "enqueue", None, |routing| routing.enqueue_open(path, &live))
        }
        Some(SecondaryOpen::FocusOnly) => {
            with_routing_trace(&state, "focus-only", None, |routing| routing.focus_only(&live))
        }
        None => return,
    }; // lock released inside with_routing_trace before apply_actions — see RoutingState's doc comment.
    apply_actions(app.clone(), actions);
}

/// Payload shape for the `"cli-open-request"` event — the frontend contract
/// (`_workspace/01_architect_todo2_design.md` §분기3): `{ id, path }`.
#[derive(Clone, serde::Serialize)]
struct OpenRequestPayload {
    id: u64,
    path: String,
}

/// Build the standard `main` document window with no `?file=` query — the
/// routed document (if any) arrives afterward via the broker once `main`
/// registers ready, same as any other CLI-routed open. On a build failure,
/// clears `main_spawn_pending` so the *next* trigger (another request,
/// another bare launch) gets to attempt the respawn again instead of being
/// silently gated forever by a spawn that never actually happened.
fn spawn_main_window(app: &tauri::AppHandle) {
    let builder = crate::with_document_chrome(
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("mermark")
            .inner_size(crate::DEFAULT_WINDOW.0, crate::DEFAULT_WINDOW.1)
            .min_inner_size(crate::MIN_WINDOW.0, crate::MIN_WINDOW.1),
    );
    match builder.build() {
        Ok(_) => {
            qa_trace!("spawn-main-result", serde_json::json!({ "ok": true }));
        }
        Err(e) => {
            eprintln!("mermark: failed to recreate main window: {e}");
            qa_trace!(
                "spawn-main-result",
                serde_json::json!({ "ok": false, "error": e.to_string() })
            );
            let state = app.state::<RoutingState>();
            state.0.lock().unwrap().main_spawn_pending = false;
        }
    }
}

/// Execute a batch of `RoutingAction`s against the real Tauri app. `Deliver`
/// is a targeted `emit_to(WebviewWindow{label})` — never `AppHandle::emit`
/// (global), which any window could observe. `SpawnMain`/`Focus` build or
/// focus a window, which window-manager calls require the main thread for
/// on some platforms, so those hop through `run_on_main_thread` (crate fact
/// 3). Always called with the routing lock already released by the caller
/// (see `route_secondary_invocation`, `register_window_ready`,
/// `acknowledge_open_request`, `track_window_event`), so a
/// `run_on_main_thread` closure that re-enters `RoutingState` can never
/// deadlock against this call's own lock.
fn apply_actions(app: tauri::AppHandle, actions: Vec<RoutingAction>) {
    for action in actions {
        match action {
            RoutingAction::Deliver { label, id, path } => {
                let payload = OpenRequestPayload { id, path: path.to_string_lossy().into_owned() };
                if let Err(e) = app.emit_to(
                    tauri::EventTarget::WebviewWindow { label: label.clone() },
                    "cli-open-request",
                    payload,
                ) {
                    eprintln!("mermark: failed to deliver cli-open-request to {label}: {e}");
                }
            }
            RoutingAction::SpawnMain => {
                let inner = app.clone();
                let _ = app.run_on_main_thread(move || spawn_main_window(&inner));
            }
            RoutingAction::Focus { label } => {
                let inner = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(window) = inner.get_webview_window(&label) {
                        let _ = window.set_focus();
                    }
                });
            }
        }
    }
}

/// `Builder::on_window_event` hook: feeds `Focused(true)`/`Destroyed` into
/// the broker's recency/liveness bookkeeping for document windows.
/// `CloseRequested` is deliberately **not** consumed here — it is
/// cancelable (a dirty-save prompt can veto it), so treating it as a close
/// would misclassify a window the user chose to keep open as already dead.
pub fn track_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label();
    if !is_document_window(label) {
        return;
    }
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::Focused(true) => {
            qa_trace!("window-focused", serde_json::json!({ "label": label }));
            let state = app.state::<RoutingState>();
            state.0.lock().unwrap().note_focused(label);
        }
        tauri::WindowEvent::Destroyed => {
            let live: HashSet<String> = app
                .webview_windows()
                .keys()
                .filter(|l| l.as_str() != label)
                .cloned()
                .collect();
            let state = app.state::<RoutingState>();
            let actions =
                with_routing_trace(&state, "destroyed", None, |routing| routing.window_destroyed(label, &live));
            qa_trace!(
                "window-destroyed",
                serde_json::json!({ "label": label, "requeued": !actions.is_empty() })
            );
            apply_actions(app.clone(), actions);
        }
        _ => {}
    }
}

/// Signals this webview window can now receive `"cli-open-request"`
/// deliveries. The label is read from `window.label()` (server-side, so a
/// webview can't forge a different recipient's readiness) rather than taken
/// as an argument.
#[tauri::command]
pub fn register_window_ready(window: tauri::WebviewWindow, state: tauri::State<RoutingState>) {
    let label = window.label().to_string();
    let actions = with_routing_trace(&state, "ready", None, |routing| routing.mark_ready(&label));
    apply_actions(window.app_handle().clone(), actions);
}

/// Retires request `id` for the calling window — sent after
/// `openDocumentSafely` settles, whether it opened the document
/// successfully or surfaced a visible recovery state (`outcome` is
/// `"opened"` or `"recovered"`). `outcome` plays no role in the routing
/// core's state transition (see `Routing::acknowledge`); it exists purely
/// for the Todo 6 trace seam to observe *why* a request was retired.
#[tauri::command]
pub fn acknowledge_open_request(
    window: tauri::WebviewWindow,
    state: tauri::State<RoutingState>,
    id: u64,
    outcome: String,
) {
    let label = window.label().to_string();
    let actions = with_routing_trace(
        &state,
        "ack",
        Some(("outcome", serde_json::Value::String(outcome))),
        |routing| routing.acknowledge(&label, id),
    );
    apply_actions(window.app_handle().clone(), actions);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_set(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|s| s.to_string()).collect()
    }

    // --- pre-ready delivery ---

    #[test]
    fn pre_ready_request_is_queued_not_delivered() {
        let mut r = Routing::default();
        let live = live_set(&["main"]);
        let actions = r.enqueue_open(PathBuf::from("/tmp/a.md"), &live);
        assert!(actions.iter().all(|a| !matches!(a, RoutingAction::Deliver { .. })));
        let actions = r.mark_ready("main");
        assert_eq!(
            actions,
            vec![RoutingAction::Deliver { label: "main".into(), id: 1, path: "/tmp/a.md".into() }]
        );
    }

    // --- FIFO double open ---

    #[test]
    fn fifo_double_open_delivers_one_at_a_time() {
        let mut r = Routing::default();
        let live = live_set(&["main"]);
        r.mark_ready("main");
        let a = r.enqueue_open(PathBuf::from("/tmp/a.md"), &live);
        assert_eq!(
            a,
            vec![RoutingAction::Deliver { label: "main".into(), id: 1, path: "/tmp/a.md".into() }]
        );
        let b = r.enqueue_open(PathBuf::from("/tmp/b.md"), &live);
        assert!(b.is_empty(), "second request must wait behind the unacked first: {b:?}");
        let ack = r.acknowledge("main", 1);
        assert_eq!(
            ack,
            vec![RoutingAction::Deliver { label: "main".into(), id: 2, path: "/tmp/b.md".into() }]
        );
    }

    // --- dirty-save failure / recovery acknowledgement ---

    #[test]
    fn request_survives_until_recovery_ack() {
        let mut r = Routing::default();
        let live = live_set(&["main"]);
        r.mark_ready("main");
        r.enqueue_open(PathBuf::from("/tmp/a.md"), &live);
        // Re-querying readiness without acking must not re-fire delivery —
        // the head stays queued, still marked delivered, awaiting ack.
        let requeried = r.mark_ready("main");
        assert!(requeried.is_empty());
        let head = r.head("main").expect("head must survive until acked");
        assert_eq!(head.id, 1);
        assert!(head.delivered);
        // Whatever the outcome string was (recovered or opened, the core
        // doesn't distinguish), a matching ack retires it.
        let actions = r.acknowledge("main", 1);
        assert!(actions.is_empty(), "no further request queued: {actions:?}");
        assert!(r.head("main").is_none());
    }

    // --- closed recipient (stale ack id ignored) ---

    #[test]
    fn stale_ack_id_is_ignored() {
        let mut r = Routing::default();
        let live = live_set(&["main"]);
        r.mark_ready("main");
        r.enqueue_open(PathBuf::from("/tmp/a.md"), &live); // id 1, delivered
        let actions = r.acknowledge("main", 99);
        assert!(actions.is_empty());
        let head = r.head("main").unwrap();
        assert_eq!(head.id, 1, "mismatched ack must not pop the real head");
        assert!(head.delivered);
    }

    // --- closed recipient requeues to the next resolvable window ---

    #[test]
    fn closed_recipient_requeues_to_next() {
        let mut r = Routing::default();
        r.note_focused("w3");
        let live_with_w3 = live_set(&["w3", "main"]);
        r.mark_ready("w3");
        r.mark_ready("main");
        let a = r.enqueue_open(PathBuf::from("/tmp/a.md"), &live_with_w3);
        assert_eq!(
            a,
            vec![RoutingAction::Deliver { label: "w3".into(), id: 1, path: "/tmp/a.md".into() }]
        );
        let b = r.enqueue_open(PathBuf::from("/tmp/b.md"), &live_with_w3);
        assert!(b.is_empty(), "b waits behind unacked a on w3: {b:?}");

        // w3 closes before acking a; only main is left alive.
        let live_after = live_set(&["main"]);
        let actions = r.window_destroyed("w3", &live_after);
        // a is re-resolved to main and immediately delivered (main is ready).
        assert_eq!(
            actions,
            vec![RoutingAction::Deliver { label: "main".into(), id: 3, path: "/tmp/a.md".into() }]
        );
        // b (still queued behind a) follows once a is acked.
        let ack = r.acknowledge("main", 3);
        assert_eq!(
            ack,
            vec![RoutingAction::Deliver { label: "main".into(), id: 4, path: "/tmp/b.md".into() }]
        );
    }

    // --- closed main ---

    #[test]
    fn dead_focus_and_dead_main_recreates_main() {
        let mut r = Routing::default();
        r.note_focused("w9"); // recency remembers a now-dead window
        let live = live_set(&[]); // nothing alive
        let actions = r.enqueue_open(PathBuf::from("/tmp/a.md"), &live);
        assert_eq!(actions, vec![RoutingAction::SpawnMain]);
        let actions = r.mark_ready("main");
        assert_eq!(
            actions,
            vec![RoutingAction::Deliver { label: "main".into(), id: 1, path: "/tmp/a.md".into() }]
        );
    }

    // --- no live window ---

    #[test]
    fn no_live_window_spawns_main_once() {
        let mut r = Routing::default();
        let live = live_set(&[]);
        let first = r.enqueue_open(PathBuf::from("/tmp/a.md"), &live);
        assert_eq!(first, vec![RoutingAction::SpawnMain]);
        let second = r.enqueue_open(PathBuf::from("/tmp/b.md"), &live);
        assert!(second.is_empty(), "a pending spawn must gate a second SpawnMain: {second:?}");
    }

    // --- never an arbitrary w* fallback ---

    #[test]
    fn resolve_recipient_never_picks_arbitrary_w() {
        // main and an unrelated w2 both alive, no recency data: must land
        // on main, never the arbitrary live w2.
        assert_eq!(
            resolve_recipient(&[], &live_set(&["w2", "main"])),
            Recipient::Existing("main".to_string())
        );
        // Only w2 alive (main dead), no recency: recreate main, never w2.
        assert_eq!(resolve_recipient(&[], &live_set(&["w2"])), Recipient::RecreateMain);
        // w2 alive AND most-recently-focused: recency legitimately selects
        // it — the only path by which a w* label may ever be chosen.
        assert_eq!(
            resolve_recipient(&["w2".to_string()], &live_set(&["w2"])),
            Recipient::Existing("w2".to_string())
        );
    }

    // --- focus recency bookkeeping ---

    #[test]
    fn focused_label_moves_to_front() {
        let mut r = Routing::default();
        r.note_focused("main");
        r.note_focused("w2");
        r.note_focused("main");
        assert_eq!(r.focus_order, vec!["main".to_string(), "w2".to_string()]);
    }

    #[test]
    fn non_document_labels_ignored() {
        let mut r = Routing::default();
        r.note_focused("about"); // not "main" and doesn't start with "w"
        assert!(r.focus_order.is_empty());
    }

    // --- bare no-arg second launch follows recency, not an unconditional main ---

    #[test]
    fn focus_only_follows_recency_not_main() {
        let mut r = Routing::default();
        r.note_focused("main");
        r.note_focused("w2"); // focus_order = [w2, main]
        let actions = r.focus_only(&live_set(&["w2", "main"]));
        assert_eq!(actions, vec![RoutingAction::Focus { label: "w2".into() }]);

        let mut r2 = Routing::default();
        let actions2 = r2.focus_only(&live_set(&[]));
        assert_eq!(actions2, vec![RoutingAction::SpawnMain]);
    }

    // --- qa_snapshot (Todo 6 trace seam observability) ---

    #[test]
    fn qa_snapshot_names_focus_ready_and_queues() {
        let mut r = Routing::default();
        r.note_focused("main");
        let live = live_set(&["main"]);
        // Pre-ready enqueue: queued but not yet delivered — the exact case
        // `qa_snapshot` exists to make observable before any `Deliver`
        // action fires (see this method's doc comment).
        r.enqueue_open(PathBuf::from("/tmp/a.md"), &live);

        let snap = r.qa_snapshot();

        assert_eq!(snap["focus_order"], serde_json::json!(["main"]));
        assert_eq!(snap["ready"], serde_json::json!([]), "main hasn't called mark_ready yet");
        let head = &snap["queues"]["main"][0];
        assert_eq!(head["id"], 1);
        assert_eq!(head["delivered"], false);
        assert_eq!(head["path"], "/tmp/a.md");

        let actions = r.mark_ready("main");
        assert_eq!(
            actions,
            vec![RoutingAction::Deliver { label: "main".into(), id: 1, path: "/tmp/a.md".into() }]
        );
        let snap_after = r.qa_snapshot();
        assert_eq!(snap_after["ready"], serde_json::json!(["main"]));
        assert_eq!(snap_after["queues"]["main"][0]["delivered"], true);
    }

    // --- secondary invocation's argv reclassification, at the argv-slice level ---

    #[test]
    fn secondary_invocation_skips_argv0_and_never_opens_invalid() {
        // `cli::resolve_target` now rejects a missing path (`CliError::NotFound`)
        // instead of resolving it for on-launch creation, so a target that's
        // meant to prove *routing* behavior (argv0-skip, --right staying
        // Isolated) has to be a file that actually exists — otherwise a
        // `None` here would be ambiguous between "routed correctly and this
        // class doesn't open" and "rejected before routing even ran because
        // the file was missing". The missing-target case gets its own test,
        // `secondary_invocation_rejects_missing_target`, below.
        let dir = std::env::temp_dir()
            .join(format!("mermark_secondary_invocation_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "# hi").unwrap();
        let cwd = dir.clone();

        // argv[0] is the program path; skipping it means classification runs
        // on "--version" alone, landing on Headless -> no open.
        assert!(secondary_route_decision(&["mermark".to_string(), "--version".to_string()], &cwd)
            .is_none());
        // Isolated classes must never open via this path either.
        assert!(
            secondary_route_decision(&["mermark".to_string(), "-".to_string()], &cwd).is_none()
        );
        assert!(secondary_route_decision(
            &["mermark".to_string(), "--right".to_string(), "a.md".to_string()],
            &cwd
        )
        .is_none());
        // The one class that does open: an ordinary file.
        let decision =
            secondary_route_decision(&["mermark".to_string(), "a.md".to_string()], &cwd);
        assert!(matches!(decision, Some(SecondaryOpen::File(_))));
        // A bare launch (argv[0] only) resolves to FocusOnly, not a file open.
        let bare = secondary_route_decision(&["mermark".to_string()], &cwd);
        assert!(matches!(bare, Some(SecondaryOpen::FocusOnly)));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn secondary_invocation_rejects_missing_target() {
        // Sibling of the test above: a target that doesn't exist on disk is
        // rejected by `cli::resolve_target` as `CliError::NotFound`, and
        // that rejection must propagate all the way through
        // `secondary_route_decision` — which only ever matches
        // `Ok(LaunchClass::SingletonRouted(_))`, so any `Err` (NotFound
        // included) falls into its `_ => None` arm, the same as an invalid
        // or `Isolated` class. This locks down that the new "missing path is
        // an error, not a create-on-launch intent" rule reaches this layer,
        // not just `cli::resolve_target`'s own unit tests.
        let cwd = std::env::temp_dir();
        let decision = secondary_route_decision(
            &["mermark".to_string(), "definitely_missing_xyz.md".to_string()],
            &cwd,
        );
        assert!(decision.is_none());
    }
}
