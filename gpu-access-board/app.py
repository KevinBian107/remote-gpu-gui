import asyncio
import base64
import posixpath
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import CLUSTERS, PROJECT, SERVER
from ssh_manager import SSHManager

ssh = SSHManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    ssh.disconnect_all()


app = FastAPI(lifespan=lifespan)

# CORS so a static frontend (e.g. GitHub Pages) can call this backend running
# locally over the user's VPN.
_cors_origins = SERVER.get("cors_origins", ["*"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST endpoints ────────────────────────────────────────────────────────────


class ClusterDef(BaseModel):
    host: str
    port: int = 22
    username: str
    directory: str | None = None


class LoginRequest(BaseModel):
    password: str
    clusters: dict[str, ClusterDef] | None = None


def _known_cluster(name: str) -> bool:
    return ssh.cluster_config(name) is not None


@app.post("/api/login")
async def login(req: LoginRequest):
    # Use posted clusters if provided; otherwise fall back to config.yaml bootstrap.
    if req.clusters is not None:
        clusters = {k: v.model_dump() for k, v in req.clusters.items()}
        # If the posted cluster has no `directory`, inherit from config.yaml's
        # per-cluster entry. Keeps server-side per-cluster dirs (e.g.
        # topovnl-salk → /home/jovyan/vast/kaiwen/TopoVNL) effective even when
        # the user has stale cluster defs in localStorage.
        for name, cfg in clusters.items():
            yaml_cfg = CLUSTERS.get(name) or {}
            if not cfg.get("directory") and yaml_cfg.get("directory"):
                cfg["directory"] = yaml_cfg["directory"]
    else:
        clusters = CLUSTERS
    ssh.configure(clusters)
    results = await asyncio.to_thread(ssh.connect_all, req.password)
    return JSONResponse(content=results)


@app.get("/api/config")
async def get_config():
    return JSONResponse(content={"project": PROJECT})


@app.get("/api/defaults")
async def get_defaults():
    """Bootstrap defaults from config.yaml, surfaced to the Settings UI."""
    return JSONResponse(content={"clusters": CLUSTERS, "project": PROJECT})


@app.get("/api/clusters")
async def list_clusters():
    default_dir = PROJECT.get("directory", "")
    statuses = {}
    for name in ssh.cluster_names():
        cfg = ssh.cluster_config(name) or {}
        statuses[name] = {
            "host": cfg.get("host", ""),
            "directory": cfg.get("directory") or default_dir,
            "connected": ssh.is_connected(name),
        }
    return JSONResponse(content=statuses)


@app.get("/api/metrics/{cluster}")
async def get_metrics(cluster: str):
    if not _known_cluster(cluster):
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
    if not _known_cluster(cluster):
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

    if not _known_cluster(cluster) or not ssh.is_connected(cluster):
        await ws.close(code=1008, reason="Not connected")
        return

    try:
        channel = await asyncio.to_thread(ssh.get_interactive_channel, cluster)
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
    """Fetch GPU metrics. `execute` is a callable: execute(cmd, **kw) -> {stdout, stderr, exit_code}.

    Queries in two passes — core (always supported) + extended (best-effort, e.g. clock
    speeds, PCIe, p-state). If the extended query fails on this driver/GPU, we
    fall back to just the core fields rather than blanking the whole response.
    """
    core_fields = [
        "index", "name", "uuid",
        "utilization.gpu", "utilization.memory",
        "memory.used", "memory.total", "memory.free",
        "temperature.gpu",
        "power.draw", "power.limit",
    ]
    extended_fields = [
        "fan.speed",
        "pstate",
        "clocks.current.graphics", "clocks.max.graphics",
        "clocks.current.memory", "clocks.max.memory",
        "pcie.link.gen.current", "pcie.link.gen.max",
        "pcie.link.width.current", "pcie.link.width.max",
        "driver_version",
        "compute_mode",
        "persistence_mode",
    ]

    def _query(fields):
        q = f"nvidia-smi --query-gpu={','.join(fields)} --format=csv,noheader,nounits"
        r = execute(q)
        if r.get("exit_code", 0) != 0:
            return None
        rows = []
        for line in r["stdout"].strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= len(fields):
                rows.append(dict(zip(fields, parts)))
        return rows or None

    core_rows = _query(core_fields) or []
    ext_rows = _query(core_fields + extended_fields)
    if ext_rows and len(ext_rows) == len(core_rows):
        rows = ext_rows
    else:
        rows = core_rows  # extended unavailable; serve what we have

    gpus = []
    for d in rows:
        gpus.append({
            "index": int(d["index"]),
            "name": d.get("name", ""),
            "uuid": d.get("uuid", ""),
            "utilization": _safe_float(d.get("utilization.gpu", "")),
            "memory_utilization": _safe_float(d.get("utilization.memory", "")),
            "memory_used": _safe_float(d.get("memory.used", "")),
            "memory_total": _safe_float(d.get("memory.total", "")),
            "memory_free": _safe_float(d.get("memory.free", "")),
            "temperature": _safe_float(d.get("temperature.gpu", "")),
            "power_draw": _safe_float(d.get("power.draw", "")),
            "power_limit": _safe_float(d.get("power.limit", "")),
            "fan_speed": _safe_float(d.get("fan.speed", "")),
            "pstate": d.get("pstate", ""),
            "clock_graphics_cur": _safe_float(d.get("clocks.current.graphics", "")),
            "clock_graphics_max": _safe_float(d.get("clocks.max.graphics", "")),
            "clock_memory_cur": _safe_float(d.get("clocks.current.memory", "")),
            "clock_memory_max": _safe_float(d.get("clocks.max.memory", "")),
            "pcie_gen_cur": d.get("pcie.link.gen.current", ""),
            "pcie_gen_max": d.get("pcie.link.gen.max", ""),
            "pcie_width_cur": d.get("pcie.link.width.current", ""),
            "pcie_width_max": d.get("pcie.link.width.max", ""),
            "driver_version": d.get("driver_version", ""),
            "compute_mode": d.get("compute_mode", ""),
            "persistence_mode": d.get("persistence_mode", ""),
        })

    # Per-GPU compute processes — enriched with user + runtime via ps.
    proc_result = execute(
        "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,name "
        "--format=csv,noheader,nounits 2>/dev/null || true",
    )
    gpu_procs: dict[int, list] = {g["index"]: [] for g in gpus}
    uuid_to_idx = {g["uuid"]: g["index"] for g in gpus}

    pids_to_enrich = []
    pending: list[tuple[int, dict]] = []
    for line in proc_result["stdout"].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        idx = uuid_to_idx.get(parts[0])
        if idx is None:
            continue
        proc = {
            "pid": parts[1],
            "memory_mib": _safe_float(parts[2]),
            "name": parts[3],
        }
        pids_to_enrich.append(parts[1])
        pending.append((idx, proc))

    # One ps call enriches all pids at once.
    if pids_to_enrich:
        pid_list = ",".join(pids_to_enrich)
        ps_out = execute(
            f"ps -o pid=,user=,etime= -p {pid_list} 2>/dev/null || true"
        )
        ps_info: dict[str, dict] = {}
        for line in ps_out["stdout"].strip().splitlines():
            tokens = line.split()
            if len(tokens) >= 3:
                ps_info[tokens[0]] = {"user": tokens[1], "runtime": tokens[2]}
        for idx, proc in pending:
            info = ps_info.get(proc["pid"], {})
            proc["user"] = info.get("user", "?")
            proc["runtime"] = info.get("runtime", "?")
            gpu_procs[idx].append(proc)

    for g in gpus:
        g["processes"] = gpu_procs.get(g["index"], [])
        # uuid is internal; drop from response to keep payload small
        g.pop("uuid", None)

    return gpus


def _fetch_system_metrics(execute) -> dict:
    """Fetch system metrics. `execute` is a callable: execute(cmd, **kw) -> {stdout, stderr, exit_code}."""
    cpu_result = execute("nproc && cat /proc/loadavg")
    lines = cpu_result["stdout"].strip().splitlines()
    nproc = int(lines[0]) if lines else 1
    load_1m = float(lines[1].split()[0]) if len(lines) > 1 else 0.0
    cpu_percent = min(round(load_1m / nproc * 100, 1), 100.0)

    mem_result = execute("free -m | grep Mem:")
    mem_parts = mem_result["stdout"].split()
    mem_total = int(mem_parts[1]) if len(mem_parts) > 1 else 0
    mem_used = int(mem_parts[2]) if len(mem_parts) > 2 else 0

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


class RenameRequest(BaseModel):
    old_path: str
    new_name: str


class DeleteRequest(BaseModel):
    path: str


class CreateRequest(BaseModel):
    path: str
    name: str
    is_dir: bool = False


def _file_root_for(cluster: str) -> str:
    """Per-cluster file root for the file explorer and Claude tab cwd.
    Falls back to the global `project.directory` if the cluster has no override."""
    return ssh.directory_for(cluster) or PROJECT.get("directory", ".")


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
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _list_files_with_executor(executor, _file_root_for(cluster), path)


@app.get("/api/file/{cluster}")
async def read_file(cluster: str, path: str = ""):
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _read_file_with_executor(executor, _file_root_for(cluster), path)


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
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _read_image_with_executor(executor, _file_root_for(cluster), path)


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
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _download_file_with_executor(executor, _file_root_for(cluster), path)


# ── Folder download ─────────────────────────────────────────────────────


async def _download_folder_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)

    parent = posixpath.dirname(full)
    dirname = posixpath.basename(full)

    try:
        result = await asyncio.to_thread(
            execute, f"tar czf - -C {parent!r} {dirname!r} | base64"
        )
        if result["exit_code"] != 0:
            return JSONResponse(content={"error": result["stderr"].strip()}, status_code=400)

        b64_data = result["stdout"].replace("\n", "").replace("\r", "")
        archive_bytes = base64.b64decode(b64_data)
        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="{dirname}.tar.gz"'},
        )
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/download-folder/{cluster}")
async def download_folder(cluster: str, path: str = ""):
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _download_folder_with_executor(executor, _file_root_for(cluster), path)


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
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _rename_file_with_executor(executor, _file_root_for(cluster), req.old_path, req.new_name)


# ── File delete ──────────────────────────────────────────────────────────────


async def _delete_file_with_executor(execute, root, path):
    full = posixpath.normpath(posixpath.join(root, path))
    if not full.startswith(root):
        return JSONResponse(content={"error": "Invalid path"}, status_code=400)
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
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _delete_file_with_executor(executor, _file_root_for(cluster), req.path)


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
    if not _known_cluster(cluster):
        return JSONResponse(content={"error": "Unknown cluster"}, status_code=404)
    if not ssh.is_connected(cluster):
        return JSONResponse(content={"error": "Not connected"}, status_code=503)

    executor = lambda cmd, **kw: ssh.execute(cluster, cmd, **kw)
    return await _create_file_with_executor(executor, _file_root_for(cluster), req.path, req.name, req.is_dir)


# ── Static files (must be last) ──────────────────────────────────────────────

app.mount("/", StaticFiles(directory="static", html=True), name="static")
