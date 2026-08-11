import { describe, expect, it, vi } from "vitest";

type UnavailablePayload = { readonly kind: "deleted" | "unreadable"; readonly detail: string };
type EventHandler = (event: { readonly payload: UnavailablePayload }) => void;

let unavailableHandler: EventHandler | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: EventHandler) => {
    unavailableHandler = handler;
    return Promise.resolve(() => {});
  }),
}));

import { onFileUnavailable } from "../src/document/file-watch";

describe("file-unavailable watcher boundary", () => {
  it("delivers a deleted-path event to the recovery suspension seam", async () => {
    const received: UnavailablePayload[] = [];
    await onFileUnavailable((payload) => received.push(payload));

    unavailableHandler?.({ payload: { kind: "deleted", detail: "ENOENT: note.md" } });

    expect(received).toEqual([{ kind: "deleted", detail: "ENOENT: note.md" }]);
  });
});
