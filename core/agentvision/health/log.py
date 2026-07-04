"""Append-only JSONL health log for self-healing incidents.

Every automatic remediation (yt-dlp auto-update, fallback-chain hop,
bootstrap download) records what broke and what was done about it, so
`agentvision doctor` and humans can audit the machine's history.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agentvision.config import get_settings


def record_incident(kind: str, detail: str, **extra: Any) -> None:
    """Append one incident line. Never raises — health logging is best-effort."""
    entry = {
        "ts": datetime.now(UTC).isoformat(timespec="seconds"),
        "kind": kind,
        "detail": detail,
        **extra,
    }
    try:
        path = get_settings().health_log_path
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_incidents(limit: int = 50) -> list[dict[str, Any]]:
    """Return the most recent ``limit`` incidents (newest last)."""
    path: Path = get_settings().health_log_path
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    out: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out
