import { invoke } from "@tauri-apps/api/core";
import { mountEditor } from "./editor";
import "./styles.css";

async function boot() {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");
  if (!file) {
    root.textContent = "No file specified.";
    return;
  }
  try {
    const text = await invoke<string>("read_file", { path: file });
    root.innerHTML = "";
    mountEditor(root, text);
  } catch (e) {
    root.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
