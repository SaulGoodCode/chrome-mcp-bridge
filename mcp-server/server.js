// Chrome MCP Bridge — MCP server
// Bridges MCP stdio clients (Claude Desktop, Trae, Cursor, etc.) to a Chrome
// extension connected via WebSocket.
//
// Architecture:
//   MCP client <stdio> this server <ws://127.0.0.1:8787> Chrome extension
//
// Each MCP tool call is forwarded to the extension as a JSON-RPC-like request
// and the response is awaited via a Promise keyed by request id.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import net from "node:net";

const WS_PORT = Number(process.env.MCP_WS_PORT || 8787);

// ---------- WebSocket server (extension connects here) ----------

let wss = null;
let extensionSocket = null;
const pending = new Map(); // id -> {resolve, reject, timer}
let shuttingDown = false;

function attachConnectionHandler(wss) {
  wss.on("connection", (socket, req) => {
    // Only allow localhost connections
    const ip = req.socket.remoteAddress;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      socket.close();
      return;
    }
    console.error(`[MCP] Extension connected from ${ip}`);
    extensionSocket = socket;

    socket.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "hello") {
        console.error(`[MCP] Hello from extension v${msg.version}`);
        return;
      }
      if (msg.type === "ping") return; // keepalive
      // Allow a new MCP server instance to request shutdown of this old instance
      // so that it can take over the port (handled in startServer()).
      if (msg.type === "shutdown") {
        console.error(`[MCP] Shutdown requested by new instance: ${msg.reason || "unknown"}`);
        try { socket.send(JSON.stringify({ type: "shutdown_ack" })); } catch {}
        shuttingDown = true;
        // Reject all pending requests so the AI client gets errors instead of hangs
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Server shutting down (replaced by new instance)"));
          pending.delete(id);
        }
        try { extensionSocket.close(); } catch {}
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (msg.type === "response") {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "Extension error"));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === "event") {
        // Forward notable events to stderr (MCP logs go to stderr; stdout is reserved for protocol)
        console.error(`[MCP] Event: ${JSON.stringify(msg.event)}`);
      }
    });

    socket.on("close", () => {
      console.error("[MCP] Extension disconnected");
      if (extensionSocket === socket) extensionSocket = null;
      if (shuttingDown) return;
      // Reject all pending
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Extension disconnected"));
        pending.delete(id);
      }
    });
  });
}

function sendToExtension(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      reject(new Error("Chrome extension not connected. Open Chrome and click the extension icon to connect."));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ type: "request", id, method, params: params || {} }));
  });
}

// ---------- MCP tool definitions ----------

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
  }
];

// ---------- MCP server setup ----------

const server = new Server(
  { name: "chrome-mcp-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  try {
    // wait_for may need longer than 30s — use the user's timeout + 2s buffer.
    const rpcTimeout = name === "chrome_wait_for"
      ? Math.max(30000, (args.timeout || 10000) + 2000)
      : 30000;
    const result = await sendToExtension(method, params, rpcTimeout);
    // For screenshot, return as image content
    if (name === "chrome_screenshot" && result?.image) {
      const base64 = String(result.image).replace(/^data:image\/png;base64,/, "");
      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" }
        ]
      };
    }
    // Default: return as JSON text
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) }
      ]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err.message}` }]
    };
  }
});

// ---------- Start ----------

// Probe whether a TCP port is already in use on 127.0.0.1.
// Resolves true if something is listening, false otherwise.
function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (err) => resolve(err.code === "EADDRINUSE"));
    tester.once("listening", () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, "127.0.0.1");
  });
}

// Try to gracefully shut down a previous instance of ourselves that may still
// be holding the WebSocket port. We connect as a plain WebSocket client and
// send a "shutdown" message; the existing server's message handler will
// close all sockets and exit(0) on receipt.
// Returns true if a shutdown_ack was received, false otherwise.
function shutdownExistingInstance(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      if (!ok) console.error(`[MCP] shutdown client gave up: ${reason}`);
      resolve(ok);
    };
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => finish(false, "timeout after 3s"), 3000);
    client.on("open", () => {
      console.error("[MCP] Connected to existing instance, sending shutdown...");
      try {
        client.send(JSON.stringify({
          type: "shutdown",
          reason: "new_instance_starting",
          ts: Date.now()
        }));
      } catch (e) {
        finish(false, `send failed: ${e.message}`);
      }
    });
    client.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "shutdown_ack") {
        clearTimeout(timer);
        console.error("[MCP] Shutdown acknowledged by previous instance.");
        // Give the old process a moment to release the port
        setTimeout(() => finish(true, "ack"), 300);
      }
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      finish(false, `ws error: ${err.message}`);
    });
    client.on("unexpected-response", (req, res) => {
      clearTimeout(timer);
      finish(false, `unexpected HTTP ${res.statusCode}`);
    });
  });
}

// Wait until the port is free, polling up to `attempts` times.
async function waitForPortFree(port, attempts = 20, intervalMs = 100) {
  for (let i = 0; i < attempts; i++) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function startServer() {
  // If the port is already in use, try to negotiate a graceful shutdown of
  // the previous instance. This handles the common case of an AI client
  // (Trae/Cursor/etc.) toggling the MCP server off and on without properly
  // SIGTERM-ing the previous subprocess — the orphaned server keeps the port.
  if (await isPortInUse(WS_PORT)) {
    console.error(`[MCP] Port ${WS_PORT} is in use — attempting graceful takeover...`);
    const acked = await shutdownExistingInstance(WS_PORT);
    if (acked) {
      console.error("[MCP] Previous instance acknowledged shutdown. Waiting for port release...");
    } else {
      console.error("[MCP] Previous instance did not respond to shutdown. It may be a non-MCP process.");
    }
    const freed = await waitForPortFree(WS_PORT, 30, 100);
    if (!freed) {
      console.error(`[MCP] ERROR: Port ${WS_PORT} still in use after 3s.`);
      console.error("[MCP] Hint: find and kill the process holding the port:");
      console.error(`[MCP]   netstat -ano | findstr :${WS_PORT}`);
      console.error("[MCP]   taskkill /F /PID <pid>");
      process.exit(1);
    }
    console.error(`[MCP] Port ${WS_PORT} is now free.`);
  }

  // Create the WebSocketServer now that the port is available.
  wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
  attachConnectionHandler(wss);

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[MCP] FATAL: Port ${WS_PORT} became busy between probe and listen.`);
      console.error("[MCP] This is a race condition; please restart the MCP server.");
      process.exit(1);
    } else {
      console.error("[MCP] WebSocket server error:", err.message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[MCP] Server listening on stdio. WebSocket on ws://127.0.0.1:${WS_PORT}`);
  console.error("[MCP] Waiting for Chrome extension to connect...");

  // CRITICAL: When the AI client (Trae/Cursor/etc.) closes the MCP server
  // toggle, it closes our stdin pipe but does NOT send SIGTERM on Windows.
  // Node.js does NOT exit on stdin close by default, so the orphaned process
  // would keep holding the WebSocket port forever, causing EADDRINUSE on the
  // next start. Force-exit when stdin closes.
  process.stdin.on("end", () => {
    console.error("[MCP] stdin closed — AI client disconnected. Shutting down.");
    shuttingDown = true;
    try { if (extensionSocket) extensionSocket.close(); } catch {}
    try { if (wss) wss.close(); } catch {}
    setTimeout(() => process.exit(0), 200);
  });
  process.stdin.on("error", (err) => {
    console.error("[MCP] stdin error:", err.message);
  });
}

await startServer();

// Handle stop_requested events from extension (forwarded as warnings via stderr).
// A real cancellation would require MCP server support for cancellation notifications,
// which is left as a future enhancement.
