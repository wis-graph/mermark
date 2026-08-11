type CloseRequestedEvent = {
  readonly event: "tauri://close-requested";
  readonly id: number;
  preventDefault(): void;
};

type CloseRequestedHandler = (event: CloseRequestedEvent) => void | Promise<void>;

const closeHandlers = new Set<CloseRequestedHandler>();
let nextEventId = 1;

export const mockWindowState = { destroyed: false, closeRequests: 0 };

async function requestClose(): Promise<void> {
  let prevented = false;
  mockWindowState.closeRequests += 1;
  const event: CloseRequestedEvent = {
    event: "tauri://close-requested",
    id: nextEventId,
    preventDefault: () => { prevented = true; },
  };
  nextEventId += 1;
  for (const handler of closeHandlers) await handler(event);
  if (!prevented) mockWindowState.destroyed = true;
}

const currentWindow = {
  onCloseRequested(handler: CloseRequestedHandler): Promise<() => void> {
    closeHandlers.add(handler);
    return Promise.resolve(() => closeHandlers.delete(handler));
  },
  close: requestClose,
  destroy(): Promise<void> {
    mockWindowState.destroyed = true;
    return Promise.resolve();
  },
  minimize: () => Promise.resolve(),
  toggleMaximize: () => Promise.resolve(),
};

export function getCurrentWindow() {
  return currentWindow;
}

declare global {
  interface Window {
    __mockRequestClose?: () => Promise<void>;
    __mockWindowState?: typeof mockWindowState;
  }
}

window.__mockRequestClose = requestClose;
window.__mockWindowState = mockWindowState;
