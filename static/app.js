/* ── State ─────────────────────────────────────────────────────────────────── */

let clusters = {};          // {name: {host, connected}}
let metricsCache = {};      // {name: {gpu: [...], system: {...}}}
let pollInterval = null;
let terminals = {};          // {name: {term, ws, fitAddon}}
let activeTerminal = null;
let claudeTerminal = null;  // {term, ws, fitAddon, cluster}
let projectConfig = {};     // from /api/config
let dsmlpConfig = {};       // from /api/dsmlp/config
let dsmlpConnected = false;
let dsmlpPod = null;

/* ── Boot ──────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  // Login
  document.getElementById("login-btn").addEventListener("click", doLogin);
  document.getElementById("password-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  document.getElementById("dsmlp-launch-btn").addEventListener("click", doDSMLPLaunch);

  // Login mode dropdown — show/hide fields
  document.getElementById("login-mode").addEventListener("change", updateLoginFields);
  updateLoginFields();

  // Tabs
  document.querySelectorAll("#tab-bar .tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Process table sorting
  document.querySelectorAll("#process-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => sortProcessTable(th.dataset.sort));
  });

  // Process filter
  document.getElementById("proc-filter").addEventListener("input", filterProcesses);

  // Logout
  document.getElementById("logout-btn").addEventListener("click", doLogout);

  // Theme toggle (both login screen and dashboard)
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("login-theme-toggle").addEventListener("click", toggleTheme);
  loadTheme();

  // Cluster select change
  document.getElementById("proc-cluster-select").addEventListener("change", fetchProcesses);

  // Claude tab
  document.getElementById("claude-connect-btn").addEventListener("click", launchClaude);
});

function updateLoginFields() {
  const mode = document.getElementById("login-mode").value;
  const runaiFields = document.getElementById("runai-fields");
  const dsmlpFields = document.getElementById("dsmlp-fields");

  if (mode === "runai") {
    runaiFields.classList.remove("hidden");
    dsmlpFields.classList.add("hidden");
  } else if (mode === "dsmlp") {
    runaiFields.classList.add("hidden");
    dsmlpFields.classList.remove("hidden");
  } else {
    // both
    runaiFields.classList.remove("hidden");
    dsmlpFields.classList.remove("hidden");
  }
}

/* ── Login / Logout ───────────────────────────────────────────────────────── */

let runaiConnected = false;

async function doLogin() {
  const mode = document.getElementById("login-mode").value;
  const statusEl = document.getElementById("login-status");
  const loginBtn = document.getElementById("login-btn");

  const needsRunai = mode === "runai" || mode === "both";
  const needsDsmlp = mode === "dsmlp" || mode === "both";

  // Validate
  if (needsRunai) {
    const pw = document.getElementById("password-input").value;
    if (!pw) { statusEl.textContent = "Please enter a password."; statusEl.className = "error"; return; }
  }

  loginBtn.disabled = true;
  let messages = [];

  // RunAI connect
  if (needsRunai) {
    const pw = document.getElementById("password-input").value;
    statusEl.textContent = "Connecting to RunAI clusters...";
    statusEl.className = "";

    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();

      const connected = Object.entries(data).filter(([, v]) => v.ok).map(([k]) => k);
      const failed = Object.entries(data).filter(([, v]) => !v.ok);

      if (connected.length === 0) {
        messages.push("RunAI: failed to connect to any cluster.");
      } else {
        runaiConnected = true;
        let msg = `RunAI: ${connected.length} cluster(s) connected.`;
        if (failed.length > 0) {
          msg += ` Failed: ${failed.map(([k, v]) => `${k} (${v.error})`).join(", ")}`;
        }
        messages.push(msg);
      }
    } catch (e) {
      messages.push(`RunAI error: ${e.message}`);
    }
  }

  // DSMLP connect
  if (needsDsmlp) {
    statusEl.textContent = "Connecting to DSMLP (approve Duo push on your phone)...";
    statusEl.className = "launching";

    try {
      const resp = await fetch("/api/dsmlp/login", { method: "POST" });
      const data = await resp.json();

      if (!data.connected) {
        messages.push(`DSMLP: ${data.error}`);
      } else {
        dsmlpConnected = true;
        dsmlpPod = data.pod;
        if (dsmlpPod) {
          messages.push(`DSMLP: connected. Pod: ${dsmlpPod}`);
        } else {
          messages.push("DSMLP: connected. No running pod — use Launch Pod.");
          document.getElementById("dsmlp-launch-btn").classList.remove("hidden");
        }
      }
    } catch (e) {
      messages.push(`DSMLP error: ${e.message}`);
    }
  }

  statusEl.textContent = messages.join(" | ");

  // If anything connected, enter dashboard
  const anyConnected = runaiConnected || (dsmlpConnected && dsmlpPod);
  if (anyConnected) {
    statusEl.className = "success";
    setTimeout(() => enterDashboard(), 500);
  } else if (dsmlpConnected && !dsmlpPod) {
    // Connected to DSMLP but no pod — wait for launch
    statusEl.className = "";
    loginBtn.disabled = false;
  } else {
    statusEl.className = "error";
    loginBtn.disabled = false;
  }
}

async function doDSMLPLaunch() {
  const statusEl = document.getElementById("login-status");
  const launchBtn = document.getElementById("dsmlp-launch-btn");
  statusEl.textContent = "Launching pod (this may take up to 60s)...";
  statusEl.className = "launching";
  launchBtn.disabled = true;

  try {
    const resp = await fetch("/api/dsmlp/launch", { method: "POST" });
    const data = await resp.json();

    if (!data.ok) {
      statusEl.textContent = `Launch failed: ${data.error}`;
      statusEl.className = "error";
      launchBtn.disabled = false;
      return;
    }

    dsmlpPod = data.pod;
    statusEl.textContent = `Pod running: ${dsmlpPod}`;
    statusEl.className = "success";
    launchBtn.classList.add("hidden");
    setTimeout(() => enterDashboard(), 500);
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.className = "error";
    launchBtn.disabled = false;
  }
}

function doLogout() {
  // Close all terminal WebSockets
  Object.values(terminals).forEach(({ ws, term }) => {
    if (ws) ws.close();
    if (term) term.dispose();
  });
  terminals = {};
  activeTerminal = null;

  // Close claude terminal
  if (claudeTerminal) {
    if (claudeTerminal.ws) claudeTerminal.ws.close();
    if (claudeTerminal.term) claudeTerminal.term.dispose();
    claudeTerminal = null;
  }
  document.getElementById("claude-terminal-container").innerHTML = "";

  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }

  // Reset state
  runaiConnected = false;
  dsmlpConnected = false;
  dsmlpPod = null;

  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("password-input").value = "";
  document.getElementById("login-btn").disabled = false;
  document.getElementById("login-status").textContent = "";
  document.getElementById("dsmlp-launch-btn").classList.add("hidden");
  updateLoginFields();
}

/* ── Dashboard entry ──────────────────────────────────────────────────────── */

async function enterDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  // Fetch config and cluster list
  const [cfgResp, clusterResp, dsmlpCfgResp] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/clusters"),
    fetch("/api/dsmlp/config"),
  ]);
  const cfgData = await cfgResp.json();
  projectConfig = cfgData.project || {};
  const dsmlpCfgData = await dsmlpCfgResp.json();
  dsmlpConfig = dsmlpCfgData.dsmlp || {};

  // Only include RunAI clusters if RunAI was connected
  if (runaiConnected) {
    clusters = await clusterResp.json();
  } else {
    clusters = {};
  }

  // Populate sidebar
  const list = document.getElementById("cluster-list");
  list.innerHTML = "";

  // RunAI clusters (only if connected)
  if (runaiConnected) {
    for (const [name, info] of Object.entries(clusters)) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="status-dot ${info.connected ? "connected" : "disconnected"}"></span>${name}`;
      li.dataset.cluster = name;
      list.appendChild(li);
    }
  }

  // DSMLP entry in sidebar (only if connected with pod)
  if (dsmlpConnected && dsmlpPod) {
    if (runaiConnected) {
      const sep = document.createElement("li");
      sep.className = "sidebar-separator";
      list.appendChild(sep);
    }

    const li = document.createElement("li");
    li.innerHTML = `<span class="status-dot connected"></span>dsmlp (UCSD)`;
    li.dataset.cluster = "dsmlp";
    list.appendChild(li);
  }

  // Populate cluster selects
  populateSelect("proc-cluster-select");
  populateSelect("claude-cluster-select");

  // Build terminal tabs and auto-init the first one
  buildTerminalTabs();
  if (activeTerminal) {
    initTerminal(activeTerminal);
  }

  // Fetch metrics immediately and start polling
  await fetchAllMetrics();
  renderOverview();
  pollInterval = setInterval(fetchAllMetrics, 5000);
}

function populateSelect(id) {
  const sel = document.getElementById(id);
  sel.innerHTML = "";
  for (const name of Object.keys(clusters)) {
    if (clusters[name].connected) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  }
  // Add DSMLP option if connected
  if (dsmlpConnected && dsmlpPod) {
    const opt = document.createElement("option");
    opt.value = "dsmlp";
    opt.textContent = "dsmlp (UCSD)";
    sel.appendChild(opt);
  }
}

/* ── Tab switching ────────────────────────────────────────────────────────── */

function switchTab(tab) {
  document.querySelectorAll("#tab-bar .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-content").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab}`));

  if (tab === "gpu") renderGPUDetail();
  if (tab === "processes") fetchProcesses();
  if (tab === "terminal") fitActiveTerminal();
  if (tab === "claude") fitClaudeTerminal();
}

/* ── Metrics polling ──────────────────────────────────────────────────────── */

async function fetchAllMetrics() {
  const fetches = [];

  // RunAI clusters
  const names = Object.entries(clusters).filter(([, v]) => v.connected).map(([k]) => k);
  fetches.push(...names.map((name) =>
    fetch(`/api/metrics/${name}`).then((r) => r.json()).then((data) => [name, data])
  ));

  // DSMLP
  if (dsmlpConnected && dsmlpPod) {
    fetches.push(
      fetch("/api/dsmlp/metrics").then((r) => r.json()).then((data) => ["dsmlp", data])
    );
  }

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

function getAllClusterEntries() {
  // Returns array of [name, {connected}] for both RunAI and DSMLP
  const entries = Object.entries(clusters);
  if (dsmlpConnected && dsmlpPod) {
    entries.push(["dsmlp (UCSD)", { connected: true, _isDsmlp: true }]);
  }
  return entries;
}

function renderOverview() {
  const container = document.getElementById("overview-cards");
  container.innerHTML = "";

  for (const [name, info] of Object.entries(clusters)) {
    container.appendChild(renderClusterCard(name, info));
  }

  // DSMLP card
  if (dsmlpConnected && dsmlpPod) {
    container.appendChild(renderClusterCard("dsmlp", { connected: true }));
  }
}

function renderClusterCard(name, info) {
  const card = document.createElement("div");
  card.className = "cluster-card";
  const displayName = name === "dsmlp" ? "dsmlp (UCSD)" : name;

  const m = metricsCache[name];
  if (!info.connected || !m) {
    card.innerHTML = `<h3><span class="status-dot disconnected"></span>${displayName}</h3><p class="not-connected-msg">Not connected</p>`;
    return card;
  }

  const sys = m.system;
  const gpus = m.gpu;
  const memPct = sys.mem_total_mb ? Math.round(sys.mem_used_mb / sys.mem_total_mb * 100) : 0;

  const avgGpuUtil = gpus.length ? Math.round(gpus.reduce((a, g) => a + g.utilization, 0) / gpus.length) : 0;
  const avgGpuMem = gpus.length ? Math.round(gpus.reduce((a, g) => a + (g.memory_total ? g.memory_used / g.memory_total * 100 : 0), 0) / gpus.length) : 0;

  card.innerHTML = `
    <h3><span class="status-dot connected"></span>${displayName}</h3>
    ${metricBarHTML("GPU Util (avg)", avgGpuUtil)}
    ${metricBarHTML("GPU Mem (avg)", avgGpuMem)}
    ${metricBarHTML("CPU Load", Math.round(sys.cpu_percent))}
    ${metricBarHTML("RAM", memPct, `${sys.mem_used_mb}/${sys.mem_total_mb} MB`)}
    <div class="metric-row">
      <span class="metric-label">Disk</span>
      <span class="metric-value">${sys.disk_used} / ${sys.disk_total} (${sys.disk_percent})</span>
    </div>
    <div class="gpu-mini-list">
      ${gpus.map((g) => `
        <div class="gpu-mini-row">
          <span>GPU ${g.index}: ${g.name}</span>
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

  // All sources: RunAI clusters + DSMLP
  const sources = [];
  for (const [name, info] of Object.entries(clusters)) {
    if (info.connected) sources.push(name);
  }
  if (dsmlpConnected && dsmlpPod) sources.push("dsmlp");

  for (const name of sources) {
    const m = metricsCache[name];
    if (!m || !m.gpu) continue;

    const displayName = name === "dsmlp" ? "dsmlp (UCSD)" : name;
    const section = document.createElement("div");
    section.className = "gpu-cluster-section";
    section.innerHTML = `<h3 class="gpu-cluster-heading"><span class="status-dot connected"></span>${displayName}</h3>`;

    const grid = document.createElement("div");
    grid.className = "gpu-grid";

    for (const g of m.gpu) {
      const memPct = g.memory_total ? Math.round(g.memory_used / g.memory_total * 100) : 0;
      const card = document.createElement("div");
      card.className = "gpu-card";
      card.innerHTML = `
        <h4>GPU ${g.index}: ${g.name}</h4>
        ${metricBarHTML("Utilization", Math.round(g.utilization))}
        ${metricBarHTML("Memory", memPct, `${Math.round(g.memory_used)} / ${Math.round(g.memory_total)} MiB`)}
        <div class="gpu-stats-inline">
          <span class="gpu-stat"><strong>${g.temperature}°C</strong> temp</span>
          <span class="gpu-stat"><strong>${g.power_draw} W</strong> power</span>
        </div>
        <div class="gpu-processes">
          <h5>Processes (${g.processes.length})</h5>
          ${g.processes.length === 0 ? '<p class="no-processes">No compute processes</p>' :
            g.processes.map((p) => `
              <div class="gpu-proc-row">
                <span>PID ${p.pid}: ${p.name}</span>
                <span>${p.memory_mib} MiB</span>
              </div>
            `).join("")}
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

/* ── Process viewer ───────────────────────────────────────────────────────── */

let currentProcesses = [];
let processSortKey = "mem";
let processSortAsc = false;

async function fetchProcesses() {
  const cluster = document.getElementById("proc-cluster-select").value;
  if (!cluster) return;
  try {
    const url = cluster === "dsmlp" ? "/api/dsmlp/processes" : `/api/processes/${cluster}`;
    const resp = await fetch(url);
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

/* ── Terminal ─────────────────────────────────────────────────────────────── */

function buildTerminalTabs() {
  const tabsContainer = document.getElementById("terminal-tabs");
  const termContainer = document.getElementById("terminal-container");
  tabsContainer.innerHTML = "";
  termContainer.innerHTML = "";

  const connectedClusters = Object.entries(clusters).filter(([, v]) => v.connected).map(([k]) => k);

  // Add DSMLP
  if (dsmlpConnected && dsmlpPod) {
    connectedClusters.push("dsmlp");
  }

  connectedClusters.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.className = "term-tab" + (i === 0 ? " active" : "");
    btn.textContent = name === "dsmlp" ? "dsmlp (UCSD)" : name;
    btn.dataset.termName = name;
    btn.addEventListener("click", () => switchTerminal(name));
    tabsContainer.appendChild(btn);

    const div = document.createElement("div");
    div.className = "term-instance" + (i === 0 ? " active" : "");
    div.id = `term-${name}`;
    termContainer.appendChild(div);

    terminals[name] = { term: null, ws: null, fitAddon: null, initialized: false };
  });

  if (connectedClusters.length > 0) {
    activeTerminal = connectedClusters[0];
  }
}

function switchTerminal(name) {
  activeTerminal = name;

  document.querySelectorAll(".term-tab").forEach((b) => b.classList.toggle("active", b.dataset.termName === name));
  document.querySelectorAll(".term-instance").forEach((d) => d.classList.toggle("active", d.id === `term-${name}`));

  initTerminal(name);
  fitActiveTerminal();
}

function initTerminal(name) {
  if (terminals[name].initialized) return;
  terminals[name].initialized = true;

  const container = document.getElementById(`term-${name}`);
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    theme: currentTermTheme(),
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const isDsmlp = name === "dsmlp";
  const wsUrl = isDsmlp
    ? `${proto}//${location.host}/ws/dsmlp/terminal`
    : `${proto}//${location.host}/ws/terminal/${name}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const displayName = isDsmlp ? "dsmlp (UCSD)" : name;
    term.writeln(`\x1b[32mConnected to ${displayName}\x1b[0m\r`);
    ws.send(`\x01RESIZE:${term.cols},${term.rows}`);

    // Auto-navigate and attach screen session
    const cfg = isDsmlp ? (dsmlpConfig.project || {}) : projectConfig;
    const projDir = cfg.directory || "~";
    const screenName = cfg.screen_session || "train-vqvae";
    setTimeout(() => {
      ws.send(`cd ${projDir}\n`);
      setTimeout(() => ws.send(`screen -ls | grep -q ${screenName} && screen -d -r ${screenName}\n`), 300);
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

  terminals[name] = { term, ws, fitAddon, initialized: true };
}

function fitActiveTerminal() {
  if (!activeTerminal || !terminals[activeTerminal]?.fitAddon) return;
  setTimeout(() => {
    try { terminals[activeTerminal].fitAddon.fit(); } catch (e) {}
  }, 50);
}

window.addEventListener("resize", () => {
  fitActiveTerminal();
  fitClaudeTerminal();
});

/* ── Claude terminal ──────────────────────────────────────────────────────── */

function launchClaude() {
  const cluster = document.getElementById("claude-cluster-select").value;
  if (!cluster) return;

  if (claudeTerminal) {
    if (claudeTerminal.ws) claudeTerminal.ws.close();
    if (claudeTerminal.term) claudeTerminal.term.dispose();
    claudeTerminal = null;
  }

  const container = document.getElementById("claude-terminal-container");
  container.innerHTML = "";

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    theme: currentTermTheme(),
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const isDsmlp = cluster === "dsmlp";
  const wsUrl = isDsmlp
    ? `${proto}//${location.host}/ws/dsmlp/terminal`
    : `${proto}//${location.host}/ws/terminal/${cluster}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const displayName = isDsmlp ? "dsmlp (UCSD)" : cluster;
    term.writeln(`\x1b[32mConnected to ${displayName} — launching Claude...\x1b[0m\r`);
    ws.send(`\x01RESIZE:${term.cols},${term.rows}`);

    const cfg = isDsmlp ? (dsmlpConfig.project || {}) : projectConfig;
    const projDir = cfg.directory || "~";
    const claudeUser = cfg.claude_user || "devuser";
    const claudeScreen = cfg.claude_screen_session || "claude";

    setTimeout(() => {
      ws.send(`su - ${claudeUser}\n`);
      setTimeout(() => {
        ws.send("exec bash\n");
        setTimeout(() => {
          ws.send(`cd ${projDir}\n`);
          setTimeout(() => {
            ws.send(`screen -ls 2>/dev/null | grep -q '\\.${claudeScreen}\\b' && screen -d -r ${claudeScreen} || screen -S ${claudeScreen} bash -c 'claude --dangerously-skip-permissions; exec bash'\n`);
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

  claudeTerminal = { term, ws, fitAddon, cluster };

  initFileExplorer();
}

function fitClaudeTerminal() {
  if (!claudeTerminal?.fitAddon) return;
  setTimeout(() => {
    try { claudeTerminal.fitAddon.fit(); } catch (e) {}
  }, 50);
}

/* ── File explorer ─────────────────────────────────────────────────────────── */

function getFileCluster() {
  return document.getElementById("claude-cluster-select").value;
}

function fileApiUrl(endpoint, cluster) {
  if (cluster === "dsmlp") {
    return `/api/dsmlp/${endpoint}`;
  }
  return `/api/${endpoint}/${cluster}`;
}

async function loadFileTree(path, parentEl, depth) {
  const cluster = getFileCluster();
  if (!cluster) return;

  try {
    const url = cluster === "dsmlp"
      ? `/api/dsmlp/files?path=${encodeURIComponent(path)}`
      : `/api/files/${cluster}?path=${encodeURIComponent(path)}`;
    const resp = await fetch(url);
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
        row.innerHTML = `<span class="file-icon">&#9656;</span>${esc(entry.name)}`;

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

        wrapper.appendChild(row);
        wrapper.appendChild(children);
        parentEl.appendChild(wrapper);
      } else {
        const wrapper = document.createElement("div");
        wrapper.className = `depth-${depth}`;

        const isMd = entry.name.endsWith(".md");
        const row = document.createElement("div");
        row.className = `file-entry${isMd ? " md-file" : ""}`;

        let icon = "&#128196;";
        if (isMd) icon = "&#128214;";
        else if (entry.name.endsWith(".py")) icon = "&#128013;";
        else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) icon = "&#9881;";
        else if (entry.name.endsWith(".json")) icon = "{ }";

        row.innerHTML = `<span class="file-icon">${icon}</span>${esc(entry.name)}`;
        row.addEventListener("click", () => openFile(entryPath, entry.name));

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

  nameEl.textContent = name;
  contentEl.textContent = "Loading...";
  contentEl.className = "";
  viewer.classList.remove("hidden");

  try {
    const url = cluster === "dsmlp"
      ? `/api/dsmlp/file?path=${encodeURIComponent(path)}`
      : `/api/file/${cluster}?path=${encodeURIComponent(path)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) {
      contentEl.textContent = `Error: ${data.error}`;
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

function initFileExplorer() {
  const cluster = getFileCluster();
  if (!cluster) return;

  const isDsmlp = cluster === "dsmlp";
  const cfg = isDsmlp ? (dsmlpConfig.project || {}) : projectConfig;
  const dir = cfg.directory || "~";
  document.getElementById("file-explorer-path").textContent = dir.split("/").filter(Boolean).pop() || dir;
  const tree = document.getElementById("file-tree");
  tree.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:0.8rem">Loading...</div>`;
  loadFileTree("", tree, 0);

  document.getElementById("file-viewer-close").onclick = () => {
    document.getElementById("file-viewer").classList.add("hidden");
  };
}

/* ── Theme ─────────────────────────────────────────────────────────────────── */

const THEME_KEY = "gpu-dashboard-theme";

const TERM_THEMES = {
  dark:  { background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4", cursorAccent: "#1e1e1e", selectionBackground: "#264f78" },
  light: { background: "#ffffff", foreground: "#333333", cursor: "#333333", cursorAccent: "#ffffff", selectionBackground: "#add6ff" },
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
  Object.values(terminals).forEach(({ term }) => {
    if (term) term.options.theme = termTheme;
  });
  if (claudeTerminal?.term) {
    claudeTerminal.term.options.theme = termTheme;
  }
}

function currentTermTheme() {
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  return TERM_THEMES[theme];
}

/* ── Utility ──────────────────────────────────────────────────────────────── */

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
