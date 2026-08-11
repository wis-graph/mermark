import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";

const JSON_HEADERS = {
  "Access-Control-Allow-Headers": "content-type, x-mermark-smoke-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function withinRoots(path, roots) {
  const candidate = resolve(path);
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function invoke(command, args, roots, state, faults) {
  const rawPath = String(args.path ?? "");
  const path = rawPath ? resolve(rawPath) : "";
  const faultKey = `${command}\0${path}`;
  const fault = faults.get(faultKey);
  if (fault) {
    faults.delete(faultKey);
    throw new Error(fault);
  }
  if (command !== "unwatch_file" && (!isAbsolute(path) || !withinRoots(path, roots))) {
    throw new Error(`path outside smoke roots: ${path}`);
  }
  switch (command) {
    case "read_file": {
      const info = await stat(path);
      return { text: await readFile(path, "utf8"), mtime: Math.trunc(info.mtimeMs) };
    }
    case "write_file": {
      const baseline = Number(args.baseline ?? 0);
      if (baseline !== 0) {
        const current = await stat(path);
        if (Math.trunc(current.mtimeMs) > baseline) throw new Error("CONFLICT: smoke fixture changed on disk");
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.mermark-smoke-tmp`;
      await writeFile(temporary, String(args.text ?? ""), "utf8");
      await rename(temporary, path);
      return Math.trunc((await stat(path)).mtimeMs);
    }
    case "list_dir": {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => args.showHidden === true || !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, path: join(path, entry.name), is_dir: entry.isDirectory() }))
        .sort((left, right) => Number(right.is_dir) - Number(left.is_dir) || left.name.localeCompare(right.name));
    }
    case "canonicalize_path":
      return normalize(path);
    case "directory_exists":
      return (await stat(path)).isDirectory();
    case "path_exists":
      await stat(path);
      return true;
    case "watch_file":
      state.watchedPath = path;
      state.maxWatcherCount = Math.max(state.maxWatcherCount, 1);
      return null;
    case "unwatch_file":
      state.watchedPath = null;
      return null;
    default:
      throw new Error(`unsupported smoke command: ${command}`);
  }
}

export async function startWorkspaceSmokeBridge({ roots, token, events }) {
  const normalizedRoots = roots.map((root) => resolve(root));
  const faults = new Map();
  const state = { watchedPath: null, maxWatcherCount: 0 };
  const server = createServer(async (request, response) => {
    Object.entries(JSON_HEADERS).forEach(([name, value]) => response.setHeader(name, value));
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || request.headers["x-mermark-smoke-token"] !== token) {
      response.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    try {
      const payload = await bodyOf(request);
      const command = String(payload.command ?? "");
      const value = await invoke(command, payload.args ?? {}, normalizedRoots, state, faults);
      events.push({ type: "bridge", command: payload.command, path: payload.args?.path ?? null });
      response.writeHead(200).end(JSON.stringify(value));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({ type: "bridge-error", message });
      response.writeHead(409).end(message);
    }
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("smoke bridge did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}`,
    failNext(command, path, message) {
      faults.set(`${command}\0${path ? resolve(path) : ""}`, message);
    },
    snapshot: () => ({ ...state }),
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

export function isEditableSmokeFile(path) {
  return [".md", ".txt"].includes(extname(path).toLowerCase());
}
