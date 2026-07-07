# Chrome MCP Bridge — Agent Guide

让 AI 通过 MCP 协议控制本地 Chrome 浏览器：导航、点击、填表单、抓文本、截图、管理标签页。

任何支持 MCP（Model Context Protocol）或能读取项目规则的 AI 客户端均可使用本指南。

## 架构

```
AI 客户端 (Claude Desktop / Trae / Cursor / Continue / Cline …)
    ↕ MCP stdio (JSON-RPC)
MCP Server (node /server.js)
    ↕ WebSocket ws://127.0.0.1:8787
Chrome 扩展 (background.js + content scripts)
    ↓ 操作 DOM
网页
```

## 何时应用本指南

任一条件触发：
- 用户说"打开网页 xxx"、"在浏览器里 xxx"、"看看这个网站"
- 用户要求点击按钮、填写表单、截图网页、抓取页面内容
- 用户要求自动化浏览器操作
- 用户提到 `chrome_*` 工具
- 用户显式调用：在 Trae 中输入 `/chrome-mcp-bridge <任务>`，或在其他客户端中引用本文件

## 前置检查（每次任务开始必做）

### 1. 探测 MCP server 是否在运行
```powershell
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*mcp-server*server.js*" }
```
或直接尝试调用 `chrome_list_tabs`：
- 成功 → server 在跑、扩展已连，进入"使用工具"环节
- 报错 `Chrome extension not connected` → server 在跑但扩展没连，转步骤 3
- 报错 `Unknown tool` / 工具不存在 → server 没启动或 MCP 配置缺失，转步骤 2

### 2. 启动 MCP server（如未运行）
```powershell
cd \mcp-server
node server.js
```
**长驻进程**，必须非阻塞启动。server 启动后扩展会在 ~1.5 秒内自动连上 WebSocket，badge 从 OFF 变 ON。

### 3. 扩展连接排障
- **badge 显示 OFF**：让用户点扩展图标 → popup 里点「重连」按钮
- **扩展未加载**：让用户打开 `chrome://extensions` → 开启开发者模式 → 加载 `\extension` 目录
- **MCP 配置缺失**：在 AI 客户端的 MCP 配置中加入（扩展 popup 里有「复制 MCP 配置」按钮一键复制）：
  ```json
  {
    "mcpServers": {
      "chrome-bridge": {
        "command": "node",
        "args": ["/server.js"]
      }
    }
  }
  ```
  配置后**必须重启 AI 客户端**才能识别 chrome_* 工具。

## 可用工具清单（20 个）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `chrome_navigate` | 跳转 URL，等加载完成 | `url` |
| `chrome_get_tree` | 获取元素树，每个元素带 `ref_id` | `mode` / `maxChars` / `refId` |
| `chrome_get_text` | 抓正文 | `maxChars` |
| `chrome_click` | 点击元素 | `ref` (来自 get_tree / search) |
| `chrome_fill` | 填表单（兼容 React/Vue） | `ref`, `value` |
| `chrome_scroll` | 滚动到元素 / 坐标 | `ref` 或 `x` / `y` |
| `chrome_search` | 关键词搜元素 | `query`, `maxResults` |
| `chrome_screenshot` | 截图（返回 base64 PNG） | — |
| `chrome_list_tabs` | 列出所有标签页 | — |
| `chrome_new_tab` | 新建标签页 | `url`（可选） |
| `chrome_close_tab` | 关闭标签页 | `tabId` |
| `chrome_activate_tab` | 激活标签页 | `tabId` |
| `chrome_upload_file` | 上传本地文件到 `<input type=file>`（CDP） | `files`（绝对路径数组），`ref` 可选 |
| `chrome_highlight` | 用脉冲边框高亮元素，便于调试 | `ref` |
| `chrome_clear_highlight` | 清除高亮 | — |
| `chrome_get_attributes` | 获取元素属性 | `ref` |
| `chrome_press_key` | 模拟键盘按键 | `ref`, `key`, `modifiers` |
| `chrome_hover` | 鼠标悬停元素 | `ref` |
| `chrome_wait_for` | 智能等待（ref/selector/text/network idle） | `ref`+`state`, `selector`+`countOp`+`countValue`, `text`, `networkIdleMs`, `timeout` |
| `chrome_get_network_log` | 返回最近 N 条 XHR/fetch 请求 | `count` |
| `chrome_wait_for_request` | 等待特定 URL 模式的请求完成 | `urlPattern`, `method`, `timeout` |

## 标准操作范式

**核心原则：永远先获取 ref_id，再操作元素。**
ref_id 在同一页面会话内稳定，但页面导航后失效，需重新获取。

### 范式 1：点击页面上某个按钮
```
1. chrome_get_tree                       → 得到 [ref_3] button "登录"
2. chrome_click ref=ref_3                → 点击
```

### 范式 2：填写并提交表单
```
1. chrome_get_tree                       → 找到 [ref_5] textbox "邮箱"、[ref_7] textbox "密码"、[ref_9] button "登录"
2. chrome_fill ref=ref_5 value=a@b.com
3. chrome_fill ref=ref_7 value=secret
4. chrome_click ref=ref_9
```

### 范式 3：抓取页面内容
```
1. chrome_navigate url=https://example.com
2. chrome_get_text                       → 返回正文
   或 chrome_screenshot                  → 返回截图供 AI 视觉分析
```

### 范式 4：搜索特定元素（页面很大时）
```
1. chrome_search query="登录 按钮"        → 返回带分数的 ref 列表
2. chrome_click ref=ref_12
```

### 范式 5：操作指定标签页
```
1. chrome_list_tabs                      → 得到 tabId 列表
2. chrome_activate_tab tabId=42          → 切到目标 tab
3. chrome_get_tree                       → 操作该 tab
```

### 范式 6：输出被截断时钻取子树
```
1. chrome_get_tree                       → [TRUNCATED at ref_15]
2. chrome_get_tree refId=ref_15          → 只看 ref_15 子树
```

### 范式 7：上传文件
```
1. chrome_get_tree                       → 找到 [ref_8] input (type=file)
2. chrome_upload_file ref=ref_8 files=["C:/Users/me/Pictures/cat.png"]
```
或不知道 ref 时：
```
1. chrome_upload_file files=["C:/Users/me/Pictures/cat.png"]   → 自动选页面首个 file input
```
**注意**：
- 该工具用 CDP（chrome.debugger）实现，标签页顶部会短暂出现黄色 "正在调试此标签页" 提示条，操作完成后自动消失。
- 路径必须是**绝对路径**，由浏览器进程直接打开。
- 同一标签页如果开着 DevTools，会冲突报 "Another debugger is already attached"，需先关掉 DevTools。

## 重要约束

- **受限页面无法操作**：`chrome://`、`chrome-extension://`、Chrome Web Store 等页面禁止 content script 注入，会报错 `Cannot inject content scripts`。遇到时让用户手动操作或换页面。
- **文件上传支持**：使用 `chrome_upload_file` 工具（走 CDP）。不要用 `chrome_fill` 操作 `type=file` 输入 —— 会返回明确错误指引你改用 `chrome_upload_file`。
- **跨 iframe 不支持**：当前 `all_frames: false`，只能操作顶层文档。
- **每个工具调用 30 秒超时**：页面卡住或网络慢时会超时。
- **MV3 service worker 会休眠**：长时间不用后第一次调用可能慢 1-2 秒（SW 唤醒 + 重连 WS）。

## 故障排查速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Unknown tool: chrome_*` | AI 客户端未配置 MCP | 写 mcp config → 重启客户端 |
| `Chrome extension not connected` | server 在跑但扩展没连 | 点扩展图标 → 重连 |
| `Cannot inject content scripts` | 受限页面 | 换普通网页 |
| `Element not found: ref_X` | 页面已导航 / ref 失效 | 重新 `chrome_get_tree` |
| 调用挂起到 30 秒超时 | 页面卡死或元素不可见 | 用 `chrome_search` 重新定位 |
| badge 一直 OFF | SW 休眠未唤醒 | 点扩展图标激活 |

## 禁止事项

- ❌ 不要在没有 `chrome_get_tree` 或 `chrome_search` 的情况下凭猜测传 `ref` —— ref_id 是动态分配的
- ❌ 不要在 `chrome_navigate` 后立刻 `chrome_get_tree` —— navigate 已等加载完成，但 SPA 路由可能需要额外等待，必要时用 `chrome_search` 探测
- ❌ 不要把截图 base64 原文回显给用户 —— 只让 AI 看图，文本结果才回显
- ❌ 不要用 `chrome_fill` 操作 `type=file` —— 改用 `chrome_upload_file` 工具（走 CDP）

## 各客户端集成方式

本指南可被以下 AI 客户端使用，集成方式：

| 客户端 | 集成方式 |
|---|---|
| Trae | 项目根 `.trae/skills/chrome-mcp-bridge/SKILL.md`（已存在） |
| Claude Desktop / Claude Code | 项目根 `CLAUDE.md` 引用本文件，或直接复制内容 |
| Cursor | `.cursor/rules/chrome-mcp-bridge.mdc`（复制本文件内容，加 mdc frontmatter） |
| Continue | `.continuerules.md` 或 `.continue/config.yaml` 的 `systemPrompt` |
| Cline | `.clinerules` 文件 |
| 通用 | 本文件 `AGENTS.md`（日渐流行的跨客户端约定） |

MCP server 配置（所有客户端通用）：
```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/server.js"]
    }
  }
}
```
