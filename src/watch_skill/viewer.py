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

# Wide enough that the main viewer shows a real frame rather than a blown-up
# thumbnail — at 320 the text burned into a screen recording was unreadable,
# which defeats the point of showing the frame at all.
_THUMB_WIDTH = 720
_MAX_FRAMES = 24

# Progressive enhancement, deliberately. Everything below is an addition to
# a page that already reads correctly with scripting off — which is what a
# sandboxed client iframe, a locked-down browser, or an archived copy gives
# you. A UI that is blank without JavaScript is not an artifact, it is an
# app that happens to be in a file.
_JS = """
(function(){
  var frames = Array.prototype.slice.call(document.querySelectorAll('.frame'));
  if (!frames.length) return;
  var stage = document.getElementById('stage');
  if (!stage) return;
  document.body.classList.add('js');

  var shots = frames.map(function(el){
    return {
      t: parseFloat(el.dataset.t || '0'),
      src: el.querySelector('img').src,
      cap: (el.querySelector('.cap') || {}).textContent || '',
      el: el
    };
  });
  var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
  // Only the transcript is speech. OCR rows are also .row, and treating one
  // as "said" put on-screen text in quotes as if someone had spoken it.
  var spoken = Array.prototype.slice.call(document.querySelectorAll('#p-tr .row'));
  var duration = shots.length ? shots[shots.length - 1].t : 0;
  var current = -1;

  var img = stage.querySelector('img');
  var label = stage.querySelector('.vtime');
  var note = stage.querySelector('.vnote');
  var playhead = document.querySelector('.tl-head');

  function fmt(s){
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function nearest(t){
    var best = 0, gap = Infinity;
    for (var i = 0; i < shots.length; i++) {
      var d = Math.abs(shots[i].t - t);
      if (d < gap) { gap = d; best = i; }
    }
    return best;
  }

  function spokenAt(t){
    var hit = null;
    spoken.forEach(function(r){
      var rt = parseFloat(r.dataset.t || 'NaN');
      if (!isNaN(rt) && rt <= t + 0.01) hit = r;
    });
    return hit;
  }

  // On-screen text at this moment is a different claim from speech, and on
  // a screen recording it is usually the only one there is.
  var screenText = Array.prototype.slice.call(document.querySelectorAll('#p-ocr .row'));
  function seenAt(t){
    var near = null, gap = 1.5;
    screenText.forEach(function(r){
      var rt = parseFloat(r.dataset.t || 'NaN');
      if (!isNaN(rt) && Math.abs(rt - t) <= gap) { near = r; gap = Math.abs(rt - t); }
    });
    return near;
  }

  function show(i, from){
    if (i < 0 || i >= shots.length || i === current) return;
    current = i;
    var shot = shots[i];
    img.src = shot.src;
    img.alt = 'frame at ' + fmt(shot.t);
    label.textContent = fmt(shot.t);
    if (playhead && duration) playhead.style.left = Math.min(99.7, shot.t / duration * 100) + '%';

    frames.forEach(function(el){ el.classList.remove('on'); });
    shot.el.classList.add('on');
    if (from !== 'strip') {
      shot.el.scrollIntoView({block: 'nearest', inline: 'center', behavior: 'smooth'});
    }

    rows.forEach(function(r){ r.classList.remove('on'); });
    var line = spokenAt(shot.t);
    if (line) line.classList.add('on');

    // Caption the frame with whichever evidence the engine actually has,
    // labelled for what it is — speech, on-screen text, or a description.
    // Calling one of them another would be the page lying quietly.
    var text = line ? ((line.querySelector('.txt') || {}).textContent || '').trim() : '';
    var kind = text ? 'said' : '';
    if (!text) {
      var seen = seenAt(shot.t);
      if (seen) { text = ((seen.querySelector('.txt') || {}).textContent || '').trim(); kind = 'on screen'; }
    }
    if (!text) {
      text = shot.cap.replace(/^\\s*\\d+:\\d\\d\\s*/, '').trim();
      kind = text ? 'scene' : '';
    }
    note.innerHTML = '';
    if (text) {
      var tag = document.createElement('b');
      tag.textContent = kind;
      note.appendChild(tag);
      note.appendChild(document.createTextNode(text));
    }
  }

  document.addEventListener('click', function(ev){
    var word = ev.target.closest ? ev.target.closest('.w') : null;
    if (word && word.dataset.t) { ev.preventDefault(); show(nearest(parseFloat(word.dataset.t))); return; }
    var seek = ev.target.closest ? ev.target.closest('.seek') : null;
    if (!seek) return;
    ev.preventDefault();
    var t = parseFloat(seek.dataset.t || 'NaN');
    if (!isNaN(t)) show(nearest(t), seek.classList.contains('frame') ? 'strip' : '');
  });

  var bar = document.querySelector('.scrub');
  if (bar && duration) {
    bar.addEventListener('click', function(ev){
      if (ev.target.closest('.tl-mark')) return;   // the mark handles itself
      var box = bar.getBoundingClientRect();
      show(nearest((ev.clientX - box.left) / box.width * duration));
    });
  }

  // Tabs: one rail, three lists.
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  function select(tab){
    tabs.forEach(function(t){
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      var pane = document.getElementById(t.dataset.pane);
      if (pane) pane.hidden = !on;
    });
  }
  tabs.forEach(function(tab){ tab.addEventListener('click', function(){ select(tab); }); });

  // Open on a tab that has something in it. A screen recording usually has
  // no speech, and landing on an empty Transcript makes the whole rail look
  // broken when the evidence is one tab over.
  var withContent = tabs.filter(function(t){
    var pane = document.getElementById(t.dataset.pane);
    return pane && pane.querySelector('.row, .answer');
  });
  if (withContent.length && withContent.indexOf(tabs[0]) === -1) select(withContent[0]);

  var box = document.getElementById('find');
  if (box) {
    box.addEventListener('input', function(){
      var q = box.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function(r){
        var hit = !q || r.textContent.toLowerCase().indexOf(q) !== -1;
        r.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      var count = document.getElementById('found');
      if (count) count.textContent = q ? shown + ' matching' : '';
    });
  }

  document.addEventListener('keydown', function(ev){
    if (ev.target.tagName === 'INPUT') { if (ev.key === 'Escape') ev.target.blur(); return; }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); show(current + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); show(current - 1); }
    else if (ev.key === 'Home') { ev.preventDefault(); show(0); }
    else if (ev.key === 'End') { ev.preventDefault(); show(shots.length - 1); }
    else if (ev.key === '/' && box) { ev.preventDefault(); box.focus(); }
  });

  show(0);
})();
"""


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
/* The palette is the project's own: the warm study the avatars live in —
   lamplight amber on dark walnut, not another slate dashboard. */
:root{
  --bg:#1a1310;--bg2:#241a15;--card:#2b1f18;--rail:#3a2a20;
  --ink:#f2e6d8;--dim:#a48d7a;--faint:#7a6455;
  --acc:#f0a83c;--acc-dim:#f0a83c26;--line:#3d2c22;
  --good:#8fbf6a;
}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);background:var(--bg);
  font:14px/1.55 ui-sans-serif,system-ui,Segoe UI,sans-serif;
  -webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace}

/* An app shell, not an article: a fixed header, a viewer that owns the
   space, and a rail that stays with it. The page is a tool. */
.wrap{max-width:1600px;margin:0 auto;padding:0 clamp(12px,2vw,24px) 40px}
header{position:sticky;top:0;z-index:20;background:#1a1310f2;backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);margin:0 calc(-1*clamp(12px,2vw,24px)) 18px;
  padding:12px clamp(12px,2vw,24px);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
h1{font-size:17px;margin:0;letter-spacing:-.01em;line-height:1.3;font-weight:650;
  max-width:42ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats{display:flex;gap:7px;flex-wrap:wrap;margin-left:auto}
.stat{background:var(--card);border:1px solid var(--line);border-radius:6px;
  padding:4px 10px;font-size:11.5px;color:var(--dim);white-space:nowrap}
.stat b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.src{color:var(--faint);font-size:11.5px;max-width:34ch;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}

h2{font-size:11px;color:var(--acc);margin:0;text-transform:uppercase;
  letter-spacing:.14em;font-weight:650}
.meta{color:var(--dim);font-size:13px}
/* --- layout: viewer left, rail right, both filling the screen ---------- */
/* Fill the window rather than trailing off into dead space: the rail runs
   the full height beside the viewer and scrolls on its own. */
.app{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,26%);gap:16px;
  align-items:stretch;min-height:calc(100vh - 130px)}
.app>*{min-width:0}
.col{display:flex;flex-direction:column;gap:0}
@media(max-width:1100px){.app{grid-template-columns:1fr;min-height:0}}

.panel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.panel-hd{display:flex;align-items:center;gap:10px;padding:9px 12px;
  border-bottom:1px solid var(--line);background:var(--card)}

/* --- the viewer -------------------------------------------------------- */
.viewer{position:relative;background:#0a0a0a;aspect-ratio:16/9;display:flex;
  align-items:center;justify-content:center;overflow:hidden}
.viewer img{width:100%;height:100%;object-fit:contain;display:block}
.vtime{position:absolute;left:12px;top:12px;background:#000000b3;backdrop-filter:blur(6px);
  border:1px solid #ffffff1f;border-radius:6px;padding:4px 10px;font-size:13px;
  color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.vnote{position:absolute;left:12px;right:12px;bottom:12px;background:#000000c4;
  backdrop-filter:blur(6px);border:1px solid #ffffff1a;border-radius:8px;padding:8px 12px;
  font-size:13.5px;color:var(--ink);unicode-bidi:plaintext;max-height:32%;overflow:auto}
.vnote:empty{display:none}
.vnote b{color:var(--acc);font-weight:600;margin-right:6px}
#stage{display:none}
body.js #stage{display:block}
/* Without scripting the strip and the rail are the page, and they already
   carry everything — no blank frame where an app would have been. */

/* --- scrubber: a ruler, not a progress bar ----------------------------- */
.scrub{position:relative;height:34px;margin:10px 0 0;cursor:pointer;
  background:linear-gradient(180deg,var(--card),var(--bg2));
  border:1px solid var(--line);border-radius:8px;overflow:hidden}
.scrub::after{content:"";position:absolute;inset:auto 0 0 0;height:1px;background:var(--line)}
.tick{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}
.tick span{position:absolute;top:3px;left:4px;font-size:9.5px;color:var(--faint);
  font-variant-numeric:tabular-nums}
.tl-mark{position:absolute;bottom:0;width:2px;height:11px;background:var(--acc);
  opacity:.7;cursor:pointer;transition:height .12s,opacity .12s}
.tl-mark:hover{height:18px;opacity:1}
.tl-head{position:absolute;top:0;bottom:0;left:0;width:2px;background:var(--acc);
  display:none;pointer-events:none;transition:left .18s cubic-bezier(.4,0,.2,1);
  box-shadow:0 0 10px 1px var(--acc)}
.tl-head::before{content:"";position:absolute;top:0;left:-4px;border:5px solid transparent;
  border-top-color:var(--acc)}
body.js .tl-head{display:block}

/* --- filmstrip --------------------------------------------------------- */
.frames{display:flex;gap:8px;overflow-x:auto;padding:10px 2px 4px;scrollbar-width:thin}
.frames::-webkit-scrollbar{height:6px}
.frames::-webkit-scrollbar-thumb{background:var(--rail);border-radius:3px}
.frame{flex:0 0 auto;width:128px;background:var(--card);border:1px solid var(--line);
  border-radius:7px;overflow:hidden}
body.js .frame{cursor:pointer;opacity:.5;transition:opacity .12s,border-color .12s,transform .12s}
body.js .frame:hover{opacity:.85;transform:translateY(-2px)}
.frame img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover}
.frame .cap{padding:4px 7px;font-size:10.5px;color:var(--dim);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.frame .cap b{color:var(--ink);font-variant-numeric:tabular-nums}
.frame:target,.frame.on{border-color:var(--acc);opacity:1;box-shadow:0 0 0 1px var(--acc)}

/* --- rail: tabs over one scrolling list -------------------------------- */
.tabs{display:flex;gap:2px;padding:6px 6px 0;background:var(--card);
  border-bottom:1px solid var(--line)}
.tab{flex:1;background:none;border:0;border-radius:7px 7px 0 0;color:var(--dim);
  font:inherit;font-size:12px;padding:8px 6px;cursor:pointer;position:relative}
.tab:hover{color:var(--ink)}
.tab[aria-selected=true]{color:var(--acc);background:var(--bg2)}
.tab[aria-selected=true]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;
  height:2px;background:var(--acc)}
.tab .n{color:var(--faint);font-size:10.5px;margin-left:4px;font-variant-numeric:tabular-nums}
body:not(.js) .tabs{display:none}
aside.panel{display:flex;flex-direction:column;max-height:calc(100vh - 130px);position:sticky;top:76px}
@media(max-width:1100px){aside.panel{position:static;max-height:none}}
.pane{flex:1;overflow:auto;padding:4px;scrollbar-width:thin}
.pane::-webkit-scrollbar{width:8px}
.pane::-webkit-scrollbar-thumb{background:var(--rail);border-radius:4px}
body:not(.js) .pane{max-height:none;overflow:visible}
.pane[hidden]{display:none}

.row{display:flex;gap:10px;padding:6px 9px;border-radius:6px;align-items:baseline}
.row+.row{border-top:1px solid var(--line)}
.row:hover{background:var(--card)}
body.js .row{cursor:pointer}
.row.on{background:var(--acc-dim);box-shadow:inset 2px 0 0 var(--acc)}
.ts{flex:0 0 44px;color:var(--acc);font-variant-numeric:tabular-nums;font-size:11.5px;
  opacity:.8;font-family:ui-monospace,Consolas,monospace}
.txt{flex:1;min-width:0;unicode-bidi:plaintext;font-size:13.5px}
.w{border-radius:3px;padding:0 1px;transition:background .1s}
body.js .w{cursor:pointer}
body.js .w:hover{background:var(--acc);color:#1a1310}
.empty{color:var(--faint);font-size:12.5px;padding:14px;font-style:italic}

/* --- search ------------------------------------------------------------ */
.bar{display:flex;gap:8px;align-items:center;padding:8px}
#find{flex:1;min-width:0;background:var(--bg);color:var(--ink);border:1px solid var(--line);
  border-radius:7px;padding:7px 11px;font:inherit;font-size:13px}
#find::placeholder{color:var(--faint)}
#find:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
body:not(.js) .bar{display:none}
#found{color:var(--acc);font-size:11.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.hint{color:var(--faint);font-size:11px;padding:0 2px 8px;display:flex;gap:8px;flex-wrap:wrap}
body:not(.js) .hint{display:none}
kbd{background:var(--card);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;
  padding:0 5px;font:inherit;font-size:10.5px;color:var(--dim)}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
.ts{flex:0 0 56px;color:var(--acc);font-variant-numeric:tabular-nums}
.ts a{color:inherit;text-decoration:none}
.txt{flex:1;unicode-bidi:plaintext}
.answer{background:linear-gradient(180deg,var(--card),var(--bg2));border:1px solid var(--line);
  border-radius:10px;padding:15px 17px;margin-bottom:14px;box-shadow:0 4px 14px #0005}
.answer .q{font-weight:650;margin-bottom:6px}
.badge{display:inline-block;font-size:10.5px;border-radius:20px;padding:2px 9px;margin-left:8px;
  background:var(--rail);color:var(--dim);letter-spacing:.04em;vertical-align:1px}
.badge.floor{background:#4a2320;color:#f0a89c}
.answer pre{white-space:pre-wrap;font:inherit;margin:8px 0;color:var(--ink);unicode-bidi:plaintext}
/* Evidence is the point of the whole page: it gets the accent, not the
   muted treatment a footnote would. */
.ev{font-size:12.5px;color:var(--dim);padding:4px 0 4px 10px;border-left:2px solid var(--acc);
  margin:4px 0;unicode-bidi:plaintext;border-radius:0 4px 4px 0}
body.js .ev.seek{cursor:pointer}
body.js .ev.seek:hover{background:var(--acc-dim);color:var(--ink)}
.ev-t{color:var(--acc);font-family:ui-monospace,Consolas,monospace;font-size:11px;
  font-variant-numeric:tabular-nums}
.ev-k{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;
  margin:0 4px}
footer{margin-top:20px;color:var(--faint);font-size:11.5px;border-top:1px solid var(--line);
  padding-top:12px}
footer a{color:var(--acc);text-decoration:none}
footer a:hover{text-decoration:underline}
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
            f'<a class="tl-mark seek" style="left:{pct:.1f}%" href="#f{i}" '
            f'data-t="{float(scene["timestamp"]):.2f}" '
            f'title="{format_time(scene["timestamp"])}"></a>'
        )
        description = _esc(scene.get("description") or "")
        cards.append(
            f'<div class="frame seek" id="f{i}" data-t="{float(scene["timestamp"]):.2f}">'
            f'<img src="{uri}" alt="frame at {format_time(scene["timestamp"])}" '
            f'loading="lazy">'
            f'<div class="cap"><b>{format_time(scene["timestamp"])}</b> {description}</div></div>'
        )
    return "".join(marks), "".join(cards)


def _words_html(seg: dict) -> str:
    """Each word its own seek target, when the transcript carries alignment.

    Without word timestamps the whole line seeks to the line's start, which
    on a ten-second segment is the wrong moment more often than not.
    """
    try:
        words = json.loads(seg.get("words_json") or "[]")
    except (TypeError, ValueError):
        words = []
    if not words:
        return _esc(seg["text"])
    return " ".join(
        f'<span class="w" data-t="{float(w["start"]):.2f}">{_esc(w["text"])}</span>'
        for w in words
    )


def _ticks_html(duration: float) -> str:
    """Time gridlines across the scrubber, at a step that stays readable.

    A bare progress bar tells you a fraction; a ruler tells you a time,
    which is the unit every answer on this page is expressed in.
    """
    if duration <= 0:
        return ""
    for step in (5, 10, 15, 30, 60, 120, 300, 600, 900, 1800):
        if duration / step <= 12:
            break
    marks = []
    t = step
    while t < duration:
        marks.append(
            f'<div class="tick" style="left:{t / duration * 100:.2f}%">'
            f'<span>{format_time(t)}</span></div>'
        )
        t += step
    return "".join(marks)


def _transcript_html(segments: list[dict]) -> str:
    rows = [
        f'<div class="row seek" data-t="{float(seg["start"]):.2f}">'
        f'<span class="ts">{format_time(seg["start"])}</span>'
        f'<span class="txt">{_words_html(seg)}</span></div>'
        for seg in segments
    ]
    return "".join(rows) or '<div class="meta">(no transcript)</div>'


def _ocr_html(ocr: list[dict]) -> str:
    rows = [
        f'<div class="row seek" data-t="{float(b["timestamp"]):.2f}">'
        f'<span class="ts">{format_time(b["timestamp"])}</span>'
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
        # Each piece of evidence seeks to its own moment. An answer that
        # cites a timestamp you cannot go to is a footnote; one you can
        # click is the thing that makes the citation worth having.
        parts = []
        for e in data.get("evidence", [])[:8]:
            when = e.get("timestamp")
            stamp = format_time(when) if when is not None else "--:--"
            seek = f' seek" data-t="{float(when):.2f}"' if when is not None else '"'
            parts.append(
                f'<div class="ev{seek}><span class="ev-t">{stamp}</span> '
                f'<span class="ev-k">{_esc(e.get("kind"))}</span> {_esc(e.get("text"))}</div>'
            )
        evidence = "".join(parts)
        # The engine's answer text already ends with a plain-text "Evidence:"
        # list. Rendering both leaves every citation on the page twice, once
        # dead and once clickable — drop the prose copy and keep the one that
        # seeks.
        body = data.get("text", "")
        if evidence:
            cut = body.find("Evidence:")
            if cut != -1:
                body = body[:cut].rstrip()
        blocks.append(
            f'<div class="answer"><div class="q">{_esc(row["question"])}{badge}</div>'
            f'<pre>{_esc(body)}</pre>{evidence}</div>'
        )
    return "".join(blocks)


def render_viewer_html(video_id_or_source: str) -> tuple[str, str]:
    """The self-contained page for one analyzed video, as (video_id, html).

    Split out from :func:`generate_viewer` so the same page can be handed to
    an MCP client as an inline UI resource instead of only written to disk —
    one renderer, so the shared artifact and the in-conversation view can
    never drift apart.
    """
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
            "SELECT start, end, text, words_json FROM segments WHERE video_id = ? ORDER BY start",
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
    seconds = float(video.get("duration_seconds") or 0.0)
    duration = format_time(seconds)
    n_frames = sum(1 for s in scenes if _thumb_data_uri(s["frame_path"]))
    n_words = sum(len(s["text"].split()) for s in segments)
    ticks = _ticks_html(seconds)

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
<div class="wrap">
<header>
  <h1 dir="auto">{_esc(title)}</h1>
  <span class="src" dir="ltr" title="{_esc(video["source"])}">{_esc(video["source"])}</span>
  <div class="stats">
    <span class="stat">duration <b>{duration}</b></span>
    <span class="stat">frames <b>{n_frames}</b></span>
    <span class="stat">transcript <b>{n_words}</b> words</span>
    <span class="stat">on-screen <b>{len(ocr)}</b></span>
    <span class="stat mono">{_esc(video["id"])}</span>
  </div>
</header>

<div class="app">
  <div class="col">
    <section class="panel" id="stage">
      <div class="viewer">
        <img alt="">
        <div class="vtime mono">00:00</div>
        <div class="vnote"></div>
      </div>
    </section>
    <div class="scrub">{ticks}{marks}<div class="tl-head"></div></div>
    <div class="frames">{cards or '<div class="empty">no frames stored</div>'}</div>
  </div>

  <aside class="panel">
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="true" data-pane="p-tr">Transcript
        <span class="n">{len(segments)}</span></button>
      <button class="tab" role="tab" aria-selected="false" data-pane="p-ocr">On-screen
        <span class="n">{len(ocr)}</span></button>
      <button class="tab" role="tab" aria-selected="false" data-pane="p-ans">Answers
        <span class="n">{len(answers)}</span></button>
    </div>
    <div class="bar">
      <input id="find" type="search" placeholder="Find in this video…"
       aria-label="Find in transcript and on-screen text">
      <span id="found"></span>
    </div>
    <div class="pane" id="p-tr">{_transcript_html(segments)}</div>
    <div class="pane" id="p-ocr" hidden>{_ocr_html(ocr) or '<div class="empty">no on-screen text found</div>'}</div>
    <div class="pane" id="p-ans" hidden>{answers_html or '<div class="empty">no questions asked yet — run watch-skill ask</div>'}</div>
    <div class="hint"><span><kbd>&larr;</kbd><kbd>&rarr;</kbd> frames</span>
      <span><kbd>/</kbd> search</span><span>click a word to jump</span></div>
  </aside>
</div>

<footer>Analyzed with <a href="https://github.com/oxbshw/watch-skill">Watch Skill</a>
 — watch, index, ask, and iterate on video. This page is self-contained and works offline.</footer>
</div>
<script>{_JS}</script>
</body>
</html>"""

    return video["id"], page


def generate_viewer(video_id_or_source: str, out_path: str | Path | None = None) -> Path:
    """Write the self-contained HTML page for one analyzed video."""
    video_id, page = render_viewer_html(video_id_or_source)
    dest = Path(out_path) if out_path else Path.cwd() / f"watch-skill viewer {video_id}.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(page, encoding="utf-8")
    return dest
