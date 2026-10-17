import { invoke } from "@tauri-apps/api/core";

/** Wire values of the Rust `ExternalApp` enum (closed set — the webview never
 *  names a program; Rust resolves it). */
export type ExternalAppTarget = "default" | "preview" | "browser";

export type OpenInExternalApp = (path: string, target: ExternalAppTarget) => Promise<void>;

/** Thin IPC wrapper over the `open_in_external_app` backend command. */
export const openInExternalApp: OpenInExternalApp = (path, target) =>
  invoke<void>("open_in_external_app", { path, target });
