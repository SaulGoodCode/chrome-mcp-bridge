// Content script: indicator.js
// Visual feedback for the user during agent operations.
// Uses Shadow DOM to avoid contaminating host page styles.

(() => {
  if (globalThis.__mcpIndicator) return;

  let shadow = null;
  let highlightEl = null;
  let highlightRef = null;       // currently highlighted ref (for reposition on scroll/resize)
  let badgeEl = null;
  let stopBtnEl = null;
  let glowEl = null;
  let active = false;
  let repositionHandler = null; // scroll/resize listener bound to current highlight

  function getShadow() {
    if (shadow) return shadow;
    let host = document.getElementById("mcp-indicator-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "mcp-indicator-host";
      host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;";
      document.documentElement.appendChild(host);
    }
    if (!host.shadowRoot) shadow = host.attachShadow({ mode: "open" });
    else shadow = host.shadowRoot;
    return shadow;
  }

  function ensureStyles() {
    const s = getShadow();
    if (s.getElementById("mcp-styles")) return;
    const style = document.createElement("style");
    style.id = "mcp-styles";
    style.textContent = `
      @keyframes mcp-pulse {
        0%, 100% { border-color: #4CAF50; box-shadow: 0 0 5px rgba(76,175,80,0.5); }
        50% { border-color: #81C784; box-shadow: 0 0 20px rgba(76,175,80,0.8); }
      }
      @keyframes mcp-glow {
        0%, 100% { box-shadow: inset 0 0 4px rgba(74,222,128,0.5), inset 0 0 8px rgba(74,222,128,0.25); }
        50% { box-shadow: inset 0 0 6px rgba(74,222,128,0.7), inset 0 0 12px rgba(74,222,128,0.35); }
      }
    `;
    s.appendChild(style);
  }

  function positionHighlightBox() {
    if (!highlightEl || !highlightRef) return;
    const a = globalThis.__mcpAccessibility;
    if (!a) return;
    const el = a.getEl(highlightRef);
    if (!el) { clearHighlight(); return; }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Use position: fixed so the box stays aligned to viewport coordinates
    // even when the page scrolls (getBoundingClientRect already returns
    // viewport-relative coords). Reposition on scroll/resize via
    // repositionHandler below.
    highlightEl.style.left = `${rect.left - 4}px`;
    highlightEl.style.top = `${rect.top - 4}px`;
    highlightEl.style.width = `${rect.width + 8}px`;
    highlightEl.style.height = `${rect.height + 8}px`;
  }

  function highlight(ref) {
    const a = globalThis.__mcpAccessibility;
    if (!a) return;
    const el = a.getEl(ref);
    if (!el) return;
    clearHighlight();
    ensureStyles();
    highlightRef = ref;
    const box = document.createElement("div");
    // position: fixed keeps the box anchored to viewport coords; we
    // reposition it on scroll/resize via the handler below.
    box.style.cssText = `
      position: fixed;
      left: 0; top: 0;
      border: 3px solid #4CAF50;
      border-radius: 4px;
      pointer-events: none;
      box-sizing: border-box;
      animation: mcp-pulse 1s ease-in-out infinite;
      z-index: 2147483646;
    `;
    getShadow().appendChild(box);
    highlightEl = box;

    // Reposition now (scrolls element into view first, so subsequent
    // getBoundingClientRect returns sensible viewport coords).
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    // Position after scrollIntoView settles (rAF ensures layout is up-to-date)
    requestAnimationFrame(positionHighlightBox);
    // Also reposition once more after smooth scroll finishes (~200ms)
    setTimeout(positionHighlightBox, 250);

    // Keep the box aligned with the element during page scroll / resize.
    // Use passive + rAF-throttled to avoid jank.
    let scheduled = false;
    repositionHandler = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        positionHighlightBox();
      });
    };
    window.addEventListener("scroll", repositionHandler, { passive: true, capture: true });
    window.addEventListener("resize", repositionHandler, { passive: true });
  }

  function clearHighlight() {
    if (repositionHandler) {
      window.removeEventListener("scroll", repositionHandler, { capture: true });
      window.removeEventListener("resize", repositionHandler);
      repositionHandler = null;
    }
    if (highlightEl) { highlightEl.remove(); highlightEl = null; }
    highlightRef = null;
  }

  function showBadge(status = "loading", message) {
    ensureStyles();
    if (badgeEl) badgeEl.remove();
    const colors = { loading: "#2196F3", success: "#4CAF50", error: "#f44336" };
    const icons = { loading: "⏳", success: "✅", error: "❌" };
    badgeEl = document.createElement("div");
    badgeEl.style.cssText = `
      position: fixed; top: 16px; right: 16px;
      background: ${colors[status] || colors.loading};
      color: white; padding: 10px 16px; border-radius: 8px;
      font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      cursor: pointer; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
    `;
    badgeEl.innerHTML = `${icons[status] || "⏳"} ${message || status}`;
    badgeEl.onclick = () => badgeEl.remove();
    getShadow().appendChild(badgeEl);
  }

  function hideBadge() {
    if (badgeEl) { badgeEl.remove(); badgeEl = null; }
  }

  function showGlow() {
    active = true;
    ensureStyles();
    if (!glowEl) {
      glowEl = document.createElement("div");
      glowEl.style.cssText = `
        position: fixed; inset: 0;
        pointer-events: none; z-index: 2147483646;
        opacity: 0; transition: opacity 0.3s;
        animation: mcp-glow 2s ease-in-out infinite;
      `;
      getShadow().appendChild(glowEl);
    }
    glowEl.style.display = "";
    requestAnimationFrame(() => { glowEl.style.opacity = "1"; });

    if (!stopBtnEl) {
      const wrap = document.createElement("div");
      wrap.style.cssText = `
        position: fixed; bottom: 16px; left: 50%;
        transform: translateX(-50%) translateY(80px);
        opacity: 0; transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
        z-index: 2147483647;
      `;
      const btn = document.createElement("button");
      btn.textContent = "⏹ Stop Agent";
      btn.style.cssText = `
        padding: 10px 16px; background: #FAF9F5; color: #141413;
        border: 0.5px solid rgba(31,30,29,0.4); border-radius: 12px;
        font: 600 14px -apple-system, sans-serif;
        cursor: pointer; pointer-events: auto;
        box-shadow: 0 4px 14px rgba(74,222,128,0.3);
      `;
      btn.onmouseenter = () => { btn.style.background = "#F5F4F0"; };
      btn.onmouseleave = () => { btn.style.background = "#FAF9F5"; };
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Stopping...";
        try {
          await chrome.runtime.sendMessage({ type: "STOP_AGENT" });
        } catch (e) {
          console.warn("[MCP] stop failed", e);
        }
        hideGlow();
      };
      wrap.appendChild(btn);
      getShadow().appendChild(wrap);
      stopBtnEl = wrap;
    }
    stopBtnEl.style.display = "";
    requestAnimationFrame(() => {
      stopBtnEl.style.opacity = "1";
      stopBtnEl.style.transform = "translateX(-50%) translateY(0)";
    });
  }

  function hideGlow() {
    active = false;
    if (glowEl) glowEl.style.opacity = "0";
    if (stopBtnEl) {
      stopBtnEl.style.opacity = "0";
      stopBtnEl.style.transform = "translateX(-50%) translateY(80px)";
    }
  }

  function hideAll() {
    clearHighlight();
    hideBadge();
    hideGlow();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "INDICATOR_HIGHLIGHT": highlight(msg.ref); break;
      case "INDICATOR_CLEAR_HIGHLIGHT": clearHighlight(); break;
      case "INDICATOR_BADGE": showBadge(msg.status, msg.message); break;
      case "INDICATOR_HIDE_BADGE": hideBadge(); break;
      case "INDICATOR_SHOW_GLOW": showGlow(); break;
      case "INDICATOR_HIDE_GLOW": hideGlow(); break;
      case "INDICATOR_HIDE_ALL": hideAll(); break;
    }
    sendResponse({ ok: true });
    return true;
  });

  window.addEventListener("beforeunload", hideAll);

  globalThis.__mcpIndicator = { highlight, clearHighlight, showBadge, hideBadge, showGlow, hideGlow, hideAll };
})();
