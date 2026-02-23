/* ── State ─────────────────────────────────────────────────────────────────── */

let clusters = {};          // {name: {host, connected}}
let metricsCache = {};      // {name: {gpu: [...], system: {...}}}
let pollInterval = null;
let terminals = {};          // {name: {term, ws, fitAddon}}
let activeTerminal = null;

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

  // Fetch cluster list
  const resp = await fetch("/api/clusters");
  clusters = await resp.json();

  // Populate sidebar
  const list = document.getElementById("cluster-list");
  list.innerHTML = "";
  for (const [name, info] of Object.entries(clusters)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="status-dot ${info.connected ? "connected" : "disconnected"}"></span>${name}`;
    li.dataset.cluster = name;
    list.appendChild(li);
  }

  // Populate cluster select for processes tab
  populateSelect("proc-cluster-select");

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
window.addEventListener("resize", fitActiveTerminal);

/* ── Utility ──────────────────────────────────────────────────────────────── */

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
