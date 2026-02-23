import threading
import paramiko
from config import CLUSTERS


class SSHManager:
    def __init__(self):
        self._clients: dict[str, paramiko.SSHClient] = {}
        self._password: str | None = None
        self._lock = threading.Lock()

    def connect(self, cluster_name: str, password: str) -> dict:
        """Connect to a cluster. Returns {"ok": True} or {"ok": False, "error": "..."}."""
        cfg = CLUSTERS.get(cluster_name)
        if not cfg:
            return {"ok": False, "error": f"Unknown cluster: {cluster_name}"}

        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                hostname=cfg["host"],
                port=cfg["port"],
                username=cfg["username"],
                password=password,
                timeout=10,
            )
            with self._lock:
                old = self._clients.pop(cluster_name, None)
                if old:
                    try:
                        old.close()
                    except Exception:
                        pass
                self._clients[cluster_name] = client
                self._password = password
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def connect_all(self, password: str) -> dict[str, dict]:
        """Connect to all clusters. Returns {cluster_name: {"ok": ...}, ...}."""
        results = {}
        for name in CLUSTERS:
            results[name] = self.connect(name, password)
        return results

    def is_connected(self, cluster_name: str) -> bool:
        with self._lock:
            client = self._clients.get(cluster_name)
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
                return self._clients[cluster_name]

        if self._password is None:
            raise ConnectionError(f"Not connected to {cluster_name} and no password stored")

        result = self.connect(cluster_name, self._password)
        if not result["ok"]:
            raise ConnectionError(f"Reconnect to {cluster_name} failed: {result['error']}")

        with self._lock:
            return self._clients[cluster_name]

    def execute(self, cluster_name: str, command: str, timeout: int = 15) -> dict:
        """Execute a command on a cluster. Returns {"stdout": ..., "stderr": ..., "exit_code": ...}."""
        client = self._ensure_connected(cluster_name)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        return {
            "stdout": stdout.read().decode(errors="replace"),
            "stderr": stderr.read().decode(errors="replace"),
            "exit_code": exit_code,
        }

    def get_interactive_channel(self, cluster_name: str) -> paramiko.Channel:
        """Get an interactive shell channel for terminal use."""
        client = self._ensure_connected(cluster_name)
        channel = client.invoke_shell(term="xterm-256color", width=120, height=40)
        channel.settimeout(0.0)  # non-blocking
        return channel

    def disconnect(self, cluster_name: str):
        with self._lock:
            client = self._clients.pop(cluster_name, None)
        if client:
            try:
                client.close()
            except Exception:
                pass

    def disconnect_all(self):
        with self._lock:
            clients = dict(self._clients)
            self._clients.clear()
            self._password = None
        for client in clients.values():
            try:
                client.close()
            except Exception:
                pass
