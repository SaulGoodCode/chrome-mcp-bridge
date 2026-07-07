function refresh() {
  chrome.storage.session.get(["wsConnected", "lastConnectedAt", "autoDisabled"], (s) => {
    const dot = document.getElementById("dot");
    const status = document.getElementById("status");
    const autoDisabledHint = document.getElementById("autoDisabledHint");
    if (s.wsConnected) {
      dot.className = "dot on";
      status.textContent = "已连接";
    } else {
      dot.className = "dot off";
      status.textContent = "未连接";
    }
    // Show the auto-disabled banner if background set the flag.
    autoDisabledHint.style.display = s.autoDisabled ? "block" : "none";
  });
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const t = tabs[0];
    document.getElementById("tab").textContent = t ? `${t.title?.slice(0, 30)} · ${t.url}` : "—";
  });
}

const enabledToggle = document.getElementById("enabledToggle");
const toggleSlider = document.getElementById("toggleSlider");
const disabledHint = document.getElementById("disabledHint");
const reconnectBtn = document.getElementById("reconnect");

function renderToggle(enabled) {
  enabledToggle.checked = enabled;
  if (enabled) {
    toggleSlider.style.backgroundColor = "#4CAF50";
    toggleSlider.querySelector("span").style.transform = "translateX(16px)";
    disabledHint.style.display = "none";
    reconnectBtn.disabled = false;
    reconnectBtn.style.opacity = "1";
  } else {
    toggleSlider.style.backgroundColor = "#ccc";
    toggleSlider.querySelector("span").style.transform = "translateX(0)";
    disabledHint.style.display = "block";
    reconnectBtn.disabled = true;
    reconnectBtn.style.opacity = "0.5";
  }
}

chrome.storage.local.get(["bridgeEnabled"], (s) => {
  // Default ON to preserve existing behavior (auto-connect on install).
  const enabled = s.bridgeEnabled !== false;
  renderToggle(enabled);
});

enabledToggle.addEventListener("change", () => {
  const enabled = enabledToggle.checked;
  renderToggle(enabled);
  chrome.storage.local.set({ bridgeEnabled: enabled });
  // Clear the auto-disabled banner when user re-enables.
  if (enabled) {
    chrome.storage.session.set({ autoDisabled: false });
    document.getElementById("autoDisabledHint").style.display = "none";
  }
  // Tell background to start/stop WS based on the new state.
  chrome.runtime.sendMessage({ type: "BRIDGE_TOGGLED", enabled }, () => {
    setTimeout(refresh, 600);
  });
});

reconnectBtn.addEventListener("click", () => {
  // Service worker can't be restarted directly, but sending any runtime message
  // wakes it up. The keepalive alarm will reconnect WS within 15s.
  chrome.runtime.sendMessage({ type: "RECONNECT_WS" }, () => {
    setTimeout(refresh, 800);
  });
});

// Default server.js path (relative to extension, resolved at first install).
// Users should update this to match their actual install location via the popup input.
const DEFAULT_SERVER_PATH = "/server.js";

const serverPathInput = document.getElementById("serverPath");
const browseBtn = document.getElementById("browseBtn");
const pathHint = document.getElementById("pathHint");

// Load saved path from storage (or default) and populate input
chrome.storage.local.get(["mcpServerPath"], (s) => {
  serverPathInput.value = s.mcpServerPath || DEFAULT_SERVER_PATH;
});

// Save to storage whenever user edits the path (debounced via 'change' event)
serverPathInput.addEventListener("change", () => {
  const v = serverPathInput.value.trim();
  if (v) chrome.storage.local.set({ mcpServerPath: v });
  pathHint.style.display = "none";
});

// Browse button: open a native file picker so the user can locate server.js.
// Chrome's security model does NOT expose the absolute path of the selected
// File object to JavaScript — we only get the file name and contents. So
// after the user picks the file, we verify it's the right server.js by
// reading its content, then ask the user to copy the path from the file
// picker dialog (which Chrome shows in its title bar / address bar) into
// the text input above.
browseBtn.addEventListener("click", () => {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".js,application/javascript";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      document.body.removeChild(fileInput);
      return;
    }
    pathHint.style.display = "block";
    pathHint.style.color = "#2196F3";
    pathHint.textContent = `已选择 ${file.name}，正在验证...`;

    try {
      const text = await file.text();
      if (text.includes("Chrome MCP Bridge") && text.includes("MCP server")) {
        // Verified: this is our server.js. Chrome won't give us the path,
        // so we instruct the user to grab it from the picker dialog title.
        pathHint.style.color = "#4CAF50";
        pathHint.innerHTML =
          `✓ 已验证为 Chrome MCP Bridge 的 server.js（${file.size} bytes）。` +
          `<br>Chrome 安全限制不允许读取绝对路径。请将刚才在文件选择对话框中看到的完整路径填入左侧输入框。`;
      } else {
        pathHint.style.color = "#E53935";
        pathHint.textContent = `✗ 选中的文件不是 Chrome MCP Bridge 的 server.js`;
      }
    } catch (e) {
      pathHint.style.color = "#E53935";
      pathHint.textContent = `读取文件失败: ${e.message}`;
    }
    document.body.removeChild(fileInput);
  });

  // Also handle the case where the user cancels the picker
  fileInput.addEventListener("cancel", () => {
    pathHint.style.display = "none";
    document.body.removeChild(fileInput);
  });

  fileInput.click();
});

function getMcpConfig() {
  const serverPath = serverPathInput.value.trim() || DEFAULT_SERVER_PATH;
  return `{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["${serverPath}"]
    }
  }
}`;
}

document.getElementById("openMcp").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(getMcpConfig());
    document.getElementById("openMcp").textContent = "已复制!";
    setTimeout(() => { document.getElementById("openMcp").textContent = "复制 MCP 配置"; }, 1500);
  } catch {
    alert(getMcpConfig());
  }
});

refresh();
setInterval(refresh, 2000);
