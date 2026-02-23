import yaml
from pathlib import Path

_cfg_path = Path(__file__).parent / "config.yaml"
with open(_cfg_path) as f:
    _cfg = yaml.safe_load(f)

SERVER = _cfg.get("server", {})
PROJECT = _cfg.get("project", {})
CLUSTERS = _cfg.get("clusters", {})
DSMLP = _cfg.get("dsmlp", {})
