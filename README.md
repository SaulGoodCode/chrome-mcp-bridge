# Chrome MCP Bridge

让 AI 客户端（Claude Desktop / Trae / Cursor / Continue / Cline 等）通过 [MCP 协议](https://modelcontextprotocol.io/) 直接控制本地 Chrome 浏览器：导航、点击、填表单、抓文本、截图、管理标签页、上传文件。

> bridge · noun · a structure carrying a road/path over an obstacle — 本项目在 AI 与浏览器之间架起一座桥。

---

## ✨ 特性

- **18 个 MCP 工具**：覆盖导航、元素操作、表单、键盘、鼠标、截图、标签页、文件上传、智能等待等场景
- **零依赖部署**：MCP server 仅依赖 `@modelcontextprotocol/sdk` 和 `ws`；扩展纯原生 JS，无构建步骤
- **跨客户端**：任何支持 MCP 的 AI 客户端都能用同一份配置接入
- **稳定 ref_id 系统**：基于 ARIA 角色和可见性构建可访问性树，元素 ref 在同一页面会话内稳定，跨操作可复用
- **React/Vue 友好**：`chrome_fill` 使用原生事件序列，绕过受控组件的状态保护
- **视觉反馈**：`chrome_highlight` 给元素加脉冲边框，便于人工核对 AI 操作的目标
- **智能重连**：指数退避重连 + 自动放弃 + 一键总开关，避免无 server 时的资源浪费
- **元素级截图**：`chrome_screenshot` 支持传 `ref` 只截元素 bounding box，节省 token
- **CDP 文件上传**：`chrome_upload_file` 通过 Chrome DevTools Protocol 处理 `<input type="file">`，兼容各种隐藏 file input
- **智能等待**：`chrome_wait_for` 轮询等待元素出现/消失、文本出现、选择器数量变化、网络空闲，解决 SPA 路由切换和 AJAX 加载的时序问题，组合条件自动 AND

---

## 🏗 架构

```
AI 客户端 (Claude Desktop / Trae / Cursor / Continue / Cline …)
    ↕ MCP stdio (JSON-RPC over stdin/stdout)
MCP Server (Node.js, mcp-server/server.js)
    ↕ WebSocket ws://127.0.0.1:8787
Chrome 扩展 (MV3: background.js + content scripts + popup)
    ↓ 操作 DOM / 调用 Chrome API
网页
```

**数据流**：AI 客户端 → MCP server（stdio）→ Chrome 扩展（WebSocket）→ Content Script（DOM 操作）→ 返回结果原路回传。

---

## 📦 项目结构

```
.
├── extension/                # Chrome 扩展（MV3）
│   ├── background.js         # Service worker：WebSocket 客户端 + 请求路由
│   ├── manifest.json         # 扩展清单
│   ├── content/
│   │   ├── accessibility.js  # 构建可访问性树、生成 ref_id、search
│   │   ├── bridge.js         # DOM 操作：click/fill/scroll/press_key/hover/screenshot 等 + 网络活动跟踪
│   │   └── indicator.js      # 高亮框（脉冲边框，跟随滚动）
│   ├── popup/
│   │   ├── popup.html        # 扩展弹窗 UI
│   │   └── popup.js          # 状态显示、重连、桥接开关、MCP 配置复制
│   ├── icons/                # 扩展图标（16/32/48/96/128 px）
│   └── generate_icon.py      # 图标生成脚本（PIL）
├── mcp-server/               # MCP server
│   ├── server.js             # MCP 协议入口 + WebSocket server + 工具定义
│   ├── smoke-test.js         # 端到端冒烟测试
│   └── package.json
└── AGENTS.md                 # 跨客户端 Agent 指南（Cursor/Cline/Claude 等通用）
```

---

## 🚀 快速开始

### 前置要求

- **Node.js ≥ 18**（推荐 20+）
- **Chrome ≥ 110**（需要支持 MV3 service worker）
- 任意支持 MCP 的 AI 客户端（Claude Desktop / Trae / Cursor 等）

### 步骤 1：安装 MCP server 依赖

```bash
cd mcp-server
npm install
```

### 步骤 2：加载 Chrome 扩展

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本项目的 `extension/` 目录
4. 扩展加载后，工具栏会出现青色桥形图标

### 步骤 3：配置 AI 客户端

在 AI 客户端的 MCP 配置文件中加入：

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/server.js"]
    }
  }
}
```

> 💡 **快捷方式**：点 Chrome 工具栏的扩展图标 → popup 里点 **「复制 MCP 配置」** 按钮，配置会自动用 popup 里填写的 `server.js` 绝对路径。路径可在输入框中编辑并持久化保存。

配置后**必须重启 AI 客户端**才能识别 `chrome_*` 工具。

### 步骤 4：验证连接

重启 AI 客户端后，让 AI 调用：

```
chrome_list_tabs
```

如果返回当前 Chrome 打开的所有标签页列表，说明连接成功。badge 应显示 **ON**。

---

## 🛠 可用工具

共 18 个工具，按用途分组：

### 标签页与导航

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `chrome_navigate` | 跳转到 URL，等加载完成 | `url` |
| `chrome_list_tabs` | 列出所有标签页 | — |
| `chrome_new_tab` | 新建标签页（可选 URL） | `url` |
| `chrome_close_tab` | 关闭标签页 | `tabId` |
| `chrome_activate_tab` | 激活标签页 | `tabId` |

### 元素发现

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `chrome_get_tree` | 获取元素树，每个元素带 `ref_id` | `mode`, `maxDepth`, `maxChars`, `refId`, `selector` |
| `chrome_search` | 按关键词和/或 ARIA role 搜索元素 | `query`, `role`, `maxResults` |
| `chrome_get_attributes` | 返回元素的 value/checked/href/aria-*/data-* 等实际值 | `ref` |
| `chrome_get_text` | 抓取页面正文 | `maxChars` |

### 元素操作

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `chrome_click` | 点击元素 | `ref` |
| `chrome_fill` | 填表单（兼容 React/Vue 受控组件） | `ref`, `value` |
| `chrome_scroll` | 滚动到元素或坐标 | `ref` 或 `x`/`y` |
| `chrome_press_key` | 模拟键盘事件（Enter/Escape/Tab/方向键等） | `key`, `ref`, `modifiers` |
| `chrome_hover` | 模拟鼠标 hover（触发菜单/Tooltip） | `ref` |

### 截图与视觉

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `chrome_screenshot` | 截屏，支持传 `ref` 裁剪到元素 bounding box | `ref` |
| `chrome_highlight` | 给元素加脉冲边框（人工核对 AI 操作） | `ref` |
| `chrome_clear_highlight` | 清除高亮 | — |

### 文件上传

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `chrome_upload_file` | 通过 CDP 上传本地文件到 `<input type=file>` | `files`, `ref` |

### 等待与同步

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `chrome_wait_for` | 轮询等待条件满足后返回（SPA 路由/AJAX/动画） | `ref`+`state`, `selector`+`countOp`+`countValue`, `text`, `networkIdleMs`, `timeout` |

**条件说明**（可组合，AND 语义）：

- `ref` + `state`：等待元素变为 `visible`/`hidden`/`gone`/`present`
- `selector` + `countOp`（`==`/`>=`/`<=`/`>`/`<`）+ `countValue`：等待 CSS 选择器匹配数量
- `text`：等待页面包含某段文本
- `networkIdleMs`：等待网络空闲指定毫秒数（fetch/XHR 活动停止 + 无活跃请求）
- `timeout`：总超时（默认 10s，最大 60s），超时返回 `{ok:false, error, results}`

---

## 📖 使用示例

### 示例 1：登录网站

```
1. chrome_navigate url=https://example.com/login
2. chrome_get_tree              → 找到 [ref_5] textbox "邮箱"、[ref_7] textbox "密码"、[ref_9] button "登录"
3. chrome_fill ref=ref_5 value=user@example.com
4. chrome_fill ref=ref_7 value=secret
5. chrome_click ref=ref_9
```

### 示例 2：填表后按 Enter 提交（无需按钮）

```
1. chrome_search role="searchbox"       → 找到 [ref_2] searchbox
2. chrome_fill ref=ref_2 value="手机"
3. chrome_press_key ref=ref_2 key="Enter"  → 触发搜索
```

### 示例 3：验证表单状态

```
1. chrome_fill ref=ref_5 value="hello"
2. chrome_get_attributes ref=ref_5
   → { value: "hello", checked: false, ... }   验证填入成功
```

### 示例 4：截取特定元素（节省 token）

```
1. chrome_search role="button"          → 找到 [ref_3] button "提交"
2. chrome_screenshot ref=ref_3           → 只截按钮区域，不是整屏
```

### 示例 5：用 selector 过滤超大页面

```
1. chrome_get_tree selector="nav.main"  → 只走导航栏子树
```

### 示例 6：触发 hover 下拉菜单

```
1. chrome_search query="产品" role="link"
2. chrome_hover ref=ref_3                → 触发下拉菜单
3. chrome_get_tree selector="nav.dropdown"  → 获取展开后的菜单项
```

### 示例 7：SPA 路由切换后等待页面加载

```
1. chrome_search query="发布商机" role="link"   → 找到 [ref_7] link
2. chrome_click ref=ref_7                         → 触发 SPA 路由跳转
3. chrome_wait_for text="完善以下信息" networkIdleMs=500 timeout=10000
   → 等表单说明文本出现 + 网络空闲 500ms，返回 {ok:true, elapsed: ...}
4. chrome_get_tree                                → 现在安全操作表单
```

### 示例 8：等列表加载完成（元素数量 + 网络空闲）

```
1. chrome_click ref=ref_searchBtn
2. chrome_wait_for selector=".result-item" countOp=">=" countValue=10 networkIdleMs=300
   → 等至少 10 条结果渲染且网络空闲
3. chrome_get_attributes ref=ref_firstItem       → 读取第一条数据
```

---

## 🎛 扩展 Popup

点击 Chrome 工具栏的扩展图标打开 popup，可看到：

- **桥接状态**：WebSocket 连接状态、Server URL、当前活动标签页
- **启用桥接开关**：关闭时扩展完全不连接 server，零资源消耗；开启时立即重连
- **MCP server 路径输入框**：填写 `server.js` 的绝对路径，用于生成 MCP 配置；支持「浏览...」按钮通过文件选择器定位
- **重连按钮**：强制断开并重连 WebSocket
- **复制 MCP 配置按钮**：一键复制当前路径的 MCP 配置 JSON 到剪贴板

### 自动关闭机制

如果 MCP server 没启动，扩展会尝试重连 10 次（指数退避：1.5s → 3s → 6s → 12s → 24s → 30s ...），累计约 3 分钟后自动关闭桥接开关，避免无意义的重连浪费资源。Popup 会显示橙色横幅提示「已自动关闭」，用户确认 server 启动后手动重新打开开关即可。

---

## 🔧 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Unknown tool: chrome_*` | AI 客户端未配置 MCP | 写 MCP config → 重启客户端 |
| `Chrome extension not connected` | server 在跑但扩展没连 | 点扩展图标 → 重连 |
| `Cannot inject content scripts` | 受限页面（`chrome://`、Web Store） | 换普通网页 |
| `Element not found: ref_X` | 页面已导航 / ref 失效 | 重新 `chrome_get_tree` |
| `Another debugger is already attached` | 标签页开着 DevTools | 关掉 DevTools 再用 `chrome_upload_file` |
| `EADDRINUSE: address already in use 8787` | 旧 server 进程残留 | 关闭 Trae/Claude MCP 开关再开；或 `taskkill /F /PID <pid>` |
| badge 一直 OFF | SW 休眠未唤醒 | 点扩展图标激活 |
| 调用挂起到 30 秒超时 | 页面卡死或元素不可见 | 用 `chrome_search` 重新定位 |
| `chrome_wait_for` 超时返回 `{ok:false}` | 条件文本/选择器写错或页面未加载 | 查看返回的 `results` 字段诊断哪个条件未满足；先用 `chrome_get_text` 确认实际页面文字 |

---

## 🧪 测试

### 冒烟测试

```bash
cd mcp-server
node smoke-test.js
```

该脚本会启动 MCP server 子进程，通过 stdio 发送 MCP JSON-RPC 请求，验证基本工具调用链路。

### 手动验证

加载扩展并启动 server 后，让 AI 调用 `chrome_list_tabs` → 应返回当前所有标签页。然后让 AI 操作一个普通网页（如 `https://example.com`）验证 `chrome_get_tree`、`chrome_click`、`chrome_screenshot` 等。

---

## 🚧 限制

- **跨 iframe 不支持**：当前 `all_frames: false`，只能操作顶层文档
- **受限页面**：`chrome://`、`chrome-extension://`、Chrome Web Store 等页面禁止 content script 注入
- **每个工具调用 30 秒超时**：页面卡住或网络慢时会超时
- **MV3 service worker 会休眠**：长时间不用后第一次调用可能慢 1-2 秒（SW 唤醒 + 重连 WS）
- **文件上传走 CDP**：标签页顶部会短暂出现黄色「正在调试此标签页」提示条，操作完成后自动消失；同标签页若开着 DevTools 会冲突
- **Chrome 平台限制无法获取扩展自身路径**：MCP 配置中的 `server.js` 路径需要用户手动填写一次（之后会持久化保存）

---

## 🤝 各客户端集成

| 客户端 | 集成方式 |
|---|---|
| **Trae** | 项目根 `.trae/skills/chrome-mcp-bridge/SKILL.md`（已内置） |
| **Claude Desktop / Claude Code** | 项目根 `CLAUDE.md` 引用 `AGENTS.md`，或直接复制内容 |
| **Cursor** | `.cursor/rules/chrome-mcp-bridge.mdc`（复制 `AGENTS.md` 内容，加 mdc frontmatter） |
| **Continue** | `.continuerules.md` 或 `.continue/config.yaml` 的 `systemPrompt` |
| **Cline** | `.clinerules` 文件 |
| **通用** | `AGENTS.md`（日渐流行的跨客户端约定） |

详细的跨客户端使用指南见 [AGENTS.md](./AGENTS.md)。

---

## 📜 许可证

MIT License. 见 [LICENSE](./LICENSE)。

---

## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) — Anthropic 开放的 AI 与工具集成协议
- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/) — Chrome 扩展现代标准
- 所有为本项目提供反馈和测试的用户
