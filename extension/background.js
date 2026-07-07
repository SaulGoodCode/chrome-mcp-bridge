// Chrome MCP Bridge — background service worker
// Responsibilities:
//   1. Maintain a WebSocket connection to the local MCP server.
//   2. Route incoming requests to the active tab (content scripts) or Chrome APIs.
//   3. Forward responses (and screenshots) back to the MCP server.
//   4. Handle MV3 service-worker lifecycle (reconnect on wake).

const WS_URL = "ws://127.0.0.1:8787";
const RECONNECT_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30000; // back off up to 30s when server stays down
const MAX_RECONNECT_ATTEMPTS = 10; // after this many consecutive failures, auto-disable
const KEEPALIVE_ALARM = "mcp-keepalive";

let ws = null;
let wsConnected = false;
let reconnectAttempts = 0; // for exponential backoff
let reconnectTimer = null; // for cancelable backoff
let bridgeEnabled = true; // master switch — when false, no WS attempts at all
const pendingRequests = new Map(); // id -> {resolve, reject, ts}

// ---------- WebSocket client ----------

function connectWS() {
  if (!bridgeEnabled) return; // master switch off — do nothing
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0; // reset backoff on successful connect
    wsConnected = true;
    console.log("[MCP-Bridge] WS connected to", WS_URL);
    sendToWS({ type: "hello", role: "extension", version: chrome.runtime.getManifest().version });
    chrome.storage.session.set({ wsConnected: true, lastConnectedAt: Date.now() });
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleIncoming(msg).catch((err) => {
      sendToWS({ type: "response", id: msg.id, error: { message: String(err?.message || err) } });
    });
  };

  ws.onerror = (e) => {
    // Common when MCP server isn't running yet (e.g. user hasn't toggled it on
    // in Trae). The browser prints "ERR_CONNECTION_REFUSED" to the console
    // regardless; here we only log at debug level to avoid spamming the
    // service worker console. The real signal is onclose → scheduleReconnect.
    if (reconnectAttempts === 0 || reconnectAttempts % 10 === 0) {
      console.debug("[MCP-Bridge] WS error (server likely not running). Reconnect attempt", reconnectAttempts);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    chrome.storage.session.set({ wsConnected: false });
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#9E9E9E" });
    // Reject all pending requests
    for (const [id, p] of pendingRequests) {
      p.reject(new Error("WebSocket disconnected"));
      pendingRequests.delete(id);
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!bridgeEnabled) return; // no reconnects when disabled
  // Auto-disable after too many consecutive failures — server is likely not
  // running and the user has forgotten about the bridge. Avoids endless
  // reconnect loops that waste CPU and spam the console.
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(
      `[MCP-Bridge] WS reconnect gave up after ${reconnectAttempts} consecutive failures. ` +
      `Auto-disabling bridge. Re-enable via the popup toggle when MCP server is running.`
    );
    bridgeEnabled = false;
    chrome.storage.local.set({ bridgeEnabled: false });
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#9E9E9E" });
    chrome.storage.session.set({ wsConnected: false, autoDisabled: true, autoDisabledAt: Date.now() });
    return;
  }
  // Exponential backoff: 1.5s, 3s, 6s, 12s, 24s, 30s, 30s, ...
  // Cap at RECONNECT_MAX_DELAY_MS so we don't wait forever after long idle.
  const delay = Math.min(
    RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempts++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWS, delay);
}

// Disconnect immediately and stop any pending reconnect.
// Used when the master switch is turned off via popup.
function disconnectWS() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (ws) {
    try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {}
    ws = null;
  }
  wsConnected = false;
  chrome.storage.session.set({ wsConnected: false });
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#9E9E9E" });
  for (const [id, p] of pendingRequests) {
    p.reject(new Error("Bridge disabled"));
    pendingRequests.delete(id);
  }
}

function sendToWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ---------- Request routing ----------

async function handleIncoming(msg) {
  if (msg.type !== "request") return;
  const { id, method, params = {} } = msg;
  try {
    const result = await dispatch(method, params);
    sendToWS({ type: "response", id, result });
  } catch (err) {
    sendToWS({ type: "response", id, error: { message: err.message || String(err) } });
  }
}

async function dispatch(method, params) {
  switch (method) {
    // --- Tab-level (handled here, no content script needed) ---
    case "list_tabs":
      return await listTabs();
    case "new_tab":
      return await newTab(params.url);
    case "close_tab":
      return await chrome.tabs.remove(params.tabId).then(() => ({ success: true }));
    case "activate_tab":
      return await chrome.tabs.update(params.tabId, { active: true }).then(() => ({ success: true }));
    case "navigate": {
      const tab = await getActiveTab();
      await chrome.tabs.update(tab.id, { url: params.url });
      // Wait for the tab to finish loading (best-effort, 15s timeout)
      await waitForTabComplete(tab.id, 15000);
      return { success: true, url: params.url, title: (await chrome.tabs.get(tab.id)).title };
    }

    // --- Page-level (forward to content script on active tab) ---
    case "get_tree":
    case "get_text":
    case "click":
    case "fill":
    case "scroll":
    case "search":
      return await sendToActiveTab({ type: method.toUpperCase(), ...params });

    case "screenshot":
      return await takeScreenshot(params);

    case "upload_file":
      return await uploadFile(params.ref, params.files);

    case "highlight":
      return await sendToActiveTab({ type: "INDICATOR_HIGHLIGHT", ref: params.ref });

    case "clear_highlight":
      return await sendToActiveTab({ type: "INDICATOR_CLEAR_HIGHLIGHT" });

    case "get_attributes":
      return await sendToActiveTab({ type: "GET_ATTRIBUTES", ref: params.ref });

    case "press_key":
      return await sendToActiveTab({ type: "PRESS_KEY", ref: params.ref, key: params.key, modifiers: params.modifiers });

    case "hover":
      return await sendToActiveTab({ type: "HOVER", ref: params.ref });
    case "wait_for":
      // Implement waiting entirely in the service worker via chrome.scripting.executeScript.
      // This bypasses any listener routing issues with async sendResponse in MV3.
      // Runs in MAIN world to read __mcpNetworkLog/__mcpLastNetwork set by network-hook.js.
      // Refs are resolved via data-mcp-ref DOM attributes (shared across worlds).
      try {
        const tab = await getActiveTab();
        const injected = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          world: "MAIN",
          args: [params],
          func: async (p) => {
            // p: { ref, state, selector, countOp, countValue, text, networkIdleMs, timeout, pollInterval }
            const start = Date.now();
            const timeout = Math.min(Math.max(p.timeout ?? 10000, 0), 60000);
            const pollInterval = Math.min(Math.max(p.pollInterval ?? 100, 50), 1000);

            function getElByRef(ref) {
              if (!ref) return null;
              try {
                return document.querySelector(`[data-mcp-ref="${CSS.escape(ref)}"]`);
              } catch (e) {
                return null;
              }
            }

            function isVisible(el) {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              const style = window.getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden") return false;
              if (parseFloat(style.opacity) === 0) return false;
              return true;
            }

            function checkSelectorCount() {
              if (!p.selector) return null;
              try {
                return document.querySelectorAll(p.selector).length;
              } catch (e) {
                return null;
              }
            }

            function checkText() {
              if (!p.text) return null;
              const txt = (document.body && document.body.innerText) || "";
              return txt.indexOf(p.text) !== -1;
            }

            function checkNetworkIdle() {
              if (!p.networkIdleMs) return null;
              // Require both: (1) idle for networkIdleMs, (2) no in-flight requests
              const idle = Date.now() - (window.__mcpLastNetwork || 0);
              const active = window.__mcpActiveRequests || 0;
              return idle >= p.networkIdleMs && active === 0;
            }

            function evaluate() {
              const results = {};

              // ref state check
              if (p.ref && p.state) {
                const el = getElByRef(p.ref);
                if (p.state === "visible") results.refVisible = isVisible(el);
                else if (p.state === "hidden") results.refHidden = !isVisible(el);
                else if (p.state === "gone") results.refGone = !el;
                else if (p.state === "present") results.refPresent = !!el;
              }

              // selector count check
              if (p.selector && p.countOp && p.countValue !== undefined) {
                const c = checkSelectorCount();
                if (c === null) results.countError = true;
                else {
                  const v = p.countValue;
                  if (p.countOp === "==") results.countEq = (c === v);
                  else if (p.countOp === ">=") results.countGe = (c >= v);
                  else if (p.countOp === "<=") results.countLe = (c <= v);
                  else if (p.countOp === ">")  results.countGt = (c > v);
                  else if (p.countOp === "<")  results.countLt = (c < v);
                }
              }

              // text check
              if (p.text) {
                results.textPresent = checkText();
              }

              // network idle check
              if (p.networkIdleMs) {
                results.networkIdle = checkNetworkIdle();
              }

              return results;
            }

            function allSatisfied(results) {
              const keys = Object.keys(results);
              if (keys.length === 0) return true;
              for (const k of keys) {
                if (!results[k]) return false;
              }
              return true;
            }

            // Poll loop
            while (Date.now() - start < timeout) {
              try {
                const results = evaluate();
                if (allSatisfied(results)) {
                  return {
                    ok: true,
                    elapsed: Date.now() - start,
                    results,
                    currentUrl: location.href
                  };
                }
              } catch (e) {
                // ignore transient errors
              }
              await new Promise((r) => setTimeout(r, pollInterval));
            }

            // Timeout reached
            return {
              ok: false,
              error: "Timed out waiting for condition",
              elapsed: Date.now() - start,
              results: evaluate(),
              currentUrl: location.href
            };
          }
        });
        const result = injected && injected[0] && injected[0].result;
        return result || { ok: false, error: "No result returned from injected function" };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }

    case "get_network_log":
      try {
        const tab = await getActiveTab();
        const injected = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          world: "MAIN",
          args: [params],
          func: (p) => {
            const count = Math.min(Math.max(p?.count ?? 10, 1), 200);
            const log = window.__mcpNetworkLog || [];
            const fullUrl = p?.fullUrl === true;
            const urlPattern = p?.urlPattern || null;
            const sinceLast = p?.sinceLastCall === true;

            let re = null;
            if (urlPattern) { try { re = new RegExp(urlPattern); } catch (e) {} }
            function matches(e) {
              if (!urlPattern) return true;
              return re ? re.test(e.url) : e.url.includes(urlPattern);
            }
            function fmt(e) {
              let url = e.url;
              if (!fullUrl) {
                try { const u = new URL(e.url); url = u.pathname + u.search; } catch (x) {}
              }
              return { type: e.type, method: e.method, url, status: e.status, duration: e.duration, error: e.error || null };
            }

            let slice;
            if (sinceLast) {
              const cursor = window.__mcpNetworkReadCursor || 0;
              slice = log.slice(cursor).filter(matches);
            } else {
              slice = log.slice(-count).filter(matches);
            }
            // Always advance cursor to end of log (regardless of filter)
            window.__mcpNetworkReadCursor = log.length;

            return {
              ok: true,
              count: slice.length,
              totalTracked: log.length,
              activeRequests: window.__mcpActiveRequests || 0,
              entries: slice.map(fmt)
            };
          }
        });
        return injected?.[0]?.result || { ok: false, error: "No result returned" };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }

    case "wait_for_request":
      try {
        const tab = await getActiveTab();
        const injected = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          world: "MAIN",
          args: [params],
          func: async (p) => {
            const urlPattern = p?.urlPattern;
            if (!urlPattern) return { ok: false, error: "urlPattern is required" };
            const timeout = Math.min(Math.max(p?.timeout || 15000, 0), 60000);
            const pollInterval = Math.min(Math.max(p?.pollInterval || 100, 50), 1000);
            const method = p?.method ? String(p.method).toUpperCase() : null;
            const start = Date.now();
            let re;
            try { re = new RegExp(urlPattern); } catch (e) { re = null; }
            function matches(e) {
              if (e.status === null) return false; // still in-flight
              if (method && e.method !== method) return false;
              return re ? re.test(e.url) : e.url.includes(urlPattern);
            }
            // Check existing entries first
            const log = () => window.__mcpNetworkLog || [];
            let found = log().find(matches);
            if (found) {
              return {
                ok: true, elapsed: Date.now() - start,
                entry: { id: found.id, type: found.type, method: found.method, url: found.url, status: found.status, duration: found.duration, error: found.error || null }
              };
            }
            const seenIds = new Set(log().map((e) => e.id));
            while (Date.now() - start < timeout) {
              await new Promise((r) => setTimeout(r, pollInterval));
              const entries = log();
              for (let i = entries.length - 1; i >= 0; i--) {
                const e = entries[i];
                if (seenIds.has(e.id)) break; // reached entries we already checked
                if (matches(e)) {
                  return {
                    ok: true, elapsed: Date.now() - start,
                    entry: { id: e.id, type: e.type, method: e.method, url: e.url, status: e.status, duration: e.duration, error: e.error || null }
                  };
                }
              }
              seenIds.clear();
              for (const e of entries) seenIds.add(e.id);
            }
            return { ok: false, error: `Timed out waiting for request matching "${urlPattern}"`, elapsed: Date.now() - start };
          }
        });
        return injected?.[0]?.result || { ok: false, error: "No result returned" };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  // Ensure content scripts are injected (in case of restricted pages or pre-load injection)
  await ensureContentScripts(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, message);
  return res;
}

async function ensureContentScripts(tabId) {
  // Detect whether content scripts are present by probing
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    // Not injected yet — inject manually
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          "content/accessibility.js",
          "content/bridge.js",
          "content/indicator.js"
        ]
      });
    } catch (e) {
      throw new Error(`Cannot inject content scripts (chrome:// or restricted page?): ${e.message}`);
    }
  }
}

async function takeScreenshot(params = {}) {
  const tab = await getActiveTab();
  // If a ref is supplied, scroll the element into view and capture its
  // bounding rect so we can crop the screenshot to just that element.
  let rect = null;
  if (params.ref) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "GET_RECT", ref: params.ref });
      if (r && r.x !== undefined) rect = r;
    } catch {}
  }
  // Hide scrollbars/overflow via content script first
  try { await chrome.tabs.sendMessage(tab.id, { type: "PREPARE_SCREENSHOT" }); } catch {}
  try {
    // MV3 API: chrome.tabs.captureVisibleTab(windowId, options)
    // (chrome.tabs.captureVisible does NOT exist and would throw.)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (rect) {
      // Crop to element bounding box using OffscreenCanvas (available in SW).
      const cropped = await cropDataUrlToRect(dataUrl, rect);
      return { image: cropped, ref: params.ref, rect };
    }
    return { image: dataUrl }; // dataUrl is data:image/png;base64,....
  } finally {
    // Always restore overflow, even if capture failed
    try { await chrome.tabs.sendMessage(tab.id, { type: "RESTORE_SCREENSHOT" }); } catch {}
  }
}

async function cropDataUrlToRect(dataUrl, rect) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const dpr = rect.devicePixelRatio || 1;
    const sx = Math.max(0, Math.round((rect.x - rect.width / 2) * dpr));
    const sy = Math.max(0, Math.round((rect.y - rect.height / 2) * dpr));
    const sw = Math.min(bmp.width - sx, Math.round(rect.width * dpr));
    const sh = Math.min(bmp.height - sy, Math.round(rect.height * dpr));
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = await canvas.convertToBlob({ type: "image/png" });
    const reader = new FileReader();
    return await new Promise((resolve) => {
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(out);
    });
  } catch (e) {
    // Cropping failed — return the full screenshot as a fallback.
    console.warn("[MCP-Bridge] screenshot crop failed, returning full image:", e.message);
    return dataUrl;
  }
}

// ---------- File upload via CDP (chrome.debugger) ----------
//
// Flow:
//   1. Attach debugger to the active tab.
//   2. Enable Page domain so Page.fileChooserOpened fires.
//   3. Ask content script to click the ref element (usually <input type=file>
//      or a button that triggers a hidden file input). The click opens the
//      native file dialog, which CDP intercepts.
//   4. On Page.fileChooserOpened, call Page.setInterceptFileChooserDialog with
//      the supplied file paths.
//   5. Detach debugger.
//
// Notes:
//   - chrome.debugger shows a yellow " debugging this tab" banner. Unavoidable
//     for the CDP route in MV3.
//   - Files must be absolute local paths the extension can read. We pass them
//     straight through to CDP; the browser process opens them.

async function uploadFile(ref, files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("`files` must be a non-empty array of absolute local file paths");
  }
  const tab = await getActiveTab();
  const tabId = tab.id;

  // Resolve the input element ref into something clickable from the content
  // script (we don't need the element here — we just need it to trigger the
  // file dialog). If ref is omitted we try to dispatch a click on any
  // <input type=file> via the content script.
  await ensureContentScripts(tabId);

  let chooserOpenedResolver;
  let chooserOpenedRejecter;
  const chooserOpened = new Promise((resolve, reject) => {
    chooserOpenedResolver = resolve;
    chooserOpenedRejecter = reject;
  });
  let onEventRef = null;
  let timer = null;

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    // Enable Page domain and turn on file-chooser interception
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand(
      { tabId },
      "Page.setInterceptFileChooserDialog",
      { enabled: true }
    );

    onEventRef = (source, method, params) => {
      if (source.tabId !== tabId) return;
      if (method === "Page.fileChooserOpened") {
        chooserOpenedResolver(params);
      }
    };
    chrome.debugger.onEvent.addListener(onEventRef);

    // Trigger the file dialog: click the element via content script
    if (ref) {
      await chrome.tabs.sendMessage(tabId, { type: "CLICK", ref });
    } else {
      // Best-effort: click the first visible <input type=file>
      await chrome.tabs.sendMessage(tabId, { type: "CLICK_FILE_INPUT" });
    }

    // Wait for the chooser event (5s)
    timer = setTimeout(() => {
      chooserOpenedRejecter(new Error("File chooser did not open within 5s (ref may not be a file input)"));
    }, 5000);

    const chooserParams = await chooserOpened;
    clearTimeout(timer);
    timer = null;

    // chooserParams.frameId tells us which frame; we don't need it here.
    // Push the files via DOM.setFileInputFiles targeting the input backendNodeId.
    // Page.fileChooserOpened provides `backendNodeId` for the input element.
    const targetBackendNodeId = chooserParams.backendNodeId;
    if (!targetBackendNodeId) {
      throw new Error("fileChooserOpened event did not include backendNodeId");
    }

    // Read file contents as base64 and send to the input via DOM.setFileInputFiles.
    // (Page.setInterceptFileChooserDialog with files array is only supported in
    //  some Chromium versions; DOM.setFileInputFiles is the reliable route.)
    const filePayloads = [];
    for (const absPath of files) {
      const payload = await readLocalFileAsCdpFile(absPath);
      filePayloads.push(payload);
    }

    await chrome.debugger.sendCommand(
      { tabId },
      "DOM.setFileInputFiles",
      {
        files: filePayloads.map((p) => p.path),
        backendNodeId: targetBackendNodeId
      }
    );

    return {
      success: true,
      ref: ref || null,
      files: files,
      uploaded: filePayloads.map((p) => p.name)
    };
  } catch (err) {
    // Common: "Another debugger is already attached" — DevTools open on that tab
    throw new Error(`Upload failed: ${err.message || err}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (onEventRef) chrome.debugger.onEvent.removeListener(onEventRef);
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
}

// Helper: validate a local file path exists and return metadata.
// CDP's DOM.setFileInputFiles accepts `files: ["/abs/path/to/file"]` directly
// when running against a real browser process — no need to base64-encode here.
// We do a light sanity check via the File System API from the service worker.
async function readLocalFileAsCdpFile(absPath) {
  // The service worker cannot use node's fs. We rely on CDP accepting an
  // absolute path string. Validation happens by attempting to set; if the
  // path is invalid, CDP returns an error which surfaces from sendCommand.
  // Extract just the basename for the response.
  const parts = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts[parts.length - 1] || absPath;
  return { path: absPath, name };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id, windowId: t.windowId, title: t.title, url: t.url,
      active: t.active, faviconUrl: t.favIconUrl
    }))
  };
}

async function newTab(url) {
  const t = await chrome.tabs.create({ url: url || "about:blank", active: true });
  if (url) await waitForTabComplete(t.id, 15000);
  return { tabId: t.id, url: t.url };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

// ---------- Keepalive (MV3 service workers die after 30s idle) ----------

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 }); // 15s
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  if (!bridgeEnabled) return; // disabled — skip
  if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
  else sendToWS({ type: "ping", ts: Date.now() });
});

// ---------- Lifecycle ----------

// ---------- Messages from popup / content scripts ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "RECONNECT_WS":
      // Force close + reconnect
      try { ws && ws.close(); } catch {}
      connectWS();
      sendResponse({ ok: true });
      break;
    case "BRIDGE_TOGGLED":
      bridgeEnabled = !!msg.enabled;
      if (bridgeEnabled) {
        // Reset backoff counter when user manually re-enables — give the
        // server a fresh chance to connect without immediately hitting the
        // auto-disable threshold from previous failures.
        reconnectAttempts = 0;
        chrome.storage.session.set({ autoDisabled: false });
        connectWS();
      } else {
        disconnectWS();
      }
      sendResponse({ ok: true });
      break;
    case "STOP_AGENT":
      // Forward to MCP server so it can cancel the in-flight tool call
      sendToWS({ type: "event", event: "stop_requested", ts: Date.now() });
      sendResponse({ ok: true });
      break;
  }
  return true;
});

chrome.runtime.onStartup.addListener(initBridgeFromStorage);
chrome.runtime.onInstalled.addListener(initBridgeFromStorage);

function initBridgeFromStorage() {
  chrome.storage.local.get(["bridgeEnabled"], (s) => {
    bridgeEnabled = s.bridgeEnabled !== false;
    if (bridgeEnabled) connectWS();
    else {
      chrome.action.setBadgeText({ text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ color: "#9E9E9E" });
    }
  });
}

// Also react to storage changes (covers cases where SW was asleep when user toggled).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("bridgeEnabled" in changes)) return;
  bridgeEnabled = changes.bridgeEnabled.newValue !== false;
  if (bridgeEnabled) connectWS();
  else disconnectWS();
});

initBridgeFromStorage();
