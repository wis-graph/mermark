// native — Node-side half of the Todo 6 QA bridge protocol. Talks to
// src/qa/native-smoke-driver.ts running INSIDE the real debug webview (real
// @tauri-apps/api, real IPC — not a browser mock, not Playwright/CDP:
// WKWebView has no CDP). window-routing-smoke.mjs is the only caller: it
// starts one bridge, hands its URL+token to Vite as VITE_QA_BRIDGE, and uses
// `send(label, name, args)` to drive each live window's driver instance.
//
// Protocol (the SSOT this file and native-smoke-driver.ts both implement):
//   POST /register  { label }                       -> 204   (driver announces it's alive)
//   GET  /poll?label=X                               -> 200 { commandId, name, args }  |  204 (long-poll timeout, retry)
//   POST /result    { commandId, ok, value|error }   -> 204   (driver reports outcome)
// All requests carry `x-mermark-smoke-token`; a mismatch is 403. This file
// never terminates a request without responding — a bug here must not hang
// the driver's poll loop forever.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const JSON_HEADERS = {
  "Access-Control-Allow-Headers": "content-type, x-mermark-smoke-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Format a diagnostic when a `send()` never gets a /result in time — the
 *  design's "decisiveness over sleeps" rule: a timeout must say what it was
 *  waiting for, not just "timed out". Pure. */
function timeoutDiagnostic(label, name, args, recentEvents) {
  const tail = recentEvents.slice(-10).map((e) => JSON.stringify(e)).join("\n  ");
  return `qa bridge: no /result for ${name}(${JSON.stringify(args)}) addressed to "${label}" within the timeout.\nRecent bridge events:\n  ${tail}`;
}

export async function startQaDriverBridge({ token, longPollTimeoutMs = 25000, commandTimeoutMs = 20000 }) {
  const labelQueues = new Map(); // label -> BridgeCommandEnvelope[]
  const labelWaiters = new Map(); // label -> ((envelope) => void)[]  (parked /poll responders)
  const registered = new Set(); // labels that have called /register at least once
  const registerWaiters = new Map(); // label -> (() => void)[]
  const pending = new Map(); // commandId -> { resolve, reject, timer }
  const events = [];

  function deliverToLabel(label, envelope) {
    const waiters = labelWaiters.get(label);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift();
      next(envelope);
      return;
    }
    const queue = labelQueues.get(label) ?? [];
    queue.push(envelope);
    labelQueues.set(label, queue);
  }

  function markRegistered(label) {
    registered.add(label);
    const waiters = registerWaiters.get(label);
    if (waiters) {
      for (const resolve of waiters) resolve();
      registerWaiters.delete(label);
    }
  }

  /** Wait until `label`'s driver has called /register at least once — the
   *  harness uses this before addressing commands at a window it just
   *  opened, so `send()` never races a driver that hasn't booted yet. */
  function waitForLabel(label, timeoutMs = longPollTimeoutMs) {
    if (registered.has(label)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const list = registerWaiters.get(label) ?? [];
      const timer = setTimeout(() => {
        const idx = list.indexOf(wrapped);
        if (idx >= 0) list.splice(idx, 1);
        reject(new Error(`qa bridge: window label "${label}" never registered within ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = () => {
        clearTimeout(timer);
        resolve();
      };
      list.push(wrapped);
      registerWaiters.set(label, list);
    });
  }

  /** Address one command at `label`'s driver and await its result. Rejects
   *  (with a diagnostic dump of recent bridge traffic, never a bare
   *  "timeout") if no /result arrives within `timeoutMs`. */
  function send(label, name, args = {}, timeoutMs = commandTimeoutMs) {
    const commandId = randomBytes(9).toString("hex");
    const envelope = { commandId, name, args };
    events.push({ type: "send", label, name, args, commandId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(commandId);
        reject(new Error(timeoutDiagnostic(label, name, args, events)));
      }, timeoutMs);
      pending.set(commandId, { resolve, reject, timer });
      deliverToLabel(label, envelope);
    });
  }

  const server = createServer(async (request, response) => {
    Object.entries(JSON_HEADERS).forEach(([name, value]) => response.setHeader(name, value));
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers["x-mermark-smoke-token"] !== token) {
      response.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    try {
      if (request.method === "POST" && url.pathname === "/register") {
        const { label } = await bodyOf(request);
        if (!label) throw new Error("register: missing label");
        events.push({ type: "register", label });
        markRegistered(String(label));
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/poll") {
        const label = url.searchParams.get("label");
        if (!label) throw new Error("poll: missing label");
        const queue = labelQueues.get(label);
        if (queue && queue.length > 0) {
          const envelope = queue.shift();
          events.push({ type: "poll-hit", label, name: envelope.name, commandId: envelope.commandId });
          response.writeHead(200).end(JSON.stringify(envelope));
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const waiters = labelWaiters.get(label);
          if (waiters) {
            const idx = waiters.indexOf(onEnvelope);
            if (idx >= 0) waiters.splice(idx, 1);
          }
          response.writeHead(204).end();
        }, longPollTimeoutMs);
        const onEnvelope = (envelope) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          events.push({ type: "poll-hit", label, name: envelope.name, commandId: envelope.commandId });
          response.writeHead(200).end(JSON.stringify(envelope));
        };
        const waiters = labelWaiters.get(label) ?? [];
        waiters.push(onEnvelope);
        labelWaiters.set(label, waiters);
        // A `seedVault` reload (or window close) aborts this long-poll from
        // the client side — the TCP connection drops without a /poll retry
        // ever completing it. Without this, the stale waiter would still be
        // first in line for the next `send()`, which would hand a command
        // to a socket that's already closed (throwing inside writeHead) and
        // starve the label's real, freshly-reconnected poll loop. Removing
        // it on disconnect keeps `send()` always targeting a live listener.
        request.on("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const list = labelWaiters.get(label);
          if (list) {
            const idx = list.indexOf(onEnvelope);
            if (idx >= 0) list.splice(idx, 1);
          }
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/result") {
        const { commandId, ok, value, error } = await bodyOf(request);
        const entry = pending.get(commandId);
        events.push({ type: "result", commandId, ok });
        if (!entry) {
          // A result for an already-timed-out or unknown commandId is not
          // this server's fault to crash over — ack it and move on.
          response.writeHead(204).end();
          return;
        }
        pending.delete(commandId);
        clearTimeout(entry.timer);
        if (ok) entry.resolve(value);
        else entry.reject(new Error(String(error)));
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({ type: "bridge-error", message });
      response.writeHead(400).end(JSON.stringify({ error: message }));
    }
  });

  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("qa driver bridge did not bind TCP");

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    send,
    waitForLabel,
    isRegistered: (label) => registered.has(label),
    events,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        for (const [, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("qa bridge closing"));
        }
        pending.clear();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
