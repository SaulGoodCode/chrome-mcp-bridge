// Content script: bridge.js
// Listens for chrome.runtime messages from the background SW and executes page actions.

(() => {
  if (globalThis.__mcpBridge) return;

  // ─── Network activity tracking ────────────────────────────────────
  // Maintain a timestamp of the most recent fetch/XHR activity so that
  // wait_for(networkIdleMs) can detect when the page has gone quiet.
  // Stored on window so isolated-world scripts (executeScript) can read it.
  globalThis.__mcpLastNetwork = Date.now();
  globalThis.__mcpActiveRequests = 0;

  const _origFetch = globalThis.fetch;
  if (_origFetch) {
    globalThis.fetch = function (...args) {
      globalThis.__mcpLastNetwork = Date.now();
      globalThis.__mcpActiveRequests = (globalThis.__mcpActiveRequests || 0) + 1;
      return _origFetch.apply(this, args).finally(() => {
        globalThis.__mcpLastNetwork = Date.now();
        globalThis.__mcpActiveRequests = Math.max(0, (globalThis.__mcpActiveRequests || 0) - 1);
      });
    };
  }

  const _origXhrOpen = XMLHttpRequest.prototype.open;
  const _origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mcpMethod = method;
    this.__mcpUrl = url;
    return _origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    globalThis.__mcpLastNetwork = Date.now();
    globalThis.__mcpActiveRequests = (globalThis.__mcpActiveRequests || 0) + 1;
    this.addEventListener("loadend", () => {
      globalThis.__mcpLastNetwork = Date.now();
      globalThis.__mcpActiveRequests = Math.max(0, (globalThis.__mcpActiveRequests || 0) - 1);
    });
    return _origXhrSend.call(this, body);
  };

  function getPageText(maxChars = 50000) {
    const candidates = [
      "article", "main",
      '[class*="article-body"]', '[class*="post-content"]',
      '[class*="entry-content"]', '[class*="content-body"]',
      '[role="main"]', ".content", "#content"
    ];
    let best = null, bestLen = 0;
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        const len = (el.textContent || "").length;
        if (len > bestLen) { bestLen = len; best = el; }
      }
    }
    const root = best || document.body;
    let text = (root?.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + "... (truncated)";
    return {
      title: document.title,
      url: location.href,
      content: text,
      source: root ? root.tagName.toLowerCase() : "body"
    };
  }

  // Set value on input/textarea, bypassing React/Vue controlled-component wrappers.
  function setNativeValue(el, value) {
    try {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && typeof desc.set === "function") desc.set.call(el, value);
      else el.value = value;
    } catch {
      el.value = value;
    }
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, value);
    if (el.textContent !== value) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
    }
  }

  function fillForm(ref, value) {
    const a = globalThis.__mcpAccessibility;
    if (!a) return { success: false, error: "Accessibility module not ready" };
    const el = a.getEl(ref);
    if (!el) return { success: false, error: `Element not found: ${ref}` };

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const tag = el.tagName.toLowerCase();

    try {
      if (tag === "select") {
        let matched = false;
        for (const opt of el.options) {
          if (opt.value === String(value) || opt.text === String(value)) {
            el.value = opt.value; matched = true; break;
          }
        }
        if (!matched) return { success: false, error: "No matching option" };
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (tag === "input") {
        const type = (el.type || "").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          el.checked = !!value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (type === "file") {
          // File uploads require CDP (chrome.debugger) — see background.js uploadFile().
          // Returning a clear hint so the MCP server / AI can route to chrome_upload_file.
          return { success: false, error: "File upload requires the chrome_upload_file tool (CDP). Do not use chrome_fill for type=file inputs." };
        } else {
          setNativeValue(el, String(value));
        }
      } else if (tag === "textarea") {
        setNativeValue(el, String(value));
      } else if (el.isContentEditable) {
        setContentEditable(el, String(value));
      } else {
        setNativeValue(el, String(value));
      }

      // Move caret to end for text inputs
      if ((tag === "textarea" || (tag === "input" && ["text", "password", "search", "tel", "url"].includes((el.type || "").toLowerCase())))
          && typeof el.setSelectionRange === "function") {
        const len = (el.value || "").length;
        el.setSelectionRange(len, len);
      }
      return { success: true, ref, name: el.name || el.id || ref };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  }

  function clickElement(ref) {
    const a = globalThis.__mcpAccessibility;
    if (!a) return { success: false, error: "Accessibility module not ready" };
    const el = a.getEl(ref);
    if (!el) return { success: false, error: `Element not found: ${ref}` };
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      el.click();
      return { success: true, ref };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  }

  function scrollTo(params) {
    if (params.ref) {
      const a = globalThis.__mcpAccessibility;
      const el = a?.getEl(params.ref);
      if (!el) return { success: false, error: `Element not found: ${params.ref}` };
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      return { success: true, ref: params.ref };
    }
    window.scrollTo({
      left: Number(params.x ?? 0),
      top: Number(params.y ?? 0),
      behavior: "smooth"
    });
    return { success: true, x: params.x ?? 0, y: params.y ?? 0 };
  }

  // Module-level state for screenshot overflow restoration.
  // (Functions returned from content scripts can't survive chrome.runtime
  //  sendMessage serialization, so we keep the prev value here and expose
  //  a separate RESTORE_SCREENSHOT message to invoke the restore.)
  let screenshotOverflowPrev = null;
  let screenshotOverflowActive = false;

  function prepareScreenshot() {
    // Only remember prev value on first capture to avoid stacking
    if (!screenshotOverflowActive) {
      screenshotOverflowPrev = document.body.style.overflow;
      screenshotOverflowActive = true;
    }
    document.body.style.overflow = "hidden";
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function restoreScreenshot() {
    if (!screenshotOverflowActive) return { ok: true, skipped: true };
    document.body.style.overflow = screenshotOverflowPrev;
    screenshotOverflowPrev = null;
    screenshotOverflowActive = false;
    return { ok: true };
  }

  function evalInPage(code) {
    try {
      // Run in page's main world via indirect eval
      const fn = new Function(code);
      return { success: true, result: fn() };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  }

  // Return the actual values of an element identified by ref.
  // Useful for verifying form state: value/checked/href/src/aria-* etc.
  function getAttributes(ref) {
    const a = globalThis.__mcpAccessibility;
    if (!a) return { success: false, error: "Accessibility module not ready" };
    const el = a.getEl(ref);
    if (!el) return { success: false, error: `Element not found: ${ref}` };
    const out = { ref, tagName: el.tagName.toLowerCase(), role: a.roleOf ? a.roleOf(el) : null };
    // Common live properties
    if ("value" in el) out.value = el.value;
    if (el.checked !== undefined) out.checked = el.checked;
    if (el.disabled !== undefined) out.disabled = el.disabled;
    if (el.readOnly !== undefined) out.readOnly = el.readOnly;
    if (el.placeholder) out.placeholder = el.placeholder;
    if (el.href !== undefined) out.href = el.href;
    if (el.src !== undefined) out.src = el.src;
    if (el.alt !== undefined) out.alt = el.alt;
    if (el.id) out.id = el.id;
    if (el.name) out.name = el.name;
    if (el.type) out.type = el.type;
    // Selected option for <select>
    if (el.tagName === "SELECT") {
      out.selectedIndex = el.selectedIndex;
      out.selectedOptions = Array.from(el.selectedOptions).map((o) => o.textContent.trim());
    }
    // All aria-* attributes
    const aria = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith("aria-")) aria[attr.name] = attr.value;
    }
    if (Object.keys(aria).length) out.aria = aria;
    // All data-* attributes (capped to avoid huge output)
    const data = {};
    let dataCount = 0;
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && dataCount < 20) {
        data[attr.name] = attr.value;
        dataCount++;
      }
    }
    if (Object.keys(data).length) out.data = data;
    // Bounding rect
    const r = el.getBoundingClientRect();
    out.rect = { x: r.left, y: r.top, width: r.width, height: r.height, devicePixelRatio: window.devicePixelRatio || 1 };
    out.visible = a.isVisible ? a.isVisible(el) : undefined;
    return { success: true, attributes: out };
  }

  // Simulate keyboard events on an element (or on document.body if ref is null).
  // Supports keys like "Enter", "Escape", "Tab", "ArrowDown", "a", etc.
  // modifiers: array of "ctrl" | "shift" | "alt" | "meta"
  function pressKey(ref, key, modifiers = []) {
    const a = globalThis.__mcpAccessibility;
    if (!a) return { success: false, error: "Accessibility module not ready" };
    let el = ref ? a.getEl(ref) : null;
    if (ref && !el) return { success: false, error: `Element not found: ${ref}` };
    if (!el) el = document.activeElement || document.body;
    const mods = Array.isArray(modifiers) ? modifiers : [];
    const opts = {
      key,
      code: keyToCode(key),
      keyCode: keyToKeyCode(key),
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.includes("ctrl"),
      shiftKey: mods.includes("shift"),
      altKey: mods.includes("alt"),
      metaKey: mods.includes("meta"),
    };
    try {
      el.focus && el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      return { success: true, ref: ref || "document.active", key, modifiers: mods };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  }

  // Map a key name like "Enter" or "ArrowDown" to the KeyboardEvent.code value.
  function keyToCode(key) {
    const map = {
      "Enter": "Enter", "Escape": "Escape", "Tab": "Tab", "Backspace": "Backspace",
      "ArrowUp": "ArrowUp", "ArrowDown": "ArrowDown",
      "ArrowLeft": "ArrowLeft", "ArrowRight": "ArrowRight",
      "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown",
      " ": "Space", "Spacebar": "Space",
    };
    if (map[key]) return map[key];
    if (key.length === 1) {
      // Letter / digit → KeyX / DigitX
      if (/[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`;
      if (/[0-9]/.test(key)) return `Digit${key}`;
    }
    return key;
  }

  function keyToKeyCode(key) {
    const map = {
      "Enter": 13, "Escape": 27, "Tab": 9, "Backspace": 8,
      "ArrowUp": 38, "ArrowDown": 40, "ArrowLeft": 37, "ArrowRight": 39,
      "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34,
      " ": 32, "Spacebar": 32,
    };
    if (map[key] !== undefined) return map[key];
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  // Simulate hover (mouseover + mouseenter) on an element.
  // Useful for triggering menus, tooltips, dropdowns that open on hover.
  function hoverElement(ref) {
    const a = globalThis.__mcpAccessibility;
    if (!a) return { success: false, error: "Accessibility module not ready" };
    const el = a.getEl(ref);
    if (!el) return { success: false, error: `Element not found: ${ref}` };
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mousemove", opts));
      return { success: true, ref };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log("[MCP-Bridge] msg received:", msg.type, msg);
    if (msg.type === "PING") { sendResponse({ ok: true }); return true; }

    const a = globalThis.__mcpAccessibility;
    switch (msg.type) {
      case "GET_TREE":
        sendResponse(a.buildTree({
          mode: msg.mode,
          maxDepth: msg.maxDepth,
          maxChars: msg.maxChars,
          refId: msg.refId,
          selector: msg.selector
        }));
        break;
      case "GET_TEXT":
        sendResponse(getPageText(msg.maxChars));
        break;
      case "CLICK":
        sendResponse(clickElement(msg.ref));
        break;
      case "CLICK_FILE_INPUT": {
        // Fallback used by uploadFile() when no ref provided: click the first
        // visible <input type=file> on the page.
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const visible = inputs.find((el) => {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          // Many file inputs are visually hidden but still operable — accept
          // any input whose bounding rect is non-zero OR that has a label/button
          // sibling we can click instead.
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const target = visible || inputs[0];
        if (!target) {
          sendResponse({ success: false, error: "No <input type=file> found on page" });
        } else {
          try { target.click(); sendResponse({ success: true }); }
          catch (e) { sendResponse({ success: false, error: e.message || String(e) }); }
        }
        break;
      }
      case "FILL":
        sendResponse(fillForm(msg.ref, msg.value));
        break;
      case "SCROLL":
        sendResponse(scrollTo(msg));
        break;
      case "SEARCH":
        sendResponse({ results: a.search(msg.query, msg.maxResults, msg.role) });
        break;
      case "GET_ATTRIBUTES":
        sendResponse(getAttributes(msg.ref));
        break;
      case "PRESS_KEY":
        sendResponse(pressKey(msg.ref, msg.key, msg.modifiers));
        break;
      case "HOVER":
        sendResponse(hoverElement(msg.ref));
        break;
      case "GET_RECT": {
        // Return element bounding rect in viewport coordinates.
        // Used by background.js to crop screenshots to a specific element.
        const el = a.getEl(msg.ref);
        if (!el) { sendResponse({ success: false, error: `Element not found: ${msg.ref}` }); break; }
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        sendResponse({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          width: r.width,
          height: r.height,
          devicePixelRatio: window.devicePixelRatio || 1,
          ref: msg.ref
        });
        break;
      }
      case "PREPARE_SCREENSHOT":
        sendResponse(prepareScreenshot());
        break;
      case "RESTORE_SCREENSHOT":
        sendResponse(restoreScreenshot());
        break;
      default:
        sendResponse({ success: false, error: `Unknown type: ${msg.type}` });
    }
    return true;
  });

  globalThis.__mcpBridge = {
    getPageText, fillForm, clickElement, scrollTo, prepareScreenshot, evalInPage
  };
})();
