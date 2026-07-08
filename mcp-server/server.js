// Chrome MCP Bridge — MCP server (daemon + proxy architecture)
//
// Supports multiple AI clients switching seamlessly without killing each other.
//
// Architecture:
//   AI client A <stdio> proxy A ─┐
//   AI client B <stdio> proxy B ─┼─ws:8788→ daemon ─ws:8787→ Chrome extension
//   AI client C <stdio> proxy C ─┘
//
// - proxy mode (default): launched by AI client via stdio, forwards to daemon
// - daemon mode (--daemon): persistent, owns extension connection, routes requests
// - proxy auto-forks daemon on first start if not running
// - daemon auto-exits after 5 min idle (no proxies connected)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WS_EXT_PORT = Number(process.env.MCP_WS_PORT || 8787);   // extension → daemon
const WS_PROXY_PORT = Number(process.env.MCP_PROXY_PORT || 8788); // proxy → daemon
const DAEMON_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min no proxies → exit
const DAEMON_LOG = join(__dirname, "daemon.log");

const isDaemon = process.argv.includes("--daemon");

// ---------- Logging ----------

function log(...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${args.join(" ")}\n`;
  if (isDaemon) {
    try { appendFileSync(DAEMON_LOG, line); } catch {}
  } else {
    process.stderr.write(line);
  }
}

// ---------- Tool definitions (shared: proxy for ListTools, daemon for reference) ----------

const TOOLS = [
  {
    name: "chrome_navigate",
    description: "Navigate the active tab to a URL. Waits for the page to load.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL including protocol (https://...)" } },
      required: ["url"]
    }
  },
  {
    name: "chrome_get_tree",
    description:
      "Return a structured text tree of interactive elements on the active page. " +
      "Each element gets a stable ref_id (e.g. ref_3) for use in click/fill/scroll. " +
      "If output is truncated, narrow down by passing refId to inspect a subtree, " +
      "or use `selector` to restrict the walk to descendants of elements matching a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["interactive", "all"], default: "interactive" },
        maxDepth: { type: "number", default: 15 },
        maxChars: { type: "number", default: 50000 },
        refId: { type: "string", description: "Optional: build subtree rooted at this ref" },
        selector: { type: "string", description: "Optional CSS selector; walk subtrees of matching elements only (e.g. \"nav.main\", \"#form-section\")" }
      }
    }
  },
  {
    name: "chrome_get_text",
    description: "Extract the main text content of the active page.",
    inputSchema: {
      type: "object",
      properties: { maxChars: { type: "number", default: 50000 } }
    }
  },
  {
    name: "chrome_click",
    description: "Click the element identified by ref_id (obtained from chrome_get_tree or chrome_search).",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "Element ref_id, e.g. ref_3" } },
      required: ["ref"]
    }
  },
  {
    name: "chrome_fill",
    description: "Fill a form field identified by ref_id with the given value. " +
      "Supports input/textarea/select/checkbox/radio/contenteditable and bypasses React/Vue controlled inputs.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string", description: "Value to set. For checkbox/radio pass 'true'/'false'." }
      },
      required: ["ref", "value"]
    }
  },
  {
    name: "chrome_scroll",
    description: "Scroll the page. Either to a ref_id element or to absolute x/y coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "If set, scroll to this element (overrides x/y)" },
        x: { type: "number" },
        y: { type: "number" }
      }
    }
  },
  {
    name: "chrome_search",
    description: "Search interactive elements by keyword. Returns ranked matches with ref_ids. " +
      "Pass `role` to restrict matches to a specific ARIA role (e.g. \"button\", \"textbox\", \"link\", \"checkbox\").",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (space-separated). Required unless role is set." },
        role: { type: "string", description: "Optional ARIA role filter (button|textbox|link|checkbox|radio|combobox|...)." },
        maxResults: { type: "number", default: 20 }
      },
      required: []
    }
  },
  {
    name: "chrome_screenshot",
    description:
      "Capture a PNG screenshot. By default the whole visible viewport is captured. " +
      "Pass `ref` to capture only a specific element (cropped to its bounding box) — useful when you need fine detail " +
      "without spending tokens on the entire page.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Optional ref_id of the element to crop the screenshot to." }
      }
    }
  },
  {
    name: "chrome_list_tabs",
    description: "List all open browser tabs with their ids, titles and URLs.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_new_tab",
    description: "Open a new tab. Optionally navigate to a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } }
    }
  },
  {
    name: "chrome_close_tab",
    description: "Close a tab by its id.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"]
    }
  },
  {
    name: "chrome_activate_tab",
    description: "Activate (focus) a tab by its id. Subsequent page operations target the active tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"]
    }
  },
  {
    name: "chrome_upload_file",
    description:
      "Upload one or more local files to an <input type=\"file\"> on the active page. " +
      "Uses CDP (chrome.debugger) under the hood. The tab will briefly show a 'debugging this tab' banner — that's expected. " +
      "Pass ref from chrome_get_tree that points at the file input; if omitted, the first visible file input is used.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "ref_id of the <input type=file> element (from chrome_get_tree). Optional — if omitted, first file input on page is used."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of absolute local file paths, e.g. [\"C:/Users/me/Pictures/cat.png\"]. The browser process opens them directly.",
          minItems: 1
        }
      },
      required: ["files"]
    }
  },
  {
    name: "chrome_highlight",
    description:
      "Highlight an element with a pulsing border. Useful for debugging — lets the user see which element the agent is about to operate on. " +
      "The highlight stays until cleared, navigating away, or another highlight is set. " +
      "Repositions automatically on page scroll/resize.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref_id (from chrome_get_tree or chrome_search)" }
      },
      required: ["ref"]
    }
  },
  {
    name: "chrome_clear_highlight",
    description: "Remove any active highlight previously set by chrome_highlight.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_get_attributes",
    description:
      "Return the actual values of a single element identified by ref_id. " +
      "Use this to verify form state after a fill/click — get_tree only shows placeholders and roles, " +
      "this returns value, checked, href, src, aria-*, data-*, selectedOptions, rect, etc. " +
      "Indispensable for assertions like \"did the radio get selected?\" or \"what did the textbox end up containing?\".",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref_id, e.g. ref_3" }
      },
      required: ["ref"]
    }
  },
  {
    name: "chrome_press_key",
    description:
      "Simulate a keyboard event on an element (or on the currently focused element if ref is omitted). " +
      "Dispatches keydown + keypress + keyup. Essential for SPAs that listen for Enter (submit), Escape (close), " +
      "Tab (focus move), Arrow keys (dropdown navigation), Typeahead/Autocomplete widgets, etc. " +
      "Use after chrome_fill to submit a form without clicking a button.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Optional ref_id of the element to focus before pressing. If omitted, uses document.activeElement." },
        key: {
          type: "string",
          description: "Key name, e.g. \"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"a\", \" \", \"Backspace\""
        },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["ctrl", "shift", "alt", "meta"] },
          description: "Optional modifier keys to hold during the press."
        }
      },
      required: ["key"]
    }
  },
  {
    name: "chrome_hover",
    description:
      "Simulate a mouse hover (mouseover + mouseenter + mousemove) on an element. " +
      "Use this to trigger hover-only UI like dropdown menus, tooltips, and context help that don't respond to click.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref_id, e.g. ref_3" }
      },
      required: ["ref"]
    }
  },
  {
    name: "chrome_wait_for",
    description:
      "Wait for a condition to be met on the page, then return. " +
      "Solves the classic SPA problem of acting before the page is ready — no more brittle sleeps. " +
      "Supports 5 condition types (pass exactly one):\n" +
      "  1. ref + state=\"visible\" (default) — wait for ref_id element to be visible.\n" +
      "  2. ref + state=\"hidden\" — wait for ref_id element to disappear/become hidden.\n" +
      "  3. selector + countOp + countValue — wait until document.querySelectorAll(selector).length matches countOp (\"==\", \">=\", \"<=\", \">\") against countValue.\n" +
      "  4. text (+ optional selector scope) — wait until the textContent of the scope (default document.body) contains the given substring.\n" +
      "  5. networkIdleMs — wait until at least this many ms have elapsed since the last network resource request completed.\n" +
      "All conditions use a default timeout of 10000ms (configurable). On timeout returns { success: false, timedOut: true }.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Optional ref_id to wait for (use with state)." },
        state: { type: "string", enum: ["visible", "hidden"], default: "visible", description: "Whether to wait for ref to appear (visible) or disappear (hidden)." },
        selector: { type: "string", description: "CSS selector for count-based or text-scoped conditions." },
        countOp: { type: "string", enum: ["==", ">=", "<=", ">"], description: "Comparison operator for selector count condition." },
        countValue: { type: "number", description: "Target count to compare against." },
        text: { type: "string", description: "Substring to search for in the scope's textContent." },
        networkIdleMs: { type: "number", description: "Wait for at least N ms of no network activity." },
        timeout: { type: "number", default: 10000, description: "Overall timeout in milliseconds." },
        pollInterval: { type: "number", default: 100, description: "Polling interval in milliseconds." }
      }
    }
  },
  {
    name: "chrome_get_network_log",
    description:
      "Return recent XHR/fetch requests from the page's network activity log. " +
      "By default returns the last 10 entries as compact paths (e.g. '/api/v1/users' instead of full URLs) " +
      "to save tokens. Use sinceLastCall=true to only get NEW requests since the previous call (best for " +
      "checking 'what happened after my last click'). Use urlPattern to filter by URL substring/regex. " +
      "Entries: type, method, url (path by default), status, duration(ms), error.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Max entries to return (default 10, max 200). Ignored when sinceLastCall=true." },
        sinceLastCall: { type: "boolean", default: false, description: "Only return requests that arrived AFTER the previous get_network_log call. Saves tokens — second call typically returns 0-3 new entries." },
        urlPattern: { type: "string", description: "Filter by URL substring or regex (e.g. 'api/orders' or 'POST'). Matches against full URL." },
        fullUrl: { type: "boolean", default: false, description: "Return full URLs instead of paths (default: path only to save tokens)." }
      }
    }
  },
  {
    name: "chrome_wait_for_request",
    description:
      "Wait until a specific XHR/fetch request matching urlPattern completes (returns with status). " +
      "urlPattern can be a plain substring or a regex pattern (e.g. 'api/orders' or '^https://api\\.example\\.com/.*'). " +
      "Optionally filter by HTTP method. Returns the matched request entry with status/duration, or {ok:false} on timeout.",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "Substring or regex to match against request URLs." },
        method: { type: "string", description: "Optional HTTP method filter (GET/POST/PUT/DELETE/PATCH, case-insensitive)." },
        timeout: { type: "number", default: 15000, description: "Timeout in milliseconds (default 15s, max 60s)." },
        pollInterval: { type: "number", default: 100, description: "Poll interval in milliseconds." }
      },
      required: ["urlPattern"]
    }
  }
];

// ---------- Tool call mapping (daemon uses this to translate tool name → extension method) ----------

function mapToolCall(name, args = {}) {
  let method, params;
  switch (name) {
    case "chrome_navigate":       method = "navigate";       params = { url: args.url }; break;
    case "chrome_get_tree":       method = "get_tree";        params = { mode: args.mode, maxDepth: args.maxDepth, maxChars: args.maxChars, refId: args.refId, selector: args.selector }; break;
    case "chrome_get_text":       method = "get_text";        params = { maxChars: args.maxChars }; break;
    case "chrome_click":          method = "click";           params = { ref: args.ref }; break;
    case "chrome_fill":           method = "fill";            params = { ref: args.ref, value: args.value }; break;
    case "chrome_scroll":         method = "scroll";          params = { ref: args.ref, x: args.x, y: args.y }; break;
    case "chrome_search":         method = "search";          params = { query: args.query, maxResults: args.maxResults, role: args.role }; break;
    case "chrome_screenshot":     method = "screenshot";      params = { ref: args.ref }; break;
    case "chrome_list_tabs":      method = "list_tabs";       params = {}; break;
    case "chrome_new_tab":        method = "new_tab";         params = { url: args.url }; break;
    case "chrome_close_tab":      method = "close_tab";       params = { tabId: args.tabId }; break;
    case "chrome_activate_tab":   method = "activate_tab";    params = { tabId: args.tabId }; break;
    case "chrome_upload_file":    method = "upload_file";     params = { ref: args.ref, files: args.files }; break;
    case "chrome_highlight":      method = "highlight";       params = { ref: args.ref }; break;
    case "chrome_clear_highlight": method = "clear_highlight"; params = {}; break;
    case "chrome_get_attributes": method = "get_attributes";  params = { ref: args.ref }; break;
    case "chrome_press_key":      method = "press_key";       params = { ref: args.ref, key: args.key, modifiers: args.modifiers }; break;
    case "chrome_hover":          method = "hover";           params = { ref: args.ref }; break;
    case "chrome_wait_for":       method = "wait_for";        params = {
      ref: args.ref,
      state: args.state,
      selector: args.selector,
      countOp: args.countOp,
      countValue: args.countValue,
      text: args.text,
      networkIdleMs: args.networkIdleMs,
      timeout: args.timeout,
      pollInterval: args.pollInterval
    }; break;
    case "chrome_get_network_log": method = "get_network_log"; params = {
      count: args.count,
      sinceLastCall: args.sinceLastCall,
      urlPattern: args.urlPattern,
      fullUrl: args.fullUrl
    }; break;
    case "chrome_wait_for_request": method = "wait_for_request"; params = {
      urlPattern: args.urlPattern,
      method: args.method,
      timeout: args.timeout,
      pollInterval: args.pollInterval
    }; break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  const rpcTimeout = (name === "chrome_wait_for" || name === "chrome_wait_for_request")
    ? Math.max(30000, (args.timeout || (name === "chrome_wait_for_request" ? 15000 : 10000)) + 2000)
    : 30000;
  return { method, params, rpcTimeout };
}

// ---------- Build MCP response content from daemon result ----------

function buildMcpResponse(name, result) {
  if (name === "chrome_screenshot" && result?.image) {
    const base64 = String(result.image).replace(/^data:image\/png;base64,/, "");
    return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

// =====================================================================
// PROXY MODE (default — launched by AI client via stdio)
// =====================================================================

async function runProxy() {
  let daemonWs = null;
  const pending = new Map(); // id -> {resolve, reject, timer}

  // Try connecting to daemon; if not running, fork it.
  async function ensureDaemon() {
    // Try connecting first (daemon might already be running)
    for (let i = 0; i < 3; i++) {
      try {
        daemonWs = await connectDaemon();
        log("[Proxy] Connected to existing daemon.");
        return;
      } catch {
        // daemon not running, will fork below
      }
    }

    // Fork daemon
    log("[Proxy] Daemon not running, forking...");
    const child = spawn(process.execPath, [__filename, "--daemon"], {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
      env: { ...process.env },
    });
    child.unref();
    log(`[Proxy] Forked daemon PID ${child.pid}. Waiting for it to start...`);

    // Wait for daemon to start listening, then connect
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        daemonWs = await connectDaemon();
        log("[Proxy] Connected to newly forked daemon.");
        return;
      } catch {
        // keep retrying
      }
    }
    throw new Error("Failed to connect to daemon after forking. Check daemon.log for errors.");
  }

  function connectDaemon() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${WS_PROXY_PORT}`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("connect timeout"));
      }, 1000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Forward a tool call to daemon and await response
  function sendToDaemon(name, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!daemonWs || daemonWs.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to daemon"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Daemon request timed out after ${timeoutMs}ms: ${name}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      daemonWs.send(JSON.stringify({ type: "request", id, name, args }));
    });
  }

  await ensureDaemon();

  // Handle daemon messages
  daemonWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg.result);
      return;
    }
    if (msg.type === "error") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.reject(new Error(msg.error));
      return;
    }
    if (msg.type === "warning") {
      // Forward warnings to stderr (AI client may surface them)
      log(`[Proxy] Warning from daemon: ${msg.msg}`);
    }
  });

  daemonWs.on("close", () => {
    log("[Proxy] Daemon connection closed.");
    // Reject all pending requests
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Daemon connection lost"));
      pending.delete(id);
    }
  });

  daemonWs.on("error", (err) => {
    log(`[Proxy] Daemon WebSocket error: ${err.message}`);
  });

  // MCP server setup
  const server = new Server(
    { name: "chrome-mcp-bridge", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      // Use a generous timeout: wait_for tools may need up to 60s
      const { rpcTimeout } = mapToolCall(name, args);
      const result = await sendToDaemon(name, args, rpcTimeout);
      return buildMcpResponse(name, result);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("[Proxy] MCP server listening on stdio. Forwarding to daemon.");

  // When AI client disconnects (closes stdin), clean up
  process.stdin.on("end", () => {
    log("[Proxy] stdin closed — AI client disconnected.");
    try { if (daemonWs) daemonWs.close(); } catch {}
    setTimeout(() => process.exit(0), 100);
  });
  process.stdin.on("error", (err) => {
    log(`[Proxy] stdin error: ${err.message}`);
  });
}

// =====================================================================
// DAEMON MODE (--daemon flag, persistent background process)
// =====================================================================

async function runDaemon() {
  // Truncate log file on start
  try { writeFileSync(DAEMON_LOG, `Daemon starting at ${new Date().toISOString()}\n`); } catch {}

  let extensionSocket = null;
  const proxies = new Set();        // Set<WebSocket> of connected proxies
  const extPending = new Map();      // extRequestId -> {resolve, reject, timer, proxyWs, proxyReqId}
  let lastActivity = Date.now();
  let idleCheckTimer = null;

  function touchActivity() {
    lastActivity = Date.now();
  }

  function scheduleIdleCheck() {
    if (idleCheckTimer) clearTimeout(idleCheckTimer);
    idleCheckTimer = setTimeout(() => {
      if (proxies.size === 0 && extPending.size === 0) {
        const idleMs = Date.now() - lastActivity;
        if (idleMs > DAEMON_IDLE_TIMEOUT_MS) {
          log(`[Daemon] Idle for ${Math.round(idleMs / 1000)}s with no proxies. Exiting.`);
          try { if (extensionSocket) extensionSocket.close(); } catch {}
          process.exit(0);
        }
      }
      scheduleIdleCheck();
    }, 30000);
  }

  // ---------- Send request to extension ----------
  function sendToExtension(method, params, timeoutMs, proxyWs, proxyReqId) {
    return new Promise((resolve, reject) => {
      if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
        reject(new Error("Chrome extension not connected. Open Chrome and click the extension icon to connect."));
        return;
      }
      const extId = randomUUID();
      const timer = setTimeout(() => {
        extPending.delete(extId);
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      extPending.set(extId, { resolve, reject, timer, proxyWs, proxyReqId });
      extensionSocket.send(JSON.stringify({ type: "request", id: extId, method, params: params || {} }));
    });
  }

  // ---------- Extension WebSocket server (port 8787) ----------
  const extWss = new WebSocketServer({ port: WS_EXT_PORT, host: "127.0.0.1" });
  log(`[Daemon] Extension WS server listening on ws://127.0.0.1:${WS_EXT_PORT}`);

  extWss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      socket.close();
      return;
    }
    log(`[Daemon] Extension connected from ${ip}`);
    extensionSocket = socket;
    touchActivity();

    socket.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "hello") {
        log(`[Daemon] Hello from extension v${msg.version}`);
        return;
      }
      if (msg.type === "ping") return;
      if (msg.type === "response") {
        const p = extPending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        extPending.delete(msg.id);
        touchActivity();
        if (msg.error) {
          p.reject(new Error(msg.error.message || "Extension error"));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (msg.type === "event") {
        log(`[Daemon] Event: ${JSON.stringify(msg.event)}`);
      }
    });

    socket.on("close", () => {
      log("[Daemon] Extension disconnected");
      if (extensionSocket === socket) extensionSocket = null;
      // Reject all pending extension requests
      for (const [id, p] of extPending) {
        clearTimeout(p.timer);
        p.reject(new Error("Extension disconnected"));
        extPending.delete(id);
      }
      touchActivity();
    });
  });

  extWss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`[Daemon] FATAL: Port ${WS_EXT_PORT} already in use. Another daemon may be running.`);
      log(`[Daemon] Hint: netstat -ano | findstr :${WS_EXT_PORT}`);
      process.exit(1);
    } else {
      log(`[Daemon] Extension WS error: ${err.message}`);
    }
  });

  // ---------- Proxy WebSocket server (port 8788) ----------
  const proxyWss = new WebSocketServer({ port: WS_PROXY_PORT, host: "127.0.0.1" });
  log(`[Daemon] Proxy WS server listening on ws://127.0.0.1:${WS_PROXY_PORT}`);

  proxyWss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      socket.close();
      return;
    }
    log(`[Daemon] Proxy connected from ${ip}`);
    proxies.add(socket);
    touchActivity();

    socket.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== "request") return;

      const { id: proxyReqId, name, args } = msg;
      touchActivity();

      try {
        const { method, params, rpcTimeout } = mapToolCall(name, args);
        const result = await sendToExtension(method, params, rpcTimeout, socket, proxyReqId);
        try {
          socket.send(JSON.stringify({ type: "response", id: proxyReqId, result }));
        } catch {}
      } catch (err) {
        try {
          socket.send(JSON.stringify({ type: "error", id: proxyReqId, error: err.message }));
        } catch {}
      }
    });

    socket.on("close", () => {
      log("[Daemon] Proxy disconnected");
      proxies.delete(socket);
      // Reject pending requests from this proxy
      for (const [extId, p] of extPending) {
        if (p.proxyWs === socket) {
          clearTimeout(p.timer);
          p.reject(new Error("Proxy disconnected"));
          extPending.delete(extId);
        }
      }
      touchActivity();
    });

    socket.on("error", (err) => {
      log(`[Daemon] Proxy WS error: ${err.message}`);
    });
  });

  proxyWss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`[Daemon] FATAL: Proxy port ${WS_PROXY_PORT} already in use. Another daemon may be running.`);
      process.exit(1);
    } else {
      log(`[Daemon] Proxy WS error: ${err.message}`);
    }
  });

  scheduleIdleCheck();
  log("[Daemon] Waiting for Chrome extension and proxies to connect...");
}

// =====================================================================
// Main
// =====================================================================

if (isDaemon) {
  runDaemon().catch((err) => {
    log(`[Daemon] Fatal: ${err.message}`);
    process.exit(1);
  });
} else {
  runProxy().catch((err) => {
    log(`[Proxy] Fatal: ${err.message}`);
    process.exit(1);
  });
}
