// The viewer don't-stack slot (R11, _workspace/01_r11.md §5) as its own
// tiny state machine — extracted out of main.ts (2026-08-05 audit,
// _workspace/04_audit_report_imgclick.md 🟢) so its one non-obvious rule
// ("a stale close must not stomp a newer handle") can be locked with a unit
// test instead of living only inside main.ts's closure, where nothing could
// reach it. Same "extract the state machine as a tiny factory" shape as
// shell.ts's `makeZoomController` — only main.ts ever calls `createDontStackSlot`,
// and it's created exactly once at boot.
import type { ViewerHandle } from "./registry";

export interface DontStackSlot {
  /** Close whatever the slot currently holds, open a fresh viewer via
   *  `open()`, and store the result — the ONLY way a handle is ever ASSIGNED
   *  into the slot, so every caller (explorer/registered-extension opens,
   *  an in-document image click) shares one writer no matter how many of
   *  them exist. The returned handle self-clears the slot on close, but
   *  ONLY when it's still the CURRENT occupant — a close that arrives late
   *  for a handle a later `open()` already replaced must not null out the
   *  newer one. Command. */
  open(open: () => ViewerHandle): ViewerHandle;
  /** Close whatever is held and clear the slot unconditionally — "close
   *  everything, full stop" (e.g. a new document replacing the viewer pane
   *  outright), as opposed to a single handle's own conditional self-clear
   *  above. Command (void). */
  closeAll(): void;
  /** Whatever the slot currently holds, or `null` — what a "is a viewer
   *  open right now" guard (⌘F/⌥⌘F) should read. Pure query. */
  current(): ViewerHandle | null;
}

export function createDontStackSlot(): DontStackSlot {
  let handle: ViewerHandle | null = null;
  return {
    open(openFn) {
      handle?.close();
      const next = openFn();
      handle = next;
      next.onClose(() => {
        if (handle === next) handle = null;
      });
      return next;
    },
    closeAll() {
      handle?.close();
      handle = null;
    },
    current() {
      return handle;
    },
  };
}
