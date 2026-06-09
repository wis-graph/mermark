import { invoke } from "@tauri-apps/api/core";
import { mountEditor } from "./editor";
import "katex/dist/katex.min.css";
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
    const baseDir = file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
    mountEditor(root, text, baseDir);
  } catch (e) {
    root.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
