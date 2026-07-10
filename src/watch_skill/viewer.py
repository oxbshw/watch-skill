"""Shareable viewer: one self-contained HTML page per analyzed video.

Timeline with key frames, the transcript, on-screen text, and every cached
answer WITH the exact evidence the engine cited — all inlined (frames become
data: URIs), zero external requests, so the file works offline and can be
shared as-is. A quiet footer links the project: the page is both the user's
artifact and the tool's ambassador.
"""
from __future__ import annotations

import base64
import html
import io
import json
from pathlib import Path
from typing import Any

from watch_skill.errors import IndexError_
from watch_skill.index.db import connect
from watch_skill.index.store import get_video
from watch_skill.perceive.budget import format_time

_THUMB_WIDTH = 320
_MAX_FRAMES = 24


def _thumb_data_uri(frame_path: str) -> str | None:
    """A frame as an inline JPEG data URI (thumbnailed when PIL is present)."""
    path = Path(frame_path)
    if not path.is_file():
        return None
    try:
        from PIL import Image

        with Image.open(path) as img:
            img = img.convert("RGB")
            if img.width > _THUMB_WIDTH:
                img = img.resize((_THUMB_WIDTH, int(img.height * _THUMB_WIDTH / img.width)))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70)
            payload = buf.getvalue()
    except Exception:  # noqa: BLE001 — unreadable frame: skip it, keep the page
        try:
            payload = path.read_bytes()
            if len(payload) > 400_000:
                return None
        except OSError:
            return None
    return "data:image/jpeg;base64," + base64.b64encode(payload).decode("ascii")


def _esc(text: Any) -> str:
    return html.escape(str(text if text is not None else ""))


_CSS = """
:root{--bg:#101820;--card:#18242f;--ink:#e8edf2;--dim:#8fa1b0;--acc:#f0b21e;--line:#233240}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 system-ui,Segoe UI,sans-serif;padding:24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;color:var(--acc);margin:28px 0 10px;
text-transform:uppercase;letter-spacing:.08em}
.meta{color:var(--dim);font-size:13px;margin-bottom:18px}
.timeline{position:relative;height:6px;background:var(--line);border-radius:3px;margin:36px 0 10px}
.tl-mark{position:absolute;top:-5px;width:4px;height:16px;background:var(--acc);border-radius:2px;cursor:pointer}
.frames{display:flex;gap:10px;overflow-x:auto;padding:6px 0 12px}
.frame{flex:0 0 auto;width:200px;background:var(--card);border:1px solid var(--line);
border-radius:8px;overflow:hidden}
.frame img{width:100%;display:block}
.frame .cap{padding:6px 8px;font-size:12px;color:var(--dim)}
.frame .cap b{color:var(--ink)}
.frame:target{outline:2px solid var(--acc)}
.row{display:flex;gap:10px;padding:6px 10px;border-bottom:1px solid var(--line)}
.row:hover{background:var(--card)}
.ts{flex:0 0 56px;color:var(--acc);font-variant-numeric:tabular-nums}
.ts a{color:inherit;text-decoration:none}
.txt{flex:1;unicode-bidi:plaintext}
.answer{background:var(--card);border:1px solid var(--line);border-radius:8px;
padding:14px 16px;margin-bottom:14px}
.answer .q{font-weight:600;margin-bottom:6px}
.badge{display:inline-block;font-size:11px;border-radius:4px;padding:1px 7px;margin-left:8px;
background:var(--line);color:var(--dim)}
.badge.floor{background:#4a2626;color:#f2b8b8}
.answer pre{white-space:pre-wrap;font:inherit;margin:8px 0;color:var(--ink);unicode-bidi:plaintext}
.ev{font-size:13px;color:var(--dim);padding-left:12px;border-left:2px solid var(--line);
margin:4px 0;unicode-bidi:plaintext}
footer{margin-top:36px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
footer a{color:var(--acc);text-decoration:none}
"""


def _frames_html(scenes: list[dict]) -> tuple[str, str]:
    """(timeline marks, frame cards) — only scenes whose frame could inline."""
    marks, cards = [], []
    duration = max((s["timestamp"] for s in scenes), default=0.0) or 1.0
    for i, scene in enumerate(scenes[:_MAX_FRAMES]):
        uri = _thumb_data_uri(scene["frame_path"])
        if uri is None:
            continue
        pct = min(99.0, scene["timestamp"] / duration * 100)
        marks.append(
            f'<a class="tl-mark" style="left:{pct:.1f}%" href="#f{i}" '
            f'title="{format_time(scene["timestamp"])}"></a>'
        )
        description = _esc(scene.get("description") or "")
        cards.append(
            f'<div class="frame" id="f{i}"><img src="{uri}" alt="frame at '
            f'{format_time(scene["timestamp"])}">'
            f'<div class="cap"><b>{format_time(scene["timestamp"])}</b> {description}</div></div>'
        )
    return "".join(marks), "".join(cards)


def _transcript_html(segments: list[dict]) -> str:
    rows = [
        f'<div class="row"><span class="ts">{format_time(seg["start"])}</span>'
        f'<span class="txt">{_esc(seg["text"])}</span></div>'
        for seg in segments
    ]
    return "".join(rows) or '<div class="meta">(no transcript)</div>'


def _ocr_html(ocr: list[dict]) -> str:
    rows = [
        f'<div class="row"><span class="ts">{format_time(b["timestamp"])}</span>'
        f'<span class="txt">{_esc(b["text"])}</span></div>'
        for b in ocr[:200]
    ]
    return "".join(rows)


def _answers_html(answers: list[dict]) -> str:
    blocks = []
    for row in answers:
        try:
            data = json.loads(row["answer_json"])
        except (ValueError, TypeError):
            continue
        floor = data.get("honest_floor")
        badge = (
            '<span class="badge floor">honest floor</span>' if floor
            else f'<span class="badge">confidence {data.get("confidence", "?")}</span>'
        )
        evidence = "".join(
            f'<div class="ev">[{format_time(e["timestamp"]) if e.get("timestamp") is not None else "--:--"}] '
            f'({_esc(e.get("kind"))}) {_esc(e.get("text"))}</div>'
            for e in data.get("evidence", [])[:8]
        )
        blocks.append(
            f'<div class="answer"><div class="q">{_esc(row["question"])}{badge}</div>'
            f'<pre>{_esc(data.get("text", ""))}</pre>{evidence}</div>'
        )
    return "".join(blocks)


def generate_viewer(video_id_or_source: str, out_path: str | Path | None = None) -> Path:
    """Render the self-contained HTML page for one analyzed video."""
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first, or list_videos()",
        )
    conn = connect()
    try:
        scenes = [dict(r) for r in conn.execute(
            "SELECT timestamp, frame_path, description FROM scenes "
            "WHERE video_id = ? ORDER BY timestamp", (video["id"],)).fetchall()]
        segments = [dict(r) for r in conn.execute(
            "SELECT start, end, text FROM segments WHERE video_id = ? ORDER BY start",
            (video["id"],)).fetchall()]
        ocr = [dict(r) for r in conn.execute(
            "SELECT timestamp, text FROM ocr_blocks WHERE video_id = ? ORDER BY timestamp",
            (video["id"],)).fetchall()]
        answers = [dict(r) for r in conn.execute(
            "SELECT question, answer_json FROM answers WHERE video_id = ? ORDER BY id",
            (video["id"],)).fetchall()]
    finally:
        conn.close()

    title = video.get("title") or video["source"]
    marks, cards = _frames_html(scenes)
    answers_html = _answers_html(answers)
    duration = format_time(float(video.get("duration_seconds") or 0.0))

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>{_esc(title)} — Watch Skill</title>
<style>{_CSS}</style>
</head>
<body>
<h1 dir="auto">{_esc(title)}</h1>
<div class="meta">duration {duration} · source <span dir="auto">{_esc(video["source"])}</span>
 · video_id {_esc(video["id"])}</div>
<div class="timeline">{marks}</div>
<div class="frames">{cards or '<div class="meta">(no frames stored)</div>'}</div>
{'<h2>Answers & evidence</h2>' + answers_html if answers_html else ""}
<h2>Transcript</h2>
{_transcript_html(segments)}
{('<h2>On-screen text (OCR)</h2>' + _ocr_html(ocr)) if ocr else ""}
<footer>Analyzed with <a href="https://github.com/oxbshw/watch-skill">Watch Skill</a>
 — watch, index, ask, and iterate on video. This page is self-contained and works offline.</footer>
</body>
</html>"""

    dest = Path(out_path) if out_path else Path.cwd() / f"watch-skill viewer {video['id']}.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(page, encoding="utf-8")
    return dest
