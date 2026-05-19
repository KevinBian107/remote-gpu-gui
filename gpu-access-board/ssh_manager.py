import threading

import paramiko


class SSHManager:
    """SSH connection pool for Salk RunAI clusters (password auth).

    The active cluster definitions are NOT taken from config.yaml at module load;
    they are configured at login time via `configure()`, so the UI's Settings
    modal can override host/port/username/directory per cluster without a
    backend restart. config.yaml is only the bootstrap default surfaced via
    `/api/defaults`.
    """

    def __init__(self):
        # name → {host, port, username, directory?}
        self._clusters: dict[str, dict] = {}
        self._connections: dict[str, paramiko.SSHClient] = {}
        self._password: str | None = None
        self._lock = threading.Lock()

    # ── Cluster definition ────────────────────────────────────────────────

    def configure(self, clusters: dict[str, dict]):
        """Replace the active cluster definitions. Drops any connections to
        clusters no longer in the set."""
        with self._lock:
            self._clusters = dict(clusters)
            for old_name in list(self._connections.keys()):
                if old_name not in self._clusters:
                    try:
                        self._connections.pop(old_name).close()
                    except Exception:
                        pass

    def cluster_names(self) -> list[str]:
        with self._lock:
            return list(self._clusters.keys())

    def cluster_config(self, name: str) -> dict | None:
        with self._lock:
            cfg = self._clusters.get(name)
            return dict(cfg) if cfg else None

    def directory_for(self, name: str) -> str | None:
        cfg = self.cluster_config(name) or {}
        d = (cfg.get("directory") or "").strip()
        return d or None

    # ── Connection management ─────────────────────────────────────────────

    def connect(self, cluster_name: str, password: str) -> dict:
        """Connect to a cluster using password auth.
        Returns {"ok": True} or {"ok": False, "error": "..."}."""
        cfg = self.cluster_config(cluster_name)
        if not cfg:
            return {"ok": False, "error": f"Unknown cluster: {cluster_name}"}

        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                hostname=cfg["host"],
                port=int(cfg.get("port", 22)),
                username=cfg["username"],
                password=password,
                look_for_keys=False,
                allow_agent=False,
                timeout=10,
            )
            with self._lock:
                old = self._connections.pop(cluster_name, None)
                if old:
                    try:
                        old.close()
                    except Exception:
                        pass
                self._connections[cluster_name] = client
                self._password = password
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def connect_all(self, password: str) -> dict[str, dict]:
        """Connect to all configured clusters."""
        results = {}
        for name in self.cluster_names():
            results[name] = self.connect(name, password)
        return results

    def is_connected(self, cluster_name: str) -> bool:
        with self._lock:
            client = self._connections.get(cluster_name)
        if client is None:
            return False
        try:
            transport = client.get_transport()
            if transport is None or not transport.is_active():
                return False
            transport.send_ignore()
            return True
        except Exception:
            return False

    def _ensure_connected(self, cluster_name: str) -> paramiko.SSHClient:
        """Return a connected client, attempting reconnect if needed."""
        if self.is_connected(cluster_name):
            with self._lock:
                return self._connections[cluster_name]

        if self._password is None:
            raise ConnectionError(f"Not connected to {cluster_name} and no password stored")

        result = self.connect(cluster_name, self._password)
        if not result["ok"]:
            raise ConnectionError(f"Reconnect to {cluster_name} failed: {result['error']}")

        with self._lock:
            return self._connections[cluster_name]

    def execute(self, cluster_name: str, command: str, timeout: int = 15) -> dict:
        client = self._ensure_connected(cluster_name)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        return {
            "stdout": stdout.read().decode(errors="replace"),
            "stderr": stderr.read().decode(errors="replace"),
            "exit_code": exit_code,
        }

    def get_interactive_channel(self, cluster_name: str) -> paramiko.Channel:
        """Interactive shell channel for the Claude tab."""
        client = self._ensure_connected(cluster_name)
        channel = client.invoke_shell(term="xterm-256color", width=120, height=40)
        channel.settimeout(0.0)
        return channel

    def disconnect(self, cluster_name: str):
        with self._lock:
            client = self._connections.pop(cluster_name, None)
        if client:
            try:
                client.close()
            except Exception:
                pass

    def disconnect_all(self):
        with self._lock:
            clients = dict(self._connections)
            self._connections.clear()
            self._password = None
        for client in clients.values():
            try:
                client.close()
            except Exception:
                pass
