/* ── State ─────────────────────────────────────────────────────────────────── */

let clusters = {};          // {name: {host, connected}}
let metricsCache = {};      // {name: {gpu: [...], system: {...}}}
let pollInterval = null;
let terminals = {};          // {name: {term, ws, fitAddon}}
let activeTerminal = null;
let claudeTerminal = null;  // {term, ws, fitAddon, cluster}
let projectConfig = {};     // from /api/config

/* ── Boot ──────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
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

  // Process filter
  document.getElementById("proc-filter").addEventListener("input", filterProcesses);

  // Logout
  document.getElementById("logout-btn").addEventListener("click", doLogout);

  // Cluster select change
  document.getElementById("proc-cluster-select").addEventListener("change", fetchProcesses);

  // Claude tab
  document.getElementById("claude-connect-btn").addEventListener("click", launchClaude);
});

/* ── Login / Logout ───────────────────────────────────────────────────────── */

async function doLogin() {
  const pw = document.getElementById("password-input").value;
  const statusEl = document.getElementById("login-status");
  if (!pw) { statusEl.textContent = "Please enter a password."; statusEl.className = "error"; return; }

  statusEl.textContent = "Connecting...";
  statusEl.className = "";
  document.getElementById("login-btn").disabled = true;

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
      statusEl.textContent = "Failed to connect to any cluster.";
      statusEl.className = "error";
      document.getElementById("login-btn").disabled = false;
      return;
    }

    let msg = `Connected to ${connected.length} cluster(s).`;
    if (failed.length > 0) {
      msg += ` Failed: ${failed.map(([k, v]) => `${k} (${v.error})`).join(", ")}`;
    }
    statusEl.textContent = msg;
    statusEl.className = "";

    // Small delay for user to see status, then switch to dashboard
    setTimeout(() => enterDashboard(), 500);
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.className = "error";
    document.getElementById("login-btn").disabled = false;
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

  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("password-input").value = "";
  document.getElementById("login-btn").disabled = false;
  document.getElementById("login-status").textContent = "";
}

/* ── Dashboard entry ──────────────────────────────────────────────────────── */

async function enterDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  // Fetch config and cluster list
  const [cfgResp, clusterResp] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/clusters"),
  ]);
  const cfgData = await cfgResp.json();
  projectConfig = cfgData.project || {};
  clusters = await clusterResp.json();

  // Populate sidebar
  const list = document.getElementById("cluster-list");
  list.innerHTML = "";
  for (const [name, info] of Object.entries(clusters)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="status-dot ${info.connected ? "connected" : "disconnected"}"></span>${name}`;
    li.dataset.cluster = name;
    list.appendChild(li);
  }

  // Populate cluster selects
  populateSelect("proc-cluster-select");
  populateSelect("claude-cluster-select");

  // Build terminal tabs
  buildTerminalTabs();

  // Start polling
  await fetchAllMetrics();
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
  const names = Object.entries(clusters).filter(([, v]) => v.connected).map(([k]) => k);
  const results = await Promise.allSettled(
    names.map((name) => fetch(`/api/metrics/${name}`).then((r) => r.json()).then((data) => [name, data]))
  );
  for (const r of results) {
    if (r.status === "fulfilled") {
      const [name, data] = r.value;
      if (!data.error) metricsCache[name] = data;
    }
  }
  renderOverview();
  // Also refresh GPU detail if that tab is active
  if (document.getElementById("tab-gpu").classList.contains("active")) {
    renderGPUDetail();
  }
}

/* ── Overview rendering ───────────────────────────────────────────────────── */

function renderOverview() {
  const container = document.getElementById("overview-cards");
  container.innerHTML = "";

  for (const [name, info] of Object.entries(clusters)) {
    const card = document.createElement("div");
    card.className = "cluster-card";

    const m = metricsCache[name];
    if (!info.connected || !m) {
      card.innerHTML = `<h3><span class="status-dot disconnected"></span>${name}</h3><p style="color:var(--text-dim)">Not connected</p>`;
      container.appendChild(card);
      continue;
    }

    const sys = m.system;
    const gpus = m.gpu;
    const memPct = sys.mem_total_mb ? Math.round(sys.mem_used_mb / sys.mem_total_mb * 100) : 0;

    // Average GPU utilization
    const avgGpuUtil = gpus.length ? Math.round(gpus.reduce((a, g) => a + g.utilization, 0) / gpus.length) : 0;
    const avgGpuMem = gpus.length ? Math.round(gpus.reduce((a, g) => a + (g.memory_total ? g.memory_used / g.memory_total * 100 : 0), 0) / gpus.length) : 0;

    card.innerHTML = `
      <h3><span class="status-dot connected"></span>${name}</h3>
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
    container.appendChild(card);
  }
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

  for (const [name, info] of Object.entries(clusters)) {
    if (!info.connected) continue;
    const m = metricsCache[name];
    if (!m || !m.gpu) continue;

    const section = document.createElement("div");
    section.className = "gpu-cluster-section";
    section.innerHTML = `<h3 class="gpu-cluster-heading">${name}</h3>`;

    for (const g of m.gpu) {
      const memPct = g.memory_total ? Math.round(g.memory_used / g.memory_total * 100) : 0;
      const card = document.createElement("div");
      card.className = "gpu-card";
      card.innerHTML = `
        <h4>GPU ${g.index}: ${g.name}</h4>
        ${metricBarHTML("Utilization", Math.round(g.utilization))}
        ${metricBarHTML("Memory", memPct, `${Math.round(g.memory_used)} / ${Math.round(g.memory_total)} MiB`)}
        <div class="metric-row">
          <span class="metric-label">Temperature</span>
          <span class="metric-value">${g.temperature}°C</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Power</span>
          <span class="metric-value">${g.power_draw} W</span>
        </div>
        <div class="gpu-processes">
          <h5>Processes (${g.processes.length})</h5>
          ${g.processes.length === 0 ? "<p style='color:var(--text-dim);font-size:0.8rem'>No compute processes</p>" :
            g.processes.map((p) => `
              <div class="gpu-proc-row">
                <span>PID ${p.pid}: ${p.name}</span>
                <span>${p.memory_mib} MiB</span>
              </div>
            `).join("")}
        </div>
      `;
      section.appendChild(card);
    }

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
    const resp = await fetch(`/api/processes/${cluster}`);
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

  // Sort
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

  connectedClusters.forEach((name, i) => {
    // Tab button
    const btn = document.createElement("button");
    btn.className = "term-tab" + (i === 0 ? " active" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => switchTerminal(name));
    tabsContainer.appendChild(btn);

    // Terminal container div
    const div = document.createElement("div");
    div.className = "term-instance" + (i === 0 ? " active" : "");
    div.id = `term-${name}`;
    termContainer.appendChild(div);

    // We lazy-init the actual terminal on first switch
    terminals[name] = { term: null, ws: null, fitAddon: null, initialized: false };
  });

  if (connectedClusters.length > 0) {
    activeTerminal = connectedClusters[0];
  }
}

function switchTerminal(name) {
  activeTerminal = name;

  document.querySelectorAll(".term-tab").forEach((b) => b.classList.toggle("active", b.textContent === name));
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
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      selectionBackground: "#264f78",
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  // WebSocket
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${name}`);

  ws.onopen = () => {
    term.writeln(`\x1b[32mConnected to ${name}\x1b[0m\r`);
    // Send initial terminal size so remote shell knows dimensions
    ws.send(`\x01RESIZE:${term.cols},${term.rows}`);
    // Auto-navigate and attach screen session if it exists
    const projDir = projectConfig.directory || "/home/jovyan/vast/kaiwen/track-mjx";
    const screenName = projectConfig.screen_session || "train-vqvae";
    setTimeout(() => {
      ws.send(`cd ${projDir}\n`);
      setTimeout(() => ws.send(`screen -ls | grep -q ${screenName} && screen -xRR ${screenName}\n`), 300);
    }, 500);
  };

  ws.onmessage = (ev) => {
    term.write(ev.data);
  };

  ws.onclose = () => {
    term.writeln("\r\n\x1b[31mConnection closed.\x1b[0m");
  };

  ws.onerror = () => {
    term.writeln("\r\n\x1b[31mWebSocket error.\x1b[0m");
  };

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Send resize when terminal dimensions change
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\x01RESIZE:${cols},${rows}`);
    }
  });

  terminals[name] = { term, ws, fitAddon, initialized: true };
}

function fitActiveTerminal() {
  if (!activeTerminal || !terminals[activeTerminal]?.fitAddon) return;
  // Small delay to let the DOM update
  setTimeout(() => {
    try { terminals[activeTerminal].fitAddon.fit(); } catch (e) {}
  }, 50);
}

// Refit terminals on window resize
window.addEventListener("resize", () => {
  fitActiveTerminal();
  fitClaudeTerminal();
});

/* ── Claude terminal ──────────────────────────────────────────────────────── */

function launchClaude() {
  const cluster = document.getElementById("claude-cluster-select").value;
  if (!cluster) return;

  // Tear down existing claude terminal if switching clusters
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
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      selectionBackground: "#264f78",
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${cluster}`);

  ws.onopen = () => {
    term.writeln(`\x1b[32mConnected to ${cluster} — launching Claude...\x1b[0m\r`);
    ws.send(`\x01RESIZE:${term.cols},${term.rows}`);
    // Switch to devuser, cd to project, then attach or create screen session
    const projDir = projectConfig.directory || "/home/jovyan/vast/kaiwen/track-mjx";
    const claudeUser = projectConfig.claude_user || "devuser";
    const claudeScreen = projectConfig.claude_screen_session || "claude";
    setTimeout(() => {
      ws.send(`su - ${claudeUser}\n`);
      setTimeout(() => {
        ws.send("exec bash\n");
        setTimeout(() => {
          ws.send(`cd ${projDir}\n`);
          setTimeout(() => {
            ws.send(`screen -ls 2>/dev/null | grep -q '\\.${claudeScreen}\\b' && screen -r ${claudeScreen} || screen -S ${claudeScreen} bash -c 'claude --dangerously-skip-permissions; exec bash'\n`);
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

  // Load file explorer for this cluster
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

async function loadFileTree(path, parentEl, depth) {
  const cluster = getFileCluster();
  if (!cluster) return;

  try {
    const resp = await fetch(`/api/files/${cluster}?path=${encodeURIComponent(path)}`);
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
    const resp = await fetch(`/api/file/${cluster}?path=${encodeURIComponent(path)}`);
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

  const dir = projectConfig.directory || "/home/jovyan/vast/kaiwen/track-mjx";
  document.getElementById("file-explorer-path").textContent = dir.split("/").filter(Boolean).pop() || dir;
  const tree = document.getElementById("file-tree");
  tree.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:0.8rem">Loading...</div>`;
  loadFileTree("", tree, 0);

  // Close button
  document.getElementById("file-viewer-close").onclick = () => {
    document.getElementById("file-viewer").classList.add("hidden");
  };
}

/* ── Utility ──────────────────────────────────────────────────────────────── */

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
