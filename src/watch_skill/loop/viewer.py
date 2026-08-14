"""Self-contained HTML for one loop run: every iteration, side by side.

THE LOOP's output is a claim — "this failed, then it passed" — and the proof
is two recordings and what the critic said about each. A GIF shows the
before and after; it cannot show *why* the verdict changed, which issue went
away, or the frame the critic was looking at.

This page can. Iterations sit in a strip, picking one shows its frames and
its issues, and picking two compares them: what was fixed, what is new, what
is still there. Same conventions as `watch_skill.viewer` — one file, frames
inlined as data URIs, no network, and it degrades to a readable document
with scripting off.
"""
from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from watch_skill.errors import LoopError
from watch_skill.perceive.budget import format_time
from watch_skill.viewer import _CSS, _thumb_data_uri

_MAX_FRAMES_PER_ITER = 8

_LOOP_CSS = """
.iters{display:flex;gap:10px;overflow-x:auto;padding:10px 2px 4px}
.iter{flex:0 0 auto;min-width:132px;background:var(--card);border:1px solid var(--line);
  border-radius:8px;padding:9px 11px;text-align:left}
body.js .iter{cursor:pointer;opacity:.62;transition:opacity .12s,transform .12s}
body.js .iter:hover{opacity:.9;transform:translateY(-2px)}
.iter.on{opacity:1;border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.iter .n{font-size:11px;color:var(--faint);letter-spacing:.1em;text-transform:uppercase}
.iter .v{font-size:15px;font-weight:650;margin-top:3px}
.iter .s{font-size:11.5px;color:var(--dim);margin-top:2px;font-variant-numeric:tabular-nums}
.v.pass{color:var(--good)}
.v.fail{color:#e8825a}
.verdict{display:inline-block;font-size:10.5px;border-radius:20px;padding:2px 10px;
  letter-spacing:.05em;text-transform:uppercase;font-weight:650}
.verdict.pass{background:#1e3a1e;color:var(--good)}
.verdict.fail{background:#4a2320;color:#f0a89c}
.verdict.unknown{background:#3a3320;color:#e8d08c}
.limits{margin:8px 0;padding:8px 12px;border-left:3px solid #e8d08c;
  background:#221f16;font-size:12px}
.limits ul{margin:4px 0 0 16px;padding:0}
.issue{display:flex;gap:10px;padding:7px 9px;border-radius:6px;align-items:baseline}
.issue+.issue{border-top:1px solid var(--line)}
body.js .issue.seek{cursor:pointer}
body.js .issue.seek:hover{background:var(--acc-dim)}
.sev{flex:0 0 58px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:650}
.sev.critical{color:#f0a89c}
.sev.major{color:var(--acc)}
.sev.minor{color:var(--dim)}
.fix{color:var(--faint);font-size:12px;display:block;margin-top:2px}
/* The comparison is the point of the page, so it gets the strongest colour
   coding: what the fix removed, what it broke, what it left alone. */
.delta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;padding:8px}
.delta section{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px}
.delta h3{margin:0 0 6px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase}
.delta .gone h3{color:var(--good)}
.delta .new h3{color:#f0a89c}
.delta .kept h3{color:var(--dim)}
.delta li{font-size:12.5px;margin:3px 0}
.delta ul{margin:0;padding-left:16px}
.delta .none{color:var(--faint);font-size:12px;font-style:italic}
"""


def _esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def _limitations_html(limitations: list[str]) -> str:
    """Say what the run could NOT establish, next to what it could.

    A report that shows only findings reads as complete. Naming the gaps is
    what keeps an inconclusive verdict from looking like a clean one.
    """
    if not limitations:
        return ""
    items = "".join(f"<li>{_esc(item)}</li>" for item in limitations)
    return (
        '<div class="limits"><strong>Not established:</strong>'
        f"<ul>{items}</ul></div>"
    )


def _issues_html(issues: list[dict]) -> str:
    if not issues:
        return '<div class="empty">no issues found</div>'
    rows = []
    for issue in issues:
        when = issue.get("timestamp")
        seek = f' seek" data-t="{float(when):.2f}"' if when is not None else '"'
        stamp = format_time(float(when)) if when is not None else "--:--"
        fix = issue.get("suggested_fix") or ""
        rows.append(
            f'<div class="issue{seek}>'
            f'<span class="sev {_esc(issue.get("severity"))}">{_esc(issue.get("severity"))}</span>'
            f'<span class="txt"><span class="ts">{stamp}</span> '
            f'{_esc(issue.get("description"))}'
            + (f'<span class="fix">fix: {_esc(fix)}</span>' if fix else "")
            + "</span></div>"
        )
    return "".join(rows)


def _frames_html(perception: dict, iteration: int) -> tuple[str, str]:
    """(timeline marks, frame cards) for one iteration's recording."""
    frames = (perception or {}).get("frames", [])[:_MAX_FRAMES_PER_ITER]
    duration = max((f.get("timestamp_seconds", 0.0) for f in frames), default=0.0) or 1.0
    marks, cards = [], []
    for i, frame in enumerate(frames):
        uri = _thumb_data_uri(frame.get("path", ""))
        if uri is None:
            continue
        when = float(frame.get("timestamp_seconds", 0.0))
        marks.append(
            f'<a class="tl-mark seek" style="left:{min(99.0, when / duration * 100):.1f}%" '
            f'href="#i{iteration}f{i}" data-t="{when:.2f}" title="{format_time(when)}"></a>'
        )
        cards.append(
            f'<div class="frame seek" id="i{iteration}f{i}" data-t="{when:.2f}">'
            f'<img src="{uri}" alt="iteration {iteration} at {format_time(when)}" loading="lazy">'
            f'<div class="cap"><b>{format_time(when)}</b></div></div>'
        )
    return "".join(marks), "".join(cards)


def _delta_html(previous: dict | None, current: dict) -> str:
    """What changed between two critiques, by description.

    Matching on the description rather than a stored diff keeps this readable
    against any iteration pair the reader picks, not only consecutive ones.
    """
    if previous is None:
        return ""
    before = {i["description"]: i for i in previous.get("issues", [])}
    after = {i["description"]: i for i in current.get("issues", [])}
    gone = [d for d in before if d not in after]
    new = [d for d in after if d not in before]
    kept = [d for d in after if d in before]

    def block(css: str, title: str, items: list[str]) -> str:
        body = (
            "<ul>" + "".join(f"<li>{_esc(d)}</li>" for d in items) + "</ul>"
            if items else '<div class="none">none</div>'
        )
        return f'<section class="{css}"><h3>{title} ({len(items)})</h3>{body}</section>'

    return (
        '<div class="delta">'
        + block("gone", "fixed", gone)
        + block("new", "introduced", new)
        + block("kept", "still there", kept)
        + "</div>"
    )


_JS = """
(function(){
  var iters = Array.prototype.slice.call(document.querySelectorAll('.iter'));
  if (!iters.length) return;
  document.body.classList.add('js');
  var panes = {};
  iters.forEach(function(el){ panes[el.dataset.i] = document.getElementById('pane-' + el.dataset.i); });

  function select(key){
    iters.forEach(function(el){ el.classList.toggle('on', el.dataset.i === key); });
    Object.keys(panes).forEach(function(k){ if (panes[k]) panes[k].hidden = k !== key; });
  }
  iters.forEach(function(el){ el.addEventListener('click', function(){ select(el.dataset.i); }); });

  // Land on the iteration that decided the run: the last one.
  select(iters[iters.length - 1].dataset.i);

  // Clicking an issue or a mark brings up the frame nearest that moment,
  // within the iteration being shown — the critic's timestamp is the whole
  // reason the recording was kept.
  document.addEventListener('click', function(ev){
    var seek = ev.target.closest ? ev.target.closest('.seek') : null;
    if (!seek) return;
    var t = parseFloat(seek.dataset.t || 'NaN');
    if (isNaN(t)) return;
    ev.preventDefault();
    var pane = seek.closest('[id^=pane-]') || document.querySelector('[id^=pane-]:not([hidden])');
    if (!pane) return;
    var frames = Array.prototype.slice.call(pane.querySelectorAll('.frame'));
    var best = null, gap = Infinity;
    frames.forEach(function(f){
      var d = Math.abs(parseFloat(f.dataset.t || '0') - t);
      if (d < gap) { gap = d; best = f; }
    });
    if (!best) return;
    frames.forEach(function(f){ f.classList.remove('on'); });
    best.classList.add('on');
    best.scrollIntoView({block: 'nearest', inline: 'center', behavior: 'smooth'});
  });
})();
"""


def render_loop_html(loop_id: str) -> tuple[str, str]:
    """The self-contained page for one loop run, as (loop_id, html)."""
    from watch_skill.loop.runner import LoopState

    state = LoopState.load(loop_id)
    if not state.iterations:
        raise LoopError(
            f"loop {loop_id} has no iterations yet",
            code="loop.empty",
            fix="run loop_iterate, or wait for the first capture to finish",
        )

    cards, panes = [], []
    for record in state.iterations:
        n = record.get("n", 0)
        critique = record.get("critique") or {}
        verdict = str(critique.get("verdict", "?")).lower()
        score = critique.get("score")
        # An inconclusive verdict gets its own colour. Painting it as a fail
        # would claim the critic found something; painting it as a pass is the
        # bug this whole verdict model exists to stop.
        cls = {"pass": "pass", "fail": "fail"}.get(verdict, "unknown")
        cards.append(
            f'<button class="iter" data-i="{n}">'
            f'<div class="n">iteration {n}</div>'
            f'<div class="v {cls}">{_esc(verdict)}</div>'
            f'<div class="s">score {_esc(score)}</div></button>'
        )

        previous = state.iterations[n - 1].get("critique") if n > 0 else None
        marks, frames = _frames_html(record.get("perception") or {}, n)
        panes.append(
            f'<div id="pane-{n}" hidden>'
            f'<div class="panel-hd"><span class="verdict {cls}">{_esc(verdict)}</span>'
            f'<span class="meta">{_esc(critique.get("assurance", "visual_advisory"))}'
            f' &middot; {_esc(critique.get("summary", ""))}</span></div>'
            f'{_limitations_html(critique.get("limitations") or [])}'
            f'{_delta_html(previous, critique)}'
            f'<div class="scrub">{marks}</div>'
            f'<div class="frames">{frames or "<div class=empty>no frames stored</div>"}</div>'
            f'<h2>Issues</h2>{_issues_html(critique.get("issues", []))}'
            "</div>"
        )

    passed = state.status == "passed"
    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>{_esc(state.loop_id)} — THE LOOP</title>
<style>{_CSS}{_LOOP_CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1 dir="auto">{_esc(state.target)}</h1>
  <div class="stats">
    <span class="stat">status <b>{_esc(state.status)}</b></span>
    <span class="stat">iterations <b>{len(state.iterations)}</b></span>
    <span class="stat">type <b>{_esc(state.loop_type)}</b></span>
    <span class="stat mono">{_esc(state.loop_id)}</span>
  </div>
</header>

<div class="panel" style="padding:10px 12px">
  <div class="meta"><b>Pass criteria:</b> <span dir="auto">{_esc(state.pass_criteria)}</span></div>
</div>

<div class="iters">{"".join(cards)}</div>
<div class="panel">{"".join(panes)}</div>

<footer>{"Verified with" if passed else "Recorded with"}
 <a href="https://github.com/oxbshw/watch-skill">Watch Skill</a> — capture,
 critique, fix, and prove. This page is self-contained and works offline.</footer>
</div>
<script>{_JS}</script>
</body>
</html>"""
    return state.loop_id, page


def generate_loop_viewer(loop_id: str, out_path: str | Path | None = None) -> Path:
    """Write the self-contained page for one loop run."""
    resolved, page = render_loop_html(loop_id)
    dest = Path(out_path) if out_path else Path.cwd() / f"watch-skill loop {resolved}.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(page, encoding="utf-8")
    return dest
