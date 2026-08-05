import { describe, it, expect, vi } from "vitest";
import { createDontStackSlot } from "../src/chrome/viewer/dont-stack-slot";
import type { ViewerHandle } from "../src/chrome/viewer/registry";

// A ViewerHandle test double whose onClose registers listeners the way the
// real shell (shell.ts's onTeardown) does: multiple registrations, all run
// in order, close() is idempotent. `fireClose` lets a test simulate an
// Esc/✕ close arriving asynchronously (independent of `close()` itself), the
// same "closed without the opener initiating it" path this slot exists to
// survive.
function fakeHandle(): ViewerHandle & { fireClose(): void } {
  const listeners: (() => void)[] = [];
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const cb of listeners) cb();
  };
  return {
    close: () => fireClose(),
    onClose: (cb) => listeners.push(cb),
    fireClose,
  };
}

describe("createDontStackSlot (_workspace/04_audit_report_imgclick.md 🟢 — self-clear must not race a newer handle)", () => {
  it("open() assigns the slot and current() reflects it", () => {
    const slot = createDontStackSlot();
    const h = fakeHandle();
    const opener = vi.fn(() => h);
    const returned = slot.open(opener);
    expect(returned).toBe(h);
    expect(slot.current()).toBe(h);
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it("open() closes whatever the slot previously held before opening the new one", () => {
    const slot = createDontStackSlot();
    const a = fakeHandle();
    let aClosed = false;
    a.onClose(() => (aClosed = true));
    slot.open(() => a);

    const b = fakeHandle();
    slot.open(() => b);

    expect(aClosed).toBe(true);
    expect(slot.current()).toBe(b);
  });

  it("closing the CURRENT handle self-clears the slot to null", () => {
    const slot = createDontStackSlot();
    const h = fakeHandle();
    slot.open(() => h);
    h.fireClose(); // Esc/✕ — the opener never called close() itself
    expect(slot.current()).toBeNull();
  });

  it("a STALE handle's late close must NOT null out a newer occupant (the load-bearing regression guard)", () => {
    const slot = createDontStackSlot();
    const a = fakeHandle();
    slot.open(() => a);

    const b = fakeHandle();
    slot.open(() => b); // a.close() already ran as part of this; b is now current

    // Simulate a's onClose firing a second time / arriving late for any
    // reason — must be a no-op against the slot now that b occupies it.
    a.fireClose();
    expect(slot.current()).toBe(b);
  });

  it("closeAll() clears the slot unconditionally and closes the held handle", () => {
    const slot = createDontStackSlot();
    const h = fakeHandle();
    let closedViaHandle = false;
    h.onClose(() => (closedViaHandle = true));
    slot.open(() => h);

    slot.closeAll();

    expect(closedViaHandle).toBe(true);
    expect(slot.current()).toBeNull();
  });

  it("closeAll() on an empty slot is a no-op (doesn't throw)", () => {
    const slot = createDontStackSlot();
    expect(() => slot.closeAll()).not.toThrow();
    expect(slot.current()).toBeNull();
  });
});
