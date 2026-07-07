// Injected directly into the page's MAIN world at document_start.
// Patches window.fetch and XMLHttpRequest to record network activity
// into window.__mcpNetworkLog for the MCP bridge tools.
(() => {
  if (window.__mcpNetworkPatchInstalled) return;
  window.__mcpNetworkPatchInstalled = true;

  var MAX = 200;
  window.__mcpLastNetwork = Date.now();
  window.__mcpActiveRequests = 0;
  window.__mcpNetworkLog = [];
  window.__mcpNetworkReadCursor = 0;

  function push(e) {
    var log = window.__mcpNetworkLog;
    log.push(e);
    if (log.length > MAX) log.shift();
  }

  function normUrl(u, base) {
    try { return new URL(u, base || location.href).href; }
    catch (e) { return u; }
  }

  var _f = window.fetch;
  if (_f) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? normUrl(input)
        : (input && input.url) ? normUrl(input.url) : String(input);
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var entry = {
        id: "f_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
        url: url, method: method, startTime: Date.now(), type: "fetch",
        status: null, duration: null
      };
      window.__mcpLastNetwork = Date.now();
      window.__mcpActiveRequests = (window.__mcpActiveRequests || 0) + 1;
      push(entry);
      return _f.apply(this, arguments).then(function (resp) {
        entry.status = resp.status;
        entry.duration = Date.now() - entry.startTime;
        return resp;
      }).catch(function (err) {
        entry.status = 0;
        entry.error = err.message || String(err);
        entry.duration = Date.now() - entry.startTime;
        throw err;
      }).finally(function () {
        window.__mcpLastNetwork = Date.now();
        window.__mcpActiveRequests = Math.max(0, (window.__mcpActiveRequests || 0) - 1);
      });
    };
  }

  var _xo = XMLHttpRequest.prototype.open;
  var _xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mcpMethod = method;
    this.__mcpUrl = normUrl(url);
    return _xo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var entry = {
      id: "x_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      url: this.__mcpUrl || location.href,
      method: String(this.__mcpMethod || "GET").toUpperCase(),
      startTime: Date.now(), type: "xhr",
      status: null, duration: null
    };
    window.__mcpLastNetwork = Date.now();
    window.__mcpActiveRequests = (window.__mcpActiveRequests || 0) + 1;
    push(entry);
    this.addEventListener("loadend", function () {
      entry.status = this.status;
      entry.duration = Date.now() - entry.startTime;
      if (this.status === 0) entry.error = "Network error or aborted";
      window.__mcpLastNetwork = Date.now();
      window.__mcpActiveRequests = Math.max(0, (window.__mcpActiveRequests || 0) - 1);
    });
    return _xs.apply(this, arguments);
  };
})();
