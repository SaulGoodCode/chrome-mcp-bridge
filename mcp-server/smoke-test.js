// End-to-end smoke test: spawn the MCP server as a subprocess, speak MCP
// JSON-RPC over stdio, and call a few tools to verify the bridge works.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER = "/server.js";

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
let nextId = 1;

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const req = { jsonrpc: "2.0", id, method, params: params || {} };
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  }
});

function listTools()        { return send("tools/list", {}); }
function callTool(name, args = {}) {
  return send("tools/call", { name, arguments: args });
}

(async () => {
  try {
    // 1. Initialize handshake
    const init = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" }
    });
    console.log("\n[1] initialize OK:", init.serverInfo);

    // 2. List tools
    const tools = await listTools();
    console.log(`\n[2] tools/list OK: ${tools.tools.length} tools`);
    console.log("    names:", tools.tools.map(t => t.name).join(", "));

    // 2.5 Wait for extension to connect (it auto-reconnects within ~1.5s,
    //     but give it up to 10s for service worker wake + WS handshake).
    console.log("\n[2.5] waiting for Chrome extension to connect...");
    let connected = false;
    for (let i = 0; i < 20; i++) {
      const probe = await callTool("chrome_list_tabs");
      if (!probe.isError) { connected = true; break; }
      if (!probe.content[0].text.includes("not connected")) break; // different error, fail fast
      await sleep(500);
    }
    if (!connected) {
      console.log("    ! extension did not connect. Make sure:");
      console.log("      1. Chrome extension is loaded");
      console.log("      2. The extension badge shows ON (or click the extension icon → Reconnect)");
      throw new Error("Extension not connected");
    }
    console.log("    ✓ extension connected");

    // 3. chrome_list_tabs (verifies extension is connected)
    console.log("\n[3] calling chrome_list_tabs...");
    const tabs = await callTool("chrome_list_tabs");
    console.log("    raw content:", JSON.stringify(tabs).slice(0, 400));
    let tabsData;
    try {
      tabsData = JSON.parse(tabs.content[0].text);
    } catch (e) {
      console.log("    ! tool returned non-JSON (likely error). isError=", tabs.isError);
      console.log("    text:", tabs.content[0].text);
      throw e;
    }
    console.log(`    ✓ success: ${tabsData.tabs.length} tab(s) open`);
    if (tabsData.tabs[0]) {
      console.log(`    first tab: "${tabsData.tabs[0].title?.slice(0, 50)}" — ${tabsData.tabs[0].url}`);
    }

    // 4. chrome_navigate to example.com
    console.log("\n[4] calling chrome_navigate https://example.com...");
    const nav = await callTool("chrome_navigate", { url: "https://example.com" });
    const navData = JSON.parse(nav.content[0].text);
    console.log(`    ✓ success=${navData.success}, title="${navData.title}", url=${navData.url}`);

    await sleep(500);

    // 5. chrome_get_tree
    console.log("\n[5] calling chrome_get_tree...");
    const tree = await callTool("chrome_get_tree", { maxChars: 2000 });
    const treeData = JSON.parse(tree.content[0].text);
    console.log(`    ✓ elementCount=${treeData.elementCount}, truncated=${treeData.truncated}`);
    console.log("    tree (first 600 chars):");
    console.log("    " + treeData.tree.split("\n").slice(0, 12).join("\n    "));

    // 6. chrome_get_text
    console.log("\n[6] calling chrome_get_text...");
    const text = await callTool("chrome_get_text", { maxChars: 500 });
    const textData = JSON.parse(text.content[0].text);
    console.log(`    ✓ title="${textData.title}", source=${textData.source}, content len=${textData.content.length}`);
    console.log(`    content: ${textData.content.slice(0, 200)}`);

    // 7. chrome_search
    console.log("\n[7] calling chrome_search query=\"More information\"...");
    const srch = await callTool("chrome_search", { query: "More information" });
    const srchData = JSON.parse(srch.content[0].text);
    console.log(`    ✓ ${srchData.results.length} match(es)`);
    if (srchData.results[0]) {
      console.log(`    top: ref=${srchData.results[0].ref} role=${srchData.results[0].role} label="${srchData.results[0].label}"`);
    }

    console.log("\n=== ALL CHECKS PASSED ===\n");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err.message);
    process.exit(1);
  }
})();

setTimeout(() => {
  console.error("\n[TIMEOUT] Tests did not complete in 30s");
  process.exit(2);
}, 30000);
