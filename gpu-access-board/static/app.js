/* ── Backend URL resolution ─────────────────────────────────────────────────
 *
 * The frontend can be served by FastAPI itself (same-origin) or hosted
 * statically (e.g. on GitHub Pages) and pointed at a backend running locally
 * on the user's machine (which is on the Salk VPN). All API/WS calls go
 * through apiUrl() / wsUrl() so the destination is a single switch.
 */

const LS_BACKEND = "gpu-access-board.backend_url";
const LS_CLUSTERS = "gpu-access-board.clusters";  // user-edited cluster defs

function defaultBackend() {
  // Served by FastAPI itself → same-origin (relative URLs).
  // Served statically (file:// or github.io / any other host) → localhost:8000.
  const h = location.hostname;
  const isLocal = h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0";
  if (location.protocol === "file:") return "http://localhost:8000";
  if (isLocal && location.port === "8000") return "";   // FastAPI default
  if (h.endsWith("github.io")) return "http://localhost:8000";
  // If the page is served from a non-empty origin, assume same-origin.
  return "";
}

function getBackend() {
  // Priority: URL param > localStorage > default.
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("backend");
  if (fromUrl) {
    localStorage.setItem(LS_BACKEND, fromUrl);
    return fromUrl.replace(/\/+$/, "");
  }
  const stored = localStorage.getItem(LS_BACKEND);
  if (stored !== null) return stored.replace(/\/+$/, "");
  return defaultBackend();
}

function setBackend(url) {
  const clean = (url || "").trim().replace(/\/+$/, "");
  localStorage.setItem(LS_BACKEND, clean);
}

function apiUrl(path) {
  const b = getBackend();
  if (!path.startsWith("/")) path = "/" + path;
  return b ? `${b}${path}` : path;
}

function wsUrl(path) {
  const b = getBackend();
  if (!path.startsWith("/")) path = "/" + path;
  if (b) {
    return b.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") + path;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

/* ── State ─────────────────────────────────────────────────────────────────── */

let clusters = {};            // {name: {host, connected}} — runtime state from backend
let clustersConfig = null;    // {name: {host, port, username, directory}} — user-editable
let defaultsCache = null;     // {clusters, project} from /api/defaults
let metricsCache = {};        // {name: {gpu: [...], system: {...}}}
let pollInterval = null;
// One Claude session per cluster, kept alive across subtab switches.
// {clusterName: {term, ws, fitAddon, container}}
let claudeTerminals = {};
let activeProcCluster = null;
let activeClaudeCluster = null;
let projectConfig = {};     // from /api/config

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico"]);
function isImageFile(name) {
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = name.substring(dotIdx).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}
let currentOpenFilePath = null;
let resizeHandleInitialized = false;

/* ── Boot ──────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  // Backend info banner on login screen
  showBackendInfo();

  // Login
  document.getElementById("login-btn").addEventListener("click", doLogin);
  document.getElementById("password-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  // Tabs
  document.querySelectorAll("#tab-bar .tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Process table sorting
  document.querySelectorAll("#process-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => sortProcessTable(th.dataset.sort));
  });

  document.getElementById("proc-filter").addEventListener("input", filterProcesses);
  document.getElementById("logout-btn").addEventListener("click", doLogout);

  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("login-theme-toggle").addEventListener("click", toggleTheme);
  loadTheme();

  document.getElementById("claude-connect-btn").addEventListener("click", launchClaude);

  // Settings dialog
  document.getElementById("login-settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-cancel").addEventListener("click", closeSettings);
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  document.getElementById("add-cluster-btn").addEventListener("click", () => addClusterRow());
  document.getElementById("reset-clusters-btn").addEventListener("click", resetClustersToDefaults);

  // Load defaults so the Settings UI has something to show on first open.
  // Don't block boot on it — runs in background.
  loadDefaults();
});

function showBackendInfo() {
  const el = document.getElementById("backend-info");
  if (!el) return;
  const b = getBackend();
  const where = b || `${location.protocol}//${location.host}`;
  el.textContent = `backend: ${where}`;
}

async function openSettings() {
  const dlg = document.getElementById("settings-overlay");
  document.getElementById("settings-backend-url").value = getBackend();
  await loadDefaults();
  renderClusterEditor();
  dlg.classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
}

async function saveSettings() {
  setBackend(document.getElementById("settings-backend-url").value);

  // Harvest cluster rows into clustersConfig
  const rows = document.querySelectorAll("#cluster-rows tr");
  const out = {};
  for (const tr of rows) {
    const name = tr.querySelector('[data-field="name"]').value.trim();
    if (!name) continue;
    const host = tr.querySelector('[data-field="host"]').value.trim();
    const port = parseInt(tr.querySelector('[data-field="port"]').value, 10);
    const username = tr.querySelector('[data-field="username"]').value.trim();
    const directory = tr.querySelector('[data-field="directory"]').value.trim();
    if (!host || !username) continue;
    out[name] = {
      host,
      port: Number.isFinite(port) ? port : 22,
      username,
      directory: directory || null,
    };
  }
  clustersConfig = out;
  localStorage.setItem(LS_CLUSTERS, JSON.stringify(clustersConfig));

  // If already logged in, push the new cluster config to the backend live so
  // directory changes take effect for Claude `cd` and the file explorer
  // without needing a logout/login cycle.
  if (runaiConnected && clustersConfig && Object.keys(clustersConfig).length > 0) {
    try {
      await fetch(apiUrl("/api/clusters/configure"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clustersConfig),
      });
      // Re-fetch runtime cluster state (now includes the new directories).
      const resp = await fetch(apiUrl("/api/clusters"));
      if (resp.ok) clusters = await resp.json();
      // Reflect the new directory in the file explorer + screen-hint badge.
      updateFileExplorerLabel();
      updateClaudeScreenHint();
      refreshFileTreeIfOpen();
    } catch (e) {
      console.warn("Failed to apply cluster config to backend:", e);
    }
  }

  closeSettings();
  showBackendInfo();
}

// ── Cluster config + defaults ───────────────────────────────────────────────

async function loadDefaults() {
  // Only cache *successful* fetches so a transient backend-down doesn't
  // poison the cache and leave the Settings UI permanently empty.
  if (!defaultsCache || !defaultsCache.clusters || Object.keys(defaultsCache.clusters).length === 0) {
    try {
      const resp = await fetch(apiUrl("/api/defaults"));
      if (resp.ok) defaultsCache = await resp.json();
    } catch (e) { /* leave defaultsCache null; we'll try again next call */ }
  }

  // Load user-saved clusters (skip if it's empty / malformed).
  const stored = localStorage.getItem(LS_CLUSTERS);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        clustersConfig = parsed;
      }
    } catch (e) { /* ignore */ }
  }

  // If we still have no user config, seed from backend defaults (config.yaml).
  if (!clustersConfig || Object.keys(clustersConfig).length === 0) {
    if (defaultsCache?.clusters) {
      clustersConfig = JSON.parse(JSON.stringify(defaultsCache.clusters));
    }
  }
  return defaultsCache || { clusters: {}, project: {} };
}

function resetClustersToDefaults() {
  if (!defaultsCache?.clusters) return;
  clustersConfig = JSON.parse(JSON.stringify(defaultsCache.clusters));
  renderClusterEditor();
}

function renderClusterEditor() {
  const tbody = document.getElementById("cluster-rows");
  if (!tbody) return;
  tbody.innerHTML = "";
  const defaultDir = defaultsCache?.project?.directory || "";
  for (const [name, cfg] of Object.entries(clustersConfig || {})) {
    addClusterRow({ name, ...cfg }, defaultDir);
  }
}

function addClusterRow(cfg = {}, defaultDir = "") {
  const tbody = document.getElementById("cluster-rows");
  if (!tbody) return;
  if (!defaultDir) defaultDir = defaultsCache?.project?.directory || "";
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input data-field="name" type="text" value="${escAttr(cfg.name)}" placeholder="cluster-name"></td>
    <td><input data-field="host" type="text" value="${escAttr(cfg.host)}" placeholder="10.0.0.1"></td>
    <td><input data-field="port" type="number" min="1" max="65535" value="${cfg.port ?? 22}"></td>
    <td><input data-field="username" type="text" value="${escAttr(cfg.username)}" placeholder="root"></td>
    <td><input data-field="directory" type="text" value="${escAttr(cfg.directory || "")}" placeholder="${escAttr(defaultDir)}"></td>
    <td><button class="cluster-row-remove" title="Remove">✕</button></td>
  `;
  tr.querySelector(".cluster-row-remove").addEventListener("click", () => tr.remove());
  tbody.appendChild(tr);
}

function escAttr(s) {
  return String(s == null ? "" : s).replace(/"/g, "&quot;");
}

/* ── Login / Logout ───────────────────────────────────────────────────────── */

let runaiConnected = false;

async function doLogin() {
  const pw = document.getElementById("password-input").value;
  const statusEl = document.getElementById("login-status");
  const loginBtn = document.getElementById("login-btn");

  if (!pw) {
    statusEl.textContent = "Please enter a password.";
    statusEl.className = "error";
    return;
  }

  loginBtn.disabled = true;
  statusEl.textContent = "Connecting to Salk clusters...";
  statusEl.className = "";

  try {
    // Ensure we have cluster defs to send; if user never opened settings, seed from defaults.
    if (!clustersConfig) await loadDefaults();

    const body = { password: pw };
    if (clustersConfig && Object.keys(clustersConfig).length > 0) {
      body.clusters = clustersConfig;
    }
    const resp = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    const connected = Object.entries(data).filter(([, v]) => v.ok).map(([k]) => k);
    const failed = Object.entries(data).filter(([, v]) => !v.ok);

    if (connected.length === 0) {
      const reason = failed.length ? ` — ${failed.map(([k, v]) => `${k}: ${v.error}`).join("; ")}` : "";
      statusEl.textContent = `Failed to connect to any cluster${reason}`;
      statusEl.className = "error";
      loginBtn.disabled = false;
      return;
    }

    runaiConnected = true;
    let msg = `${connected.length} cluster${connected.length === 1 ? "" : "s"} connected.`;
    if (failed.length > 0) {
      msg += ` Failed: ${failed.map(([k, v]) => `${k} (${v.error})`).join(", ")}`;
    }
    statusEl.textContent = msg;
    statusEl.className = "success";
    setTimeout(() => enterDashboard(), 400);
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}. Is the backend running at ${getBackend() || location.origin}?`;
    statusEl.className = "error";
    loginBtn.disabled = false;
  }
}

function doLogout() {
  for (const t of Object.values(claudeTerminals)) {
    try { t.ws?.close(); } catch (e) {}
    try { t.term?.dispose(); } catch (e) {}
  }
  claudeTerminals = {};
  document.getElementById("claude-terminal-container").innerHTML = "";

  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }

  runaiConnected = false;

  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("password-input").value = "";
  document.getElementById("login-btn").disabled = false;
  document.getElementById("login-status").textContent = "";
  document.getElementById("login-status").className = "";
}

/* ── Dashboard entry ──────────────────────────────────────────────────────── */

async function enterDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  const [cfgResp, clusterResp] = await Promise.all([
    fetch(apiUrl("/api/config")),
    fetch(apiUrl("/api/clusters")),
  ]);
  projectConfig = (await cfgResp.json()).project || {};
  clusters = await clusterResp.json();

  // Sidebar
  const list = document.getElementById("cluster-list");
  list.innerHTML = "";
  for (const [name, info] of Object.entries(clusters)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="status-dot ${info.connected ? "connected" : "disconnected"}"></span><span class="cluster-name">${esc(name)}</span>`;
    li.dataset.cluster = name;
    list.appendChild(li);
  }

  const firstConnected = Object.keys(clusters).find(n => clusters[n].connected) || null;
  activeProcCluster = firstConnected;
  activeClaudeCluster = firstConnected;
  buildSubtabs("proc-cluster-subtabs", () => activeProcCluster, (name) => {
    activeProcCluster = name;
    fetchProcesses();
  });
  buildSubtabs("claude-cluster-subtabs", () => activeClaudeCluster, (name) => {
    activeClaudeCluster = name;
    showClaudeTerminalFor(name);
    updateClaudeScreenHint();
    refreshFileTreeIfOpen();
    // Close the file viewer — its path likely doesn't apply to the new cluster.
    document.getElementById("file-viewer")?.classList.add("hidden");
  });
  updateClaudeScreenHint();

  await fetchAllMetrics();
  renderOverview();
  pollInterval = setInterval(fetchAllMetrics, 5000);
}

function buildSubtabs(containerId, getActive, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  const connected = Object.keys(clusters).filter(n => clusters[n].connected);
  for (const name of connected) {
    const btn = document.createElement("button");
    btn.className = "subtab" + (name === getActive() ? " active" : "");
    btn.textContent = name;
    btn.dataset.cluster = name;
    btn.addEventListener("click", () => {
      // visual update
      el.querySelectorAll(".subtab").forEach(b => b.classList.toggle("active", b.dataset.cluster === name));
      onSelect(name);
    });
    el.appendChild(btn);
  }
}

function refreshFileTreeIfOpen() {
  // Re-label the explorer header to the active cluster's dir, regardless of
  // whether a session has been launched yet.
  updateFileExplorerLabel();
  // Reload the tree only if it's been populated (i.e. a session is/was open).
  const tree = document.getElementById("file-tree");
  if (tree && tree.children.length > 0 && Object.keys(claudeTerminals).length > 0) {
    refreshFileTree();
  }
}

function showClaudeTerminalFor(cluster) {
  const container = document.getElementById("claude-terminal-container");
  if (!container) return;
  for (const child of container.children) {
    child.style.display = child.dataset.cluster === cluster ? "" : "none";
  }
  // Refit the now-visible terminal so xterm reflows to its container size.
  const t = claudeTerminals[cluster];
  if (t?.fitAddon) {
    setTimeout(() => { try { t.fitAddon.fit(); } catch (e) {} }, 50);
  }
}

function claudeSessionName(cluster) {
  // Per-directory screen-session naming. Each (cluster, dir) gets its own
  // session, so changing the Claude dir in Settings creates a brand-new
  // session in the new dir instead of re-attaching the old one (which would
  // keep the original cwd no matter what we `cd` to).
  const base = projectConfig.claude_screen_session || "claude-remote-access";
  const dir = clusterDir(cluster);
  const slug = (dir.split("/").filter(Boolean).pop() || "default")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${base}-${slug}`;
}

function updateClaudeScreenHint() {
  const el = document.getElementById("claude-screen-hint");
  if (!el) return;
  if (!activeClaudeCluster) {
    el.textContent = "";
    return;
  }
  el.textContent = `screen: ${claudeSessionName(activeClaudeCluster)}`;
}

/* ── Tab switching ────────────────────────────────────────────────────────── */

function switchTab(tab) {
  document.querySelectorAll("#tab-bar .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-content").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab}`));

  if (tab === "gpu") renderGPUDetail();
  if (tab === "processes") fetchProcesses();
  if (tab === "claude") fitClaudeTerminal();
}

/* ── Metrics polling ──────────────────────────────────────────────────────── */

async function fetchAllMetrics() {
  const names = Object.entries(clusters).filter(([, v]) => v.connected).map(([k]) => k);
  const fetches = names.map((name) =>
    fetch(apiUrl(`/api/metrics/${name}`)).then((r) => r.json()).then((data) => [name, data])
  );

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status === "fulfilled") {
      const [name, data] = r.value;
      if (!data.error) metricsCache[name] = data;
    }
  }
  renderOverview();
  if (document.getElementById("tab-gpu").classList.contains("active")) {
    renderGPUDetail();
  }
}

/* ── Overview rendering ───────────────────────────────────────────────────── */

function renderOverview() {
  const container = document.getElementById("overview-cards");
  container.innerHTML = "";

  for (const [name, info] of Object.entries(clusters)) {
    container.appendChild(renderClusterCard(name, info));
  }
}

function renderClusterCard(name, info) {
  const card = document.createElement("div");
  card.className = "cluster-card";

  const m = metricsCache[name];
  if (!info.connected || !m) {
    card.innerHTML = `<h3><span class="status-dot disconnected"></span>${esc(name)}</h3><p class="not-connected-msg">${info.connected ? "Waiting for metrics…" : "Not connected"}</p>`;
    return card;
  }

  const sys = m.system || {};
  const gpus = m.gpu || [];
  const memPct = sys.mem_total_mb ? Math.round(sys.mem_used_mb / sys.mem_total_mb * 100) : 0;

  const avgGpuUtil = gpus.length ? Math.round(gpus.reduce((a, g) => a + g.utilization, 0) / gpus.length) : 0;
  const avgGpuMem = gpus.length ? Math.round(gpus.reduce((a, g) => a + (g.memory_total ? g.memory_used / g.memory_total * 100 : 0), 0) / gpus.length) : 0;

  card.innerHTML = `
    <h3><span class="status-dot connected"></span>${esc(name)}</h3>
    ${metricBarHTML("GPU Util (avg)", avgGpuUtil)}
    ${metricBarHTML("GPU Mem (avg)", avgGpuMem)}
    ${metricBarHTML("CPU Load", Math.round(sys.cpu_percent))}
    ${metricBarHTML("RAM", memPct, `${sys.mem_used_mb}/${sys.mem_total_mb} MB`)}
    <div class="metric-row">
      <span class="metric-label">Disk</span>
      <span class="metric-value">${esc(sys.disk_used)} / ${esc(sys.disk_total)} (${esc(sys.disk_percent)})</span>
    </div>
    <div class="gpu-mini-list">
      ${gpus.map((g) => `
        <div class="gpu-mini-row">
          <span>GPU ${g.index}: ${esc(g.name)}</span>
          <span>${g.utilization}% | ${Math.round(g.memory_used)}/${Math.round(g.memory_total)} MiB | ${g.temperature}°C</span>
        </div>
      `).join("")}
    </div>
  `;
  return card;
}

function metricBarHTML(label, pct, valueText) {
  const barColor = pct < 50 ? "bar-green" : pct < 75 ? "bar-yellow" : pct < 90 ? "bar-orange" : "bar-red";
  return `
    <div class="metric-row">
      <span class="metric-label">${label}</span>
      <div class="metric-bar"><div class="metric-bar-fill ${barColor}" style="width:${pct}%"></div></div>
      <span class="metric-value">${valueText || pct + "%"}</span>
    </div>
  `;
}

/* ── GPU detail ───────────────────────────────────────────────────────────── */

function renderGPUDetail() {
  const container = document.getElementById("gpu-detail");
  container.innerHTML = "";

  const sources = Object.entries(clusters)
    .filter(([, info]) => info.connected)
    .map(([name]) => name);

  for (const name of sources) {
    const m = metricsCache[name];
    if (!m || !m.gpu) continue;

    const section = document.createElement("div");
    section.className = "gpu-cluster-section";

    // Cluster heading + summary chips
    const totalGpus = m.gpu.length;
    const totalVramUsed = m.gpu.reduce((s, g) => s + (g.memory_used || 0), 0);
    const totalVramTotal = m.gpu.reduce((s, g) => s + (g.memory_total || 0), 0);
    const totalPower = m.gpu.reduce((s, g) => s + (g.power_draw || 0), 0);
    const totalPowerLimit = m.gpu.reduce((s, g) => s + (g.power_limit || 0), 0);
    const avgUtil = totalGpus ? Math.round(m.gpu.reduce((s, g) => s + (g.utilization || 0), 0) / totalGpus) : 0;
    const driverVersion = m.gpu[0]?.driver_version || "?";
    const activeCount = m.gpu.filter(g => (g.processes || []).length > 0).length;

    section.innerHTML = `
      <div class="gpu-cluster-heading">
        <span class="status-dot connected"></span>
        <span>${esc(name)}</span>
        <span class="gpu-cluster-chips">
          <span class="chip">${totalGpus} GPU${totalGpus === 1 ? "" : "s"}</span>
          <span class="chip">${activeCount} active</span>
          <span class="chip">avg util ${avgUtil}%</span>
          <span class="chip">VRAM ${formatGiB(totalVramUsed)}/${formatGiB(totalVramTotal)}</span>
          <span class="chip">${Math.round(totalPower)}/${Math.round(totalPowerLimit)} W</span>
          <span class="chip">driver ${esc(driverVersion)}</span>
        </span>
      </div>
    `;

    const grid = document.createElement("div");
    grid.className = "gpu-grid";

    for (const g of m.gpu) {
      const memPct = g.memory_total ? Math.round(g.memory_used / g.memory_total * 100) : 0;
      const powerPct = g.power_limit ? Math.round(g.power_draw / g.power_limit * 100) : 0;
      const clockPct = g.clock_graphics_max ? Math.round(g.clock_graphics_cur / g.clock_graphics_max * 100) : 0;

      const card = document.createElement("div");
      card.className = "gpu-card";
      card.innerHTML = `
        <div class="gpu-card-head">
          <h4>GPU ${g.index} <span class="gpu-card-name">${esc(g.name)}</span></h4>
          <span class="gpu-pstate" title="performance state">${esc(g.pstate || "?")}</span>
        </div>

        <div class="gpu-card-body">
          <div class="gpu-card-bars">
            ${metricBarHTML("Util", Math.round(g.utilization))}
            ${metricBarHTML("Mem util", Math.round(g.memory_utilization || 0))}
            ${metricBarHTML("VRAM", memPct, `${formatGiB(g.memory_used)} / ${formatGiB(g.memory_total)}`)}
            ${metricBarHTML("Power", powerPct, `${Math.round(g.power_draw)} / ${Math.round(g.power_limit)} W`)}
            ${metricBarHTML("Clock", clockPct, `${Math.round(g.clock_graphics_cur)} / ${Math.round(g.clock_graphics_max)} MHz`)}
          </div>

          <div class="gpu-stats-grid">
            <div class="gpu-stat-cell">
              <span class="gpu-stat-label">Temp</span>
              <span class="gpu-stat-value ${tempClass(g.temperature)}">${g.temperature ? Math.round(g.temperature) + "°C" : "—"}</span>
            </div>
            <div class="gpu-stat-cell">
              <span class="gpu-stat-label">Fan</span>
              <span class="gpu-stat-value">${g.fan_speed > 0 ? Math.round(g.fan_speed) + "%" : "—"}</span>
            </div>
            <div class="gpu-stat-cell">
              <span class="gpu-stat-label">Mem clk</span>
              <span class="gpu-stat-value">${Math.round(g.clock_memory_cur)} MHz</span>
            </div>
            <div class="gpu-stat-cell">
              <span class="gpu-stat-label">PCIe</span>
              <span class="gpu-stat-value">gen ${esc(g.pcie_gen_cur)} · x${esc(g.pcie_width_cur)}</span>
            </div>
            <div class="gpu-stat-cell">
              <span class="gpu-stat-label">Free VRAM</span>
              <span class="gpu-stat-value">${formatGiB(g.memory_free)}</span>
            </div>
            <div class="gpu-stat-cell">
              <span class="gpu-stat-label">Mode</span>
              <span class="gpu-stat-value">${esc(g.compute_mode || "?")}</span>
            </div>
          </div>
        </div>

        <div class="gpu-processes">
          <h5>Processes (${g.processes.length})</h5>
          ${g.processes.length === 0 ? '<p class="no-processes">No compute processes</p>' :
            `<table class="gpu-proc-table">
              <thead><tr><th>User</th><th>PID</th><th>Runtime</th><th>VRAM</th><th>Command</th></tr></thead>
              <tbody>
                ${g.processes.map((p) => `
                  <tr>
                    <td>${esc(p.user || "?")}</td>
                    <td>${esc(p.pid)}</td>
                    <td>${esc(p.runtime || "?")}</td>
                    <td>${formatGiB(p.memory_mib)}</td>
                    <td class="proc-cmd" title="${esc(p.name)}">${esc(p.name)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>`}
        </div>
      `;
      grid.appendChild(card);
    }

    section.appendChild(grid);
    container.appendChild(section);
  }

  if (!container.children.length) {
    container.innerHTML = "<p>No GPU data available.</p>";
  }
}

function formatGiB(mib) {
  const n = Number(mib) || 0;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GiB`;
  return `${Math.round(n)} MiB`;
}

function tempClass(t) {
  const v = Number(t) || 0;
  if (v >= 80) return "hot";
  if (v >= 65) return "warm";
  return "cool";
}

/* ── Process viewer ───────────────────────────────────────────────────────── */

let currentProcesses = [];
let processSortKey = "mem";
let processSortAsc = false;

async function fetchProcesses() {
  const cluster = activeProcCluster;
  if (!cluster) return;
  try {
    const resp = await fetch(apiUrl(`/api/processes/${cluster}`));
    const data = await resp.json();
    currentProcesses = data.processes || [];
    renderProcessTable();
  } catch (e) {
    currentProcesses = [];
    renderProcessTable();
  }
}

function renderProcessTable() {
  const filter = document.getElementById("proc-filter").value.toLowerCase();
  let procs = currentProcesses;
  if (filter) {
    procs = procs.filter((p) =>
      p.user.toLowerCase().includes(filter) ||
      p.pid.includes(filter) ||
      p.command.toLowerCase().includes(filter)
    );
  }

  procs.sort((a, b) => {
    let va = a[processSortKey], vb = b[processSortKey];
    if (["cpu", "mem", "rss", "pid"].includes(processSortKey)) {
      va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
    }
    if (va < vb) return processSortAsc ? -1 : 1;
    if (va > vb) return processSortAsc ? 1 : -1;
    return 0;
  });

  const tbody = document.querySelector("#process-table tbody");
  tbody.innerHTML = procs.map((p) => `
    <tr>
      <td>${esc(p.user)}</td>
      <td>${esc(p.pid)}</td>
      <td>${esc(p.cpu)}</td>
      <td>${esc(p.mem)}</td>
      <td>${esc(p.rss)}</td>
      <td>${esc(p.command)}</td>
    </tr>
  `).join("");
}

function sortProcessTable(key) {
  if (processSortKey === key) {
    processSortAsc = !processSortAsc;
  } else {
    processSortKey = key;
    processSortAsc = false;
  }
  renderProcessTable();
}

function filterProcesses() {
  renderProcessTable();
}

window.addEventListener("resize", () => {
  fitClaudeTerminal();
});

/* ── Claude terminal ──────────────────────────────────────────────────────── */

async function launchClaude() {
  const cluster = activeClaudeCluster;
  if (!cluster) return;

  const projDir = clusterDir(cluster);
  const sessionName = claudeSessionName(cluster);
  const existing = claudeTerminals[cluster];
  const alive = existing && existing.ws && existing.ws.readyState === WebSocket.OPEN;
  const sameSession = existing && existing.sessionName === sessionName;

  // Live + targeting the same screen session → just bring it forward.
  if (alive && sameSession) {
    showClaudeTerminalFor(cluster);
    initFileExplorer();
    initResizeHandle();
    return;
  }

  // Dead OR the dir changed (=> new sessionName) → tear down the local pane
  // so we can create a fresh one attached to the right remote session.
  if (existing) {
    try { existing.ws?.close(); } catch (e) {}
    try { existing.term?.dispose(); } catch (e) {}
    try { existing.container?.remove(); } catch (e) {}
    delete claudeTerminals[cluster];
  }

  // Create a per-cluster terminal div, stacked inside the container.
  const container = document.getElementById("claude-terminal-container");
  const termDiv = document.createElement("div");
  termDiv.className = "claude-term-instance";
  termDiv.dataset.cluster = cluster;
  termDiv.style.width = "100%";
  termDiv.style.height = "100%";
  // Hide every existing sibling so only this one is visible.
  for (const child of container.children) child.style.display = "none";
  container.appendChild(termDiv);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    theme: currentTermTheme(),
    scrollback: 10000,         // 10k lines of history in the main buffer
    scrollSensitivity: 3,
    fastScrollSensitivity: 8,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termDiv);
  fitAddon.fit();

  const ws = new WebSocket(wsUrl(`/ws/terminal/${cluster}`));

  const claudeUser = projectConfig.claude_user || "devuser";

  ws.onopen = () => {
    term.writeln(`\x1b[32mConnected to ${cluster} — attaching screen "${sessionName}"…\x1b[0m\r`);
    ws.send(`\x01RESIZE:${term.cols},${term.rows}`);

    setTimeout(() => {
      ws.send(`su - ${claudeUser}\n`);
      setTimeout(() => {
        ws.send("exec bash\n");
        setTimeout(() => {
          ws.send(`cd ${projDir}\n`);
          setTimeout(() => {
            // Write a small custom screenrc that:
            //   - sources the user's normal ~/.screenrc if present
            //   - disables alt-buffer switching (so xterm.js mouse-wheel scroll
            //     shows real history instead of stale terminal garbage)
            //   - bumps screen's own scrollback to 100k lines
            // Idempotent: just overwritten each launch.
            ws.send(
              "mkdir -p ~/.config/gpu-access-board && " +
              "{ echo 'source $HOME/.screenrc 2>/dev/null'; " +
                "echo 'termcapinfo xterm* ti@:te@'; " +
                "echo 'defscrollback 100000'; } > ~/.config/gpu-access-board/screenrc\n"
            );
            setTimeout(() => {
              ws.send(`screen -c ~/.config/gpu-access-board/screenrc -ls 2>/dev/null | grep -q '\\.${sessionName}\\b' && screen -c ~/.config/gpu-access-board/screenrc -d -r ${sessionName} || screen -c ~/.config/gpu-access-board/screenrc -S ${sessionName} bash -c 'claude --dangerously-skip-permissions; exec bash'\n`);
            }, 200);
          }, 300);
        }, 300);
      }, 300);
    }, 500);
  };

  ws.onmessage = (ev) => term.write(ev.data);
  ws.onclose = () => term.writeln("\r\n\x1b[31mConnection closed.\x1b[0m");
  ws.onerror = () => term.writeln("\r\n\x1b[31mWebSocket error.\x1b[0m");

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(`\x01RESIZE:${cols},${rows}`);
  });

  // Track the remote screen session name. A Settings change to the cluster's
  // dir produces a different sessionName next time → Launch builds a fresh
  // WS and creates/attaches the right session.
  claudeTerminals[cluster] = { term, ws, fitAddon, container: termDiv, sessionName };

  initFileExplorer();
  initResizeHandle();
}

function fitClaudeTerminal() {
  const t = claudeTerminals[activeClaudeCluster];
  if (!t?.fitAddon) return;
  setTimeout(() => {
    try { t.fitAddon.fit(); } catch (e) {}
  }, 50);
}

/* ── File explorer ─────────────────────────────────────────────────────────── */

function getFileCluster() {
  return activeClaudeCluster;
}

async function loadFileTree(path, parentEl, depth) {
  const cluster = getFileCluster();
  if (!cluster) return;

  try {
    const resp = await fetch(apiUrl(`/api/files/${cluster}?path=${encodeURIComponent(path)}`));
    const data = await resp.json();
    if (data.error) return;

    parentEl.innerHTML = "";
    for (const entry of data.entries) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;

      if (entry.is_dir) {
        const wrapper = document.createElement("div");
        wrapper.className = `depth-${depth}`;

        const row = document.createElement("div");
        row.className = "file-entry dir";
        row.innerHTML = `<span class="file-icon">&#9656;</span><span class="file-name">${esc(entry.name)}</span>`;

        const actions = document.createElement("span");
        actions.className = "file-actions";
        actions.innerHTML = `<button class="file-action-btn" title="Download">⬇</button><button class="file-action-btn" title="New File">+</button><button class="file-action-btn" title="Rename">✏</button><button class="file-action-btn" title="Delete">✕</button>`;
        const [dlBtn, newBtn, renBtn, delBtn] = actions.querySelectorAll("button");
        dlBtn.addEventListener("click", (e) => { e.stopPropagation(); downloadFolder(entryPath, entry.name); });
        newBtn.addEventListener("click", (e) => { e.stopPropagation(); createNewItem(entryPath, false); });
        renBtn.addEventListener("click", (e) => { e.stopPropagation(); renameFile(entryPath, entry.name); });
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteFile(entryPath, entry.name, true); });
        row.appendChild(actions);

        const children = document.createElement("div");
        children.className = "file-children";

        let loaded = false;
        row.addEventListener("click", async () => {
          if (!loaded) {
            await loadFileTree(entryPath, children, depth + 1);
            loaded = true;
          }
          const isOpen = children.classList.toggle("open");
          row.querySelector(".file-icon").innerHTML = isOpen ? "&#9662;" : "&#9656;";
        });

        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showContextMenu(e, entryPath, entry.name, true);
        });

        wrapper.appendChild(row);
        wrapper.appendChild(children);
        parentEl.appendChild(wrapper);
      } else {
        const wrapper = document.createElement("div");
        wrapper.className = `depth-${depth}`;

        const isMd = entry.name.endsWith(".md");
        const isImg = isImageFile(entry.name);
        const row = document.createElement("div");
        row.className = `file-entry${isMd ? " md-file" : ""}`;

        let icon = "&#128196;";
        if (isImg) icon = "&#128247;";
        else if (isMd) icon = "&#128214;";
        else if (entry.name.endsWith(".py")) icon = "&#128013;";
        else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) icon = "&#9881;";
        else if (entry.name.endsWith(".json")) icon = "{ }";

        row.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${esc(entry.name)}</span>`;

        const actions = document.createElement("span");
        actions.className = "file-actions";
        actions.innerHTML = `<button class="file-action-btn" title="Download">⬇</button><button class="file-action-btn" title="Rename">✏</button><button class="file-action-btn" title="Delete">✕</button>`;
        const [dlBtn, renBtn, delBtn] = actions.querySelectorAll("button");
        dlBtn.addEventListener("click", (e) => { e.stopPropagation(); downloadFile(entryPath, entry.name); });
        renBtn.addEventListener("click", (e) => { e.stopPropagation(); renameFile(entryPath, entry.name); });
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteFile(entryPath, entry.name, false); });
        row.appendChild(actions);

        row.addEventListener("click", () => openFile(entryPath, entry.name));

        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showContextMenu(e, entryPath, entry.name, false);
        });

        wrapper.appendChild(row);
        parentEl.appendChild(wrapper);
      }
    }
  } catch (e) {
    parentEl.innerHTML = `<div style="padding:12px;color:var(--red);font-size:0.8rem">Failed to load</div>`;
  }
}

async function openFile(path, name) {
  const cluster = getFileCluster();
  if (!cluster) return;

  const viewer = document.getElementById("file-viewer");
  const nameEl = document.getElementById("file-viewer-name");
  const contentEl = document.getElementById("file-viewer-content");

  // Make sure the close button has a handler even before initFileExplorer
  // (it's normally wired in launchClaude → initFileExplorer, but the user
  // can switch cluster sub-tabs and click a file before launching there).
  const closeBtn = document.getElementById("file-viewer-close");
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.onclick = () => viewer.classList.add("hidden");
    closeBtn.dataset.wired = "1";
  }

  currentOpenFilePath = path;
  nameEl.textContent = name;
  contentEl.textContent = "Loading…";
  contentEl.className = "";
  viewer.classList.remove("hidden");

  document.getElementById("file-viewer-download").onclick = () => downloadFile(path, name);

  if (isImageFile(name)) {
    const url = apiUrl(`/api/image/${cluster}?path=${encodeURIComponent(path)}`);
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        contentEl.textContent = `Error: ${resp.status} ${resp.statusText} on ${url}`;
        contentEl.className = "plaintext";
        return;
      }
      const data = await resp.json();
      if (data.error) {
        contentEl.textContent = `Error: ${data.error}`;
        contentEl.className = "plaintext";
        return;
      }
      contentEl.className = "image-view";
      contentEl.innerHTML = `<img src="data:${data.mime};base64,${data.data}" alt="${esc(name)}">`;
    } catch (e) {
      contentEl.textContent = `Error: ${e.message} (fetching ${url})`;
      contentEl.className = "plaintext";
    }
    return;
  }

  const url = apiUrl(`/api/file/${cluster}?path=${encodeURIComponent(path)}`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      contentEl.textContent = `Error: ${resp.status} ${resp.statusText} on ${url}`;
      contentEl.className = "plaintext";
      return;
    }
    const data = await resp.json();
    if (data.error) {
      contentEl.textContent = `Error: ${data.error}`;
      contentEl.className = "plaintext";
      return;
    }

    // Never silently blank — text vs empty vs whitespace-only is otherwise
    // indistinguishable to the user.
    if (data.content == null || data.content === "") {
      contentEl.textContent = "(empty file)";
      contentEl.className = "plaintext";
      return;
    }

    if (name.endsWith(".md")) {
      contentEl.className = "markdown";
      contentEl.innerHTML = marked.parse(data.content);
    } else {
      contentEl.className = "plaintext";
      contentEl.textContent = data.content;
    }
  } catch (e) {
    contentEl.textContent = `Error: ${e.message}`;
    contentEl.className = "plaintext";
  }
}

function clusterDir(cluster) {
  return (clusters[cluster] && clusters[cluster].directory)
    || projectConfig.directory
    || "~";
}

function updateFileExplorerLabel() {
  const cluster = activeClaudeCluster;
  const labelEl = document.getElementById("file-explorer-path");
  if (!cluster || !labelEl) return;
  const dir = clusterDir(cluster);
  labelEl.textContent = dir.split("/").filter(Boolean).pop() || dir;
}

function initFileExplorer() {
  const cluster = getFileCluster();
  if (!cluster) return;

  updateFileExplorerLabel();
  const tree = document.getElementById("file-tree");
  tree.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:0.8rem">Loading...</div>`;
  loadFileTree("", tree, 0);

  document.getElementById("file-viewer-close").onclick = () => {
    document.getElementById("file-viewer").classList.add("hidden");
  };

  document.getElementById("fe-new-file").onclick = () => createNewItem("", false);
  document.getElementById("fe-new-folder").onclick = () => createNewItem("", true);
}

/* ── Resize handle ─────────────────────────────────────────────────────────── */

function initResizeHandle() {
  if (resizeHandleInitialized) return;
  const handle = document.getElementById("resize-handle");
  const fileExplorer = document.getElementById("file-explorer");
  if (!handle || !fileExplorer) return;
  resizeHandleInitialized = true;

  let startX, startWidth;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = fileExplorer.offsetWidth;
    handle.classList.add("active");
    document.body.classList.add("resizing");

    const onMouseMove = (e) => {
      const delta = startX - e.clientX;
      const newWidth = Math.min(600, Math.max(160, startWidth + delta));
      fileExplorer.style.width = newWidth + "px";
    };

    const onMouseUp = () => {
      handle.classList.remove("active");
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      fitClaudeTerminal();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

/* ── Context menu ──────────────────────────────────────────────────────────── */

function hideContextMenu() {
  const existing = document.querySelector(".context-menu");
  if (existing) existing.remove();
}

function showContextMenu(e, path, name, isDir) {
  hideContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items = [];

  if (!isDir) {
    items.push({ label: "Open", icon: "📄", action: () => openFile(path, name) });
    items.push({ label: "Download", icon: "⬇", action: () => downloadFile(path, name) });
  } else {
    items.push({ label: "Download", icon: "⬇", action: () => downloadFolder(path, name) });
  }

  items.push({ separator: true });
  items.push({ label: "Rename", icon: "✏️", action: () => renameFile(path, name) });
  items.push({ label: "Delete", icon: "🗑", action: () => deleteFile(path, name, isDir), danger: true });
  items.push({ separator: true });

  if (isDir) {
    items.push({ label: "New File", icon: "📄", action: () => createNewItem(path, false) });
    items.push({ label: "New Folder", icon: "📁", action: () => createNewItem(path, true) });
  } else {
    const parentPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
    items.push({ label: "New File", icon: "📄", action: () => createNewItem(parentPath, false) });
    items.push({ label: "New Folder", icon: "📁", action: () => createNewItem(parentPath, true) });
  }

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "context-menu-item" + (item.danger ? " danger" : "");
    el.innerHTML = `<span>${item.icon}</span>${item.label}`;
    el.addEventListener("click", () => {
      hideContextMenu();
      item.action();
    });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
  if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 4;
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  setTimeout(() => {
    document.addEventListener("click", hideContextMenu, { once: true });
  }, 0);
}

/* ── File operations ───────────────────────────────────────────────────────── */

function downloadFile(path, name) {
  const cluster = getFileCluster();
  if (!cluster) return;
  const a = document.createElement("a");
  a.href = apiUrl(`/api/download/${cluster}?path=${encodeURIComponent(path)}`);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadFolder(path, name) {
  const cluster = getFileCluster();
  if (!cluster) return;
  const a = document.createElement("a");
  a.href = apiUrl(`/api/download-folder/${cluster}?path=${encodeURIComponent(path)}`);
  a.download = `${name}.tar.gz`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function renameFile(path, name) {
  const cluster = getFileCluster();
  if (!cluster) return;

  const newName = prompt(`Rename "${name}" to:`, name);
  if (!newName || newName === name) return;

  try {
    const resp = await fetch(apiUrl(`/api/rename/${cluster}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_path: path, new_name: newName }),
    });
    const data = await resp.json();
    if (data.error) {
      alert(`Rename failed: ${data.error}`);
      return;
    }
    refreshFileTree();
  } catch (e) {
    alert(`Rename failed: ${e.message}`);
  }
}

async function deleteFile(path, name, isDir) {
  const cluster = getFileCluster();
  if (!cluster) return;

  const type = isDir ? "folder" : "file";
  if (!confirm(`Delete ${type} "${name}"? This cannot be undone.`)) return;

  try {
    const resp = await fetch(apiUrl(`/api/delete/${cluster}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await resp.json();
    if (data.error) {
      alert(`Delete failed: ${data.error}`);
      return;
    }
    if (currentOpenFilePath === path) {
      document.getElementById("file-viewer").classList.add("hidden");
      currentOpenFilePath = null;
    }
    refreshFileTree();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

async function createNewItem(parentPath, isDir) {
  const cluster = getFileCluster();
  if (!cluster) return;

  const type = isDir ? "folder" : "file";
  const name = prompt(`New ${type} name:`);
  if (!name) return;

  try {
    const resp = await fetch(apiUrl(`/api/create/${cluster}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parentPath, name, is_dir: isDir }),
    });
    const data = await resp.json();
    if (data.error) {
      alert(`Create failed: ${data.error}`);
      return;
    }
    refreshFileTree();
  } catch (e) {
    alert(`Create failed: ${e.message}`);
  }
}

function refreshFileTree() {
  const tree = document.getElementById("file-tree");
  tree.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:0.8rem">Loading...</div>`;
  loadFileTree("", tree, 0);
}

/* ── Theme ─────────────────────────────────────────────────────────────────── */

const THEME_KEY = "gpu-dashboard-theme";

const TERM_THEMES = {
  dark:  { background: "#0f1116", foreground: "#e6e8ec", cursor: "#e6e8ec", cursorAccent: "#0f1116", selectionBackground: "#3b3f55" },
  light: { background: "#ffffff", foreground: "#1f2330", cursor: "#1f2330", cursorAccent: "#ffffff", selectionBackground: "#cfd6ff" },
};

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "dark";
  applyTheme(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
  const emoji = theme === "dark" ? "☀️" : "🌙";
  document.getElementById("theme-toggle").textContent = emoji;
  document.getElementById("login-theme-toggle").textContent = emoji;

  const termTheme = TERM_THEMES[theme];
  for (const t of Object.values(claudeTerminals)) {
    if (t.term) t.term.options.theme = termTheme;
  }
}

function currentTermTheme() {
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  return TERM_THEMES[theme];
}

/* ── Utility ──────────────────────────────────────────────────────────────── */

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
