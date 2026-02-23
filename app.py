import asyncio
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import CLUSTERS
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

    try:
        gpu = await asyncio.to_thread(_fetch_gpu_metrics, cluster)
        system = await asyncio.to_thread(_fetch_system_metrics, cluster)
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


# ── WebSocket terminal ────────────────────────────────────────────────────────


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

    async def read_from_ssh():
        """Read from SSH channel and send to WebSocket."""
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
        """Read from WebSocket and write to SSH channel."""
        try:
            while True:
                data = await ws.receive_text()
                channel.sendall(data.encode())
        except (WebSocketDisconnect, Exception):
            pass

    read_task = asyncio.create_task(read_from_ssh())
    write_task = asyncio.create_task(write_to_ssh())

    try:
        await asyncio.gather(read_task, write_task)
    finally:
        channel.close()


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


def _fetch_gpu_metrics(cluster: str) -> list[dict]:
    query = (
        "nvidia-smi --query-gpu="
        "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
        " --format=csv,noheader,nounits"
    )
    result = ssh.execute(cluster, query)
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
    proc_result = ssh.execute(
        cluster,
        "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,name --format=csv,noheader,nounits 2>/dev/null || true",
    )
    # Also get GPU UUID mapping
    uuid_result = ssh.execute(
        cluster,
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


def _fetch_system_metrics(cluster: str) -> dict:
    # CPU usage (1-min load average / nproc)
    cpu_result = ssh.execute(
        cluster,
        "nproc && cat /proc/loadavg",
    )
    lines = cpu_result["stdout"].strip().splitlines()
    nproc = int(lines[0]) if lines else 1
    load_1m = float(lines[1].split()[0]) if len(lines) > 1 else 0.0
    cpu_percent = min(round(load_1m / nproc * 100, 1), 100.0)

    # Memory
    mem_result = ssh.execute(cluster, "free -m | grep Mem:")
    mem_parts = mem_result["stdout"].split()
    mem_total = int(mem_parts[1]) if len(mem_parts) > 1 else 0
    mem_used = int(mem_parts[2]) if len(mem_parts) > 2 else 0

    # Disk
    disk_result = ssh.execute(cluster, "df -h / | tail -1")
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


# ── Static files (must be last) ──────────────────────────────────────────────

app.mount("/", StaticFiles(directory="static", html=True), name="static")
