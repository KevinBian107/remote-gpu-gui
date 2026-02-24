import asyncio
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import CLUSTERS, PROJECT, DSMLP
from ssh_manager import SSHManager

ssh = SSHManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    ssh.disconnect_all()


app = FastAPI(lifespan=lifespan)


# ── REST endpoints ────────────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    password: str


@app.post("/api/login")
async def login(req: LoginRequest):
    results = await asyncio.to_thread(ssh.connect_all, req.password)
    return JSONResponse(content=results)


@app.get("/api/config")
async def get_config():
    return JSONResponse(content={"project": PROJECT})


@app.get("/api/clusters")
async def list_clusters():
    statuses = {}
    for name in CLUSTERS:
        statuses[name] = {
            "host": CLUSTERS[name]["host"],
            "connected": ssh.is_connected(name),
        }
    return JSONResponse(content=statuses)


@app.get("/api/metrics/{cluster}")
async def get_metrics(cluster: str):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    try:
        gpu = await asyncio.to_thread(_fetch_gpu_metrics, executor)
        system = await asyncio.to_thread(_fetch_system_metrics, executor)
        return JSONResponse(content={"gpu": gpu, "system": system})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/processes/{cluster}")
async def get_processes(cluster: str):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    try:
        result = await asyncio.to_thread(
            ssh.execute,
            cluster,
            "ps aux --sort=-%mem | head -50",
        )
        processes = _parse_ps_aux(result["stdout"])
        return JSONResponse(content={"processes": processes})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


# ── DSMLP REST endpoints ─────────────────────────────────────────────────────


@app.post("/api/dsmlp/login")
async def dsmlp_login():
    result = await asyncio.to_thread(ssh.connect_dsmlp)
    if not result["ok"]:
        return JSONResponse(content={"connected": False, "error": result["error"]}, status_code=500)
    pod = await asyncio.to_thread(ssh._detect_dsmlp_pod)
    return JSONResponse(content={"connected": True, "pod": pod})


@app.post("/api/dsmlp/launch")
async def dsmlp_launch():
    if not ssh.is_dsmlp_connected():
        return JSONResponse(content={"ok": False, "error": "Not connected to DSMLP"}, status_code=503)
    result = await asyncio.to_thread(ssh.launch_dsmlp_pod)
    if not result["ok"]:
        return JSONResponse(content=result, status_code=500)
    return JSONResponse(content=result)


@app.get("/api/dsmlp/status")
async def dsmlp_status():
    connected = ssh.is_dsmlp_connected()
    pod = ssh._dsmlp_pod if connected else None
    return JSONResponse(content={"connected": connected, "pod": pod})


@app.get("/api/dsmlp/metrics")
async def dsmlp_metrics():
    if not ssh.is_dsmlp_connected():
        return JSONResponse(content={"error": "Not connected"}, status_code=503)
    if not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "No running pod"}, status_code=503)

    executor = lambda cmd, **kw: ssh.dsmlp_execute(cmd, **kw)
    try:
        gpu = await asyncio.to_thread(_fetch_gpu_metrics, executor)
        system = await asyncio.to_thread(_fetch_system_metrics, executor)
        return JSONResponse(content={"gpu": gpu, "system": system})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/dsmlp/processes")
async def dsmlp_processes():
    if not ssh.is_dsmlp_connected():
        return JSONResponse(content={"error": "Not connected"}, status_code=503)
    if not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "No running pod"}, status_code=503)

    try:
        result = await asyncio.to_thread(
            ssh.dsmlp_execute,
            "ps aux --sort=-%mem | head -50",
        )
        processes = _parse_ps_aux(result["stdout"])
        return JSONResponse(content={"processes": processes})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/dsmlp/config")
async def dsmlp_config():
    return JSONResponse(content={"dsmlp": DSMLP})


# ── WebSocket terminal ────────────────────────────────────────────────────────


async def _ws_terminal_bridge(ws: WebSocket, channel):
    """Bidirectional bridge between a WebSocket and a paramiko channel."""
    async def read_from_ssh():
        loop = asyncio.get_event_loop()
        try:
            while True:
                data = await loop.run_in_executor(None, _channel_recv, channel)
                if data:
                    await ws.send_text(data)
                else:
                    break
        except (WebSocketDisconnect, Exception):
            pass

    async def write_to_ssh():
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.receive":
                    text = msg.get("text")
                    if text is not None:
                        if text.startswith("\x01RESIZE:"):
                            try:
                                parts = text[8:].split(",")
                                cols, rows = int(parts[0]), int(parts[1])
                                channel.resize_pty(width=cols, height=rows)
                            except (ValueError, IndexError):
                                pass
                        else:
                            channel.sendall(text.encode())
                    else:
                        data = msg.get("bytes")
                        if data:
                            channel.sendall(data)
                elif msg["type"] == "websocket.disconnect":
                    break
        except (WebSocketDisconnect, Exception):
            pass

    read_task = asyncio.create_task(read_from_ssh())
    write_task = asyncio.create_task(write_to_ssh())
    try:
        await asyncio.gather(read_task, write_task)
    finally:
        channel.close()


@app.websocket("/ws/terminal/{cluster}")
async def terminal_ws(ws: WebSocket, cluster: str):
    await ws.accept()

    if cluster not in CLUSTERS or not ssh.is_connected(cluster):
        await ws.close(code=1008, reason="Not connected")
        return

    try:
        channel = await asyncio.to_thread(ssh.get_interactive_channel, cluster)
    except Exception as e:
        await ws.close(code=1011, reason=str(e))
        return

    await _ws_terminal_bridge(ws, channel)


@app.websocket("/ws/dsmlp/terminal")
async def dsmlp_terminal_ws(ws: WebSocket):
    await ws.accept()

    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        await ws.close(code=1008, reason="DSMLP not connected or no pod")
        return

    try:
        channel = await asyncio.to_thread(ssh.get_dsmlp_interactive_channel)
    except Exception as e:
        await ws.close(code=1011, reason=str(e))
        return

    await _ws_terminal_bridge(ws, channel)


def _channel_recv(channel) -> str | None:
    """Blocking read from paramiko channel (run in executor)."""
    import select

    while True:
        r, _, _ = select.select([channel], [], [], 0.5)
        if r:
            data = channel.recv(4096)
            if not data:
                return None
            return data.decode(errors="replace")
        if channel.closed or channel.exit_status_ready():
            return None


# ── Metric parsers ────────────────────────────────────────────────────────────


def _fetch_gpu_metrics(execute) -> list[dict]:
    """Fetch GPU metrics. `execute` is a callable: execute(cmd, **kw) -> {stdout, stderr, exit_code}."""
    query = (
        "nvidia-smi --query-gpu="
        "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
        " --format=csv,noheader,nounits"
    )
    result = execute(query)
    gpus = []
    for line in result["stdout"].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 7:
            gpus.append({
                "index": int(parts[0]),
                "name": parts[1],
                "utilization": _safe_float(parts[2]),
                "memory_used": _safe_float(parts[3]),
                "memory_total": _safe_float(parts[4]),
                "temperature": _safe_float(parts[5]),
                "power_draw": _safe_float(parts[6]),
            })

    # Get per-GPU process info
    proc_result = execute(
        "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,name --format=csv,noheader,nounits 2>/dev/null || true",
    )
    # Also get GPU UUID mapping
    uuid_result = execute(
        "nvidia-smi --query-gpu=index,uuid --format=csv,noheader",
    )
    uuid_to_idx = {}
    for line in uuid_result["stdout"].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            uuid_to_idx[parts[1]] = int(parts[0])

    gpu_procs: dict[int, list] = {g["index"]: [] for g in gpus}
    for line in proc_result["stdout"].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            gpu_uuid = parts[0]
            idx = uuid_to_idx.get(gpu_uuid)
            if idx is not None and idx in gpu_procs:
                gpu_procs[idx].append({
                    "pid": parts[1],
                    "memory_mib": _safe_float(parts[2]),
                    "name": parts[3],
                })

    for g in gpus:
        g["processes"] = gpu_procs.get(g["index"], [])

    return gpus


def _fetch_system_metrics(execute) -> dict:
    """Fetch system metrics. `execute` is a callable: execute(cmd, **kw) -> {stdout, stderr, exit_code}."""
    # CPU usage (1-min load average / nproc)
    cpu_result = execute("nproc && cat /proc/loadavg")
    lines = cpu_result["stdout"].strip().splitlines()
    nproc = int(lines[0]) if lines else 1
    load_1m = float(lines[1].split()[0]) if len(lines) > 1 else 0.0
    cpu_percent = min(round(load_1m / nproc * 100, 1), 100.0)

    # Memory
    mem_result = execute("free -m | grep Mem:")
    mem_parts = mem_result["stdout"].split()
    mem_total = int(mem_parts[1]) if len(mem_parts) > 1 else 0
    mem_used = int(mem_parts[2]) if len(mem_parts) > 2 else 0

    # Disk
    disk_result = execute("df -h / | tail -1")
    disk_parts = disk_result["stdout"].split()
    disk_total = disk_parts[1] if len(disk_parts) > 1 else "?"
    disk_used = disk_parts[2] if len(disk_parts) > 2 else "?"
    disk_percent = disk_parts[4] if len(disk_parts) > 4 else "?"

    return {
        "cpu_percent": cpu_percent,
        "nproc": nproc,
        "load_1m": load_1m,
        "mem_total_mb": mem_total,
        "mem_used_mb": mem_used,
        "disk_total": disk_total,
        "disk_used": disk_used,
        "disk_percent": disk_percent,
    }


def _parse_ps_aux(output: str) -> list[dict]:
    lines = output.strip().splitlines()
    if not lines:
        return []
    processes = []
    for line in lines[1:]:  # skip header
        parts = re.split(r"\s+", line, maxsplit=10)
        if len(parts) >= 11:
            processes.append({
                "user": parts[0],
                "pid": parts[1],
                "cpu": parts[2],
                "mem": parts[3],
                "vsz": parts[4],
                "rss": parts[5],
                "tty": parts[6],
                "stat": parts[7],
                "start": parts[8],
                "time": parts[9],
                "command": parts[10],
            })
    return processes


def _safe_float(s: str) -> float:
    try:
        return float(s)
    except (ValueError, TypeError):
        return 0.0


# ── File browser ─────────────────────────────────────────────────────────────

import base64
import posixpath


class RenameRequest(BaseModel):
    old_path: str
    new_name: str


class DeleteRequest(BaseModel):
    path: str


class CreateRequest(BaseModel):
    path: str
    name: str
    is_dir: bool = False


def _file_root(for_dsmlp=False) -> str:
    if for_dsmlp:
        proj = DSMLP.get("project", {})
        return proj.get("directory", ".")
    return PROJECT.get("directory", ".")


async def _list_files_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    try:
        result = await asyncio.to_thread(execute, f"ls -1pA {full!r}")
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)

        entries = []
        for name in result["stdout"].strip().splitlines():
            if not name:
                continue
            is_dir = name.endswith("/")
            clean = name.rstrip("/")
            entries.append({"name": clean, "is_dir": is_dir})

        entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
        return JSONResponse(content={"path": posixpath.relpath(full, root), "entries": entries})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


async def _read_file_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    try:
        result = await asyncio.to_thread(execute, f"head -c 512000 {full!r}")
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)

        return JSONResponse(content={"path": path, "content": result["stdout"]})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/files/{cluster}")
async def list_files(cluster: str, path: str = ""):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _list_files_with_executor(executor, _file_root(), path)


@app.get("/api/file/{cluster}")
async def read_file(cluster: str, path: str = ""):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _read_file_with_executor(executor, _file_root(), path)


@app.get("/api/dsmlp/files")
async def dsmlp_list_files(path: str = ""):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _list_files_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), path)


@app.get("/api/dsmlp/file")
async def dsmlp_read_file(path: str = ""):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _read_file_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), path)


# ── Image viewing ────────────────────────────────────────────────────────────

MIME_MAP = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
}


async def _read_image_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    ext = posixpath.splitext(full)[1].lower()
    mime = MIME_MAP.get(ext, "application/octet-stream")

    try:
        # Size check (try GNU stat, fall back to BSD stat)
        size_result = await asyncio.to_thread(
            execute, f"stat -c %s {full!r} 2>/dev/null || stat -f %z {full!r}"
        )
        size_str = size_result["stdout"].strip().splitlines()
        if size_str:
            size = int(size_str[0])
            if size > 10 * 1024 * 1024:
                return JSONResponse(content={"error": "File too large (>10MB)"}, status_code=400)

        result = await asyncio.to_thread(execute, f"base64 {full!r}")
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)

        b64_data = result["stdout"].replace("\n", "").replace("\r", "")
        return JSONResponse(content={"mime": mime, "data": b64_data})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/image/{cluster}")
async def read_image(cluster: str, path: str = ""):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _read_image_with_executor(executor, _file_root(), path)


@app.get("/api/dsmlp/image")
async def dsmlp_read_image(path: str = ""):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _read_image_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), path)


# ── File download ────────────────────────────────────────────────────────────


async def _download_file_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    try:
        result = await asyncio.to_thread(execute, f"base64 {full!r}")
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)

        b64_data = result["stdout"].replace("\n", "").replace("\r", "")
        file_bytes = base64.b64decode(b64_data)
        filename = posixpath.basename(full)
        return Response(
            content=file_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/download/{cluster}")
async def download_file(cluster: str, path: str = ""):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _download_file_with_executor(executor, _file_root(), path)


@app.get("/api/dsmlp/download")
async def dsmlp_download_file(path: str = ""):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _download_file_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), path)


# ── File rename ──────────────────────────────────────────────────────────────


async def _rename_file_with_executor(execute, root, old_path, new_name):
    full_old = posixpath.normpath(posixpath.join(root, old_path))
    if not full_old.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    parent = posixpath.dirname(full_old)
    full_new = posixpath.normpath(posixpath.join(parent, new_name))
    if not full_new.startswith(root):
        return JSONResponse(content={"error": "Invalid new name"}, status_code=400)

    try:
        result = await asyncio.to_thread(execute, f"mv {full_old!r} {full_new!r}")
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)
        return JSONResponse(content={"ok": True})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.post("/api/rename/{cluster}")
async def rename_file(cluster: str, req: RenameRequest):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _rename_file_with_executor(executor, _file_root(), req.old_path, req.new_name)


@app.post("/api/dsmlp/rename")
async def dsmlp_rename_file(req: RenameRequest):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _rename_file_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), req.old_path, req.new_name)


# ── File delete ──────────────────────────────────────────────────────────────


async def _delete_file_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)
    # Guard against deleting the root itself
    if full == root:
        return JSONResponse(content={"error": "Cannot delete project root"}, status_code=400)

    try:
        result = await asyncio.to_thread(execute, f"rm -rf {full!r}")
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)
        return JSONResponse(content={"ok": True})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.post("/api/delete/{cluster}")
async def delete_file(cluster: str, req: DeleteRequest):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _delete_file_with_executor(executor, _file_root(), req.path)


@app.post("/api/dsmlp/delete")
async def dsmlp_delete_file(req: DeleteRequest):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _delete_file_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), req.path)


# ── File/folder create ───────────────────────────────────────────────────────


async def _create_file_with_executor(execute, root, path, name, is_dir):
    full_parent = posixpath.normpath(posixpath.join(root, path))
    if not full_parent.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    full_new = posixpath.normpath(posixpath.join(full_parent, name))
    if not full_new.startswith(root):
        return JSONResponse(content={"error": "Invalid name"}, status_code=400)

    cmd = f"mkdir -p {full_new!r}" if is_dir else f"touch {full_new!r}"
    try:
        result = await asyncio.to_thread(execute, cmd)
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)
        return JSONResponse(content={"ok": True})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.post("/api/create/{cluster}")
async def create_file(cluster: str, req: CreateRequest):
    if cluster not in CLUSTERS:
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _create_file_with_executor(executor, _file_root(), req.path, req.name, req.is_dir)


@app.post("/api/dsmlp/create")
async def dsmlp_create_file(req: CreateRequest):
    if not ssh.is_dsmlp_connected() or not ssh._dsmlp_pod:
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    return await _create_file_with_executor(ssh.dsmlp_execute, _file_root(for_dsmlp=True), req.path, req.name, req.is_dir)


# ── Static files (must be last) ──────────────────────────────────────────────

app.mount("/", StaticFiles(directory="static", html=True), name="static")
