// Content script: accessibility-tree.js
// Builds a stable ref-id map for interactive elements so the agent can target them
// across multiple actions without relying on brittle selectors.

(() => {
  if (globalThis.__mcpAccessibility) return;

  const refToEl = new Map();        // ref_id -> WeakRef<Element>
  const elToRef = new WeakMap();    // Element -> ref_id
  let counter = 1;

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a": return "link";
      case "button": return "button";
      case "input":
        switch ((el.type || "").toLowerCase()) {
          case "text": case "email": case "password": case "tel": case "url": return "textbox";
          case "search": return "searchbox";
          case "checkbox": return "checkbox";
          case "radio": return "radio";
          case "range": return "slider";
          case "number": return "spinbutton";
          case "file": case "submit": case "reset": case "button": return "button";
          default: return "textbox";
        }
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "img": return "image";
      case "ul": case "ol": return "list";
      case "li": return "listitem";
      case "table": return "table";
      case "tr": return "row";
      case "td": case "th": return "cell";
      case "form": return "form";
      case "nav": return "navigation";
      case "main": return "main";
      case "article": return "article";
      case "header": return "header";
      case "footer": return "footer";
      default:
        return (el.onclick || el.onmousedown || el.onmouseup) ? "button" : "";
    }
  }

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 120);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const target = document.getElementById(labelledby);
      if (target) return (target.textContent || "").trim().slice(0, 120);
    }
    const title = el.getAttribute("title");
    if (title) return title.trim().slice(0, 120);
    if (el.placeholder) return el.placeholder.trim().slice(0, 120);
    if (["BUTTON", "A", "H1", "H2", "H3", "H4", "H5", "H6"].includes(el.tagName)) {
      return (el.textContent || "").trim().slice(0, 120);
    }
    if (el.tagName === "LABEL" && el.control) return (el.textContent || "").trim().slice(0, 120);
    if (el.tagName === "IMG") return (el.alt || "").trim().slice(0, 120);
    const role = roleOf(el);
    if (["heading", "listitem", "article", "status", "alert", "tooltip"].includes(role)) {
      return (el.textContent || "").trim().slice(0, 120);
    }
    return "";
  }

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
    "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "tab", "switch"
  ]);

  function isInteractive(el) {
    return INTERACTIVE_ROLES.has(roleOf(el));
  }

  function isVisible(el) {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function refFor(el) {
    let r = elToRef.get(el);
    if (r) {
      // Verify still valid
      const w = refToEl.get(r);
      if (w && w.deref() === el) {
        // Refresh dataset marker (in case DOM was replaced)
        try { el.dataset.mcpRef = r; } catch (e) {}
        return r;
      }
    }
    r = `ref_${counter++}`;
    refToEl.set(r, new WeakRef(el));
    elToRef.set(el, r);
    // Also mark on DOM so isolated-world scripts (e.g. executeScript) can resolve ref
    try { el.dataset.mcpRef = r; } catch (e) {}
    return r;
  }

  function getEl(ref) {
    const w = refToEl.get(ref);
    return w ? w.deref() : null;
  }

  function getRect(ref) {
    const el = getEl(ref);
    if (!el) return null;
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      width: r.width,
      height: r.height,
      ref
    };
  }

  function buildTree({
    mode = "interactive",     // "interactive" | "all"
    maxDepth = 15,
    maxChars = 50000,
    refId = null,             // if set, build subtree rooted at this ref
    selector = null           // if set, restrict to descendants of elements matching this CSS selector
  } = {}) {
    const lines = [];
    let used = 0;
    let truncated = false;
    let lastRef = null;

    const root = refId ? getEl(refId) : null;
    if (refId && !root) {
      return { tree: `[Error] Element not found: ${refId}`, elementCount: 0, truncated: false };
    }

    function walk(el, depth) {
      if (truncated) return;
      if (depth > maxDepth) return;
      if (!isVisible(el)) return;

      const role = roleOf(el);
      const include = mode === "all" || isInteractive(el) || role !== "";
      if (include) {
        const label = labelOf(el);
        const ref = refFor(el);
        const indent = "  ".repeat(Math.min(depth, 12));
        let line = `${indent}[${ref}] ${role || el.tagName.toLowerCase()}`;
        if (label) line += ` "${label}"`;

        const attrs = [];
        if (el.disabled) attrs.push("disabled");
        if (el.checked !== undefined && el.type !== "radio") attrs.push(el.checked ? "checked" : "unchecked");
        if (el.readOnly) attrs.push("readonly");
        if (el.required) attrs.push("required");
        if (el.tagName === "SELECT") attrs.push(`options=${el.options.length}`);
        if (attrs.length) line += ` (${attrs.join(", ")})`;

        if (used + line.length + 1 > maxChars) {
          truncated = true;
          lines.push(`[TRUNCATED at ${lastRef || "start"}. Use refId to drill into a subtree, or raise maxChars.]`);
          return;
        }
        lines.push(line);
        used += line.length + 1;
        lastRef = ref;
      }

      for (const child of el.children) walk(child, depth + 1);
    }

    if (root) {
      walk(root, 0);
    } else if (selector) {
      // Walk subtrees rooted at each element matching the CSS selector.
      // Useful for large pages where drilling from body is too noisy.
      try {
        const roots = document.querySelectorAll(selector);
        for (const r of roots) walk(r, 0);
      } catch (e) {
        return { tree: `[Error] Invalid selector: ${e.message}`, elementCount: 0, truncated: false };
      }
    } else if (document.body) {
      walk(document.body, 0);
    }

    const prefix = truncated
      ? `[Warning: output truncated. Use refId for subtree, or raise maxChars.]\n`
      : "";
    return {
      tree: prefix + lines.join("\n"),
      elementCount: refToEl.size,
      truncated
    };
  }

  function search(query, maxResults = 20, role = null) {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const roleFilter = role ? String(role).toLowerCase() : null;
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node;
      const r = roleOf(el);
      // Role filter: skip elements that don't match the requested role.
      if (roleFilter && r.toLowerCase() !== roleFilter) continue;
      const label = labelOf(el);
      const text = (el.textContent || "").toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (label.toLowerCase().includes(t)) score += 3;
        if (r.toLowerCase().includes(t)) score += 2;
        if (text.includes(t)) score += 1;
      }
      // When role filter is set, include even with score 0 — user explicitly
      // asked for elements of that role.
      if (score > 0 || roleFilter) {
        if (isVisible(el)) {
          out.push({ ref: refFor(el), role: r, label: label || r, score });
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, maxResults);
  }

  globalThis.__mcpAccessibility = {
    buildTree,
    getEl,
    getRect,
    refFor,
    search,
    roleOf,
    labelOf,
    isVisible,
    isInteractive,
    get elementCount() { return refToEl.size; }
  };
})();
