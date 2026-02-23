import time
import threading
from pathlib import Path

import paramiko
from config import CLUSTERS, DSMLP


class SSHManager:
    def __init__(self):
        self._clients: dict[str, paramiko.SSHClient] = {}
        self._password: str | None = None
        self._lock = threading.Lock()
        self._dsmlp_client: paramiko.SSHClient | None = None
        self._dsmlp_pod: str | None = None

    def connect(self, cluster_name: str, password: str) -> dict:
        """Connect to a cluster using password auth.
        Returns {"ok": True} or {"ok": False, "error": "..."}."""
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
                look_for_keys=False,
                allow_agent=False,
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
        self.disconnect_dsmlp()

    # ── DSMLP methods ────────────────────────────────────────────────────────

    def connect_dsmlp(self) -> dict:
        """Connect to DSMLP jump box using SSH key auth + Duo 2FA."""
        if not DSMLP:
            return {"ok": False, "error": "DSMLP not configured"}

        key_path = Path(DSMLP["key_path"]).expanduser()
        if not key_path.exists():
            return {"ok": False, "error": f"SSH key not found: {key_path}"}

        try:
            key = paramiko.Ed25519Key.from_private_key_file(str(key_path))
            host = DSMLP["host"]
            port = DSMLP.get("port", 22)
            username = DSMLP["username"]

            # Use Transport directly to handle multi-factor auth (key + Duo)
            transport = paramiko.Transport((host, port))
            transport.connect()

            # Step 1: public key auth
            transport.auth_publickey(username, key)

            # Step 2: if not fully authenticated, try keyboard-interactive (Duo)
            if not transport.is_authenticated():
                def duo_handler(title, instructions, prompt_list):
                    # Auto-send "1" for Duo push notification
                    return ["1"] * len(prompt_list)
                transport.auth_interactive(username, duo_handler)

            if not transport.is_authenticated():
                transport.close()
                return {"ok": False, "error": "Authentication failed (Duo may have been denied)"}

            # Wrap transport in an SSHClient for exec_command/invoke_shell
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client._transport = transport

            with self._lock:
                if self._dsmlp_client:
                    try:
                        self._dsmlp_client.close()
                    except Exception:
                        pass
                self._dsmlp_client = client
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def is_dsmlp_connected(self) -> bool:
        with self._lock:
            client = self._dsmlp_client
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

    def _ensure_dsmlp_connected(self) -> paramiko.SSHClient:
        """Return connected DSMLP client, reconnecting if needed."""
        if self.is_dsmlp_connected():
            with self._lock:
                return self._dsmlp_client

        result = self.connect_dsmlp()
        if not result["ok"]:
            raise ConnectionError(f"DSMLP reconnect failed: {result['error']}")

        with self._lock:
            return self._dsmlp_client

    def _dsmlp_exec(self, command: str, timeout: int = 15):
        """Run a command on the DSMLP jump box with login shell (for PATH)."""
        client = self._ensure_dsmlp_connected()
        stdin, stdout, stderr = client.exec_command(
            f"bash -l -c {_shell_quote(command)}", timeout=timeout
        )
        exit_code = stdout.channel.recv_exit_status()
        return {
            "stdout": stdout.read().decode(errors="replace"),
            "stderr": stderr.read().decode(errors="replace"),
            "exit_code": exit_code,
        }

    def _detect_dsmlp_pod(self) -> str | None:
        """Detect a running pod on DSMLP for the configured username."""
        username = DSMLP["username"]
        result = self._dsmlp_exec("kubectl get pods --no-headers")
        output = result["stdout"]
        for line in output.strip().splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0].startswith(f"{username}-") and parts[2] == "Running":
                self._dsmlp_pod = parts[0]
                return parts[0]
        self._dsmlp_pod = None
        return None

    def launch_dsmlp_pod(self) -> dict:
        """Launch a DSMLP pod using the configured launch command.
        Polls for up to 60 seconds for the pod to become Running."""
        launch_cmd = DSMLP.get("launch_command", "")
        if not launch_cmd:
            return {"ok": False, "error": "No launch_command configured"}

        try:
            result = self._dsmlp_exec(launch_cmd, timeout=90)
            if result["exit_code"] != 0:
                return {"ok": False, "error": f"Launch failed (exit {result['exit_code']}): {result['stderr']}"}
        except Exception as e:
            return {"ok": False, "error": f"Launch command error: {e}"}

        # Poll for running pod
        for _ in range(20):
            time.sleep(3)
            pod = self._detect_dsmlp_pod()
            if pod:
                return {"ok": True, "pod": pod}

        return {"ok": False, "error": "Pod did not become Running within 60 seconds"}

    def dsmlp_execute(self, command: str, timeout: int = 15) -> dict:
        """Execute a command inside the DSMLP pod via kubectl exec."""
        pod = self._dsmlp_pod
        if not pod:
            pod = self._detect_dsmlp_pod()
        if not pod:
            raise ConnectionError("No running DSMLP pod detected")

        kubectl_cmd = f"kubectl exec {pod} -- bash -c {_shell_quote(command)}"
        return self._dsmlp_exec(kubectl_cmd, timeout=timeout)

    def get_dsmlp_interactive_channel(self) -> paramiko.Channel:
        """Get an interactive channel into the DSMLP pod via kubesh."""
        client = self._ensure_dsmlp_connected()
        pod = self._dsmlp_pod
        if not pod:
            pod = self._detect_dsmlp_pod()
        if not pod:
            raise ConnectionError("No running DSMLP pod detected")

        channel = client.invoke_shell(term="xterm-256color", width=120, height=40)
        channel.settimeout(0.0)
        # Wait briefly for shell prompt, then enter the pod
        time.sleep(0.5)
        channel.sendall(f"kubesh {pod}\n".encode())
        return channel

    def disconnect_dsmlp(self):
        with self._lock:
            client = self._dsmlp_client
            self._dsmlp_client = None
            self._dsmlp_pod = None
        if client:
            try:
                client.close()
            except Exception:
                pass


def _shell_quote(s: str) -> str:
    """Single-quote a string for shell use."""
    return "'" + s.replace("'", "'\\''") + "'"
